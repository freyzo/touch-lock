import { execFileSync } from "child_process";
import { createInterface } from "readline";
import { existsSync, readFileSync, appendFileSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { TLOCK_STORAGE_DIR, ensureStorageDir, getLockRegistry } from "./config.js";
import { BIN } from "./bins.js";
import {
  vaultExists,
  createVault,
  restoreVault,
  hasOrphanedKeys,
  openVaultWithSecureEnclave,
  openVaultWithPassphrase,
  refreshSecureEnclave,
  imageKeyPath,
  writeImageKey,
  readImageKey,
} from "./vault.js";

const AUTH_FAILURES_FILE = join(TLOCK_STORAGE_DIR, ".auth-failures");
const MAX_FAILURES = 5;
const COOLDOWN_WINDOW_MS = 60_000;
const MIN_PASSPHRASE_LENGTH = 12;

// ─── Legacy Keychain password (tlock 0.1.x) ─────────────────────────

const LEGACY_KEYCHAIN_ITEM = ["-s", "tlock", "-a", "master"];

/**
 * The old master password that encrypted pre-vault images, or null once migrated.
 */
export function getLegacyPassword() {
  try {
    return execFileSync(BIN.security, ["find-generic-password", ...LEGACY_KEYCHAIN_ITEM, "-w"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function deleteLegacyPassword() {
  try {
    execFileSync(BIN.security, ["delete-generic-password", ...LEGACY_KEYCHAIN_ITEM], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

function changeImagePassphrase(imagePath, oldPassphrase, newPassphrase) {
  try {
    execFileSync(BIN.hdiutil, ["chpass", "-oldstdinpass", "-newstdinpass", imagePath], {
      input: `${oldPassphrase}\0${newPassphrase}\0`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-key a legacy image to a random vault key. The .pending key file is never overwritten,
 * so a crash between chpass and rename cannot lose the new key.
 */
function migrateImage(imagePath, legacyPassword, vmk) {
  const keyPath = imageKeyPath(imagePath);
  const pendingPath = `${keyPath}.pending`;
  try {
    const newKey = existsSync(pendingPath) ? readImageKey(pendingPath, vmk) : writeImageKey(pendingPath, vmk);
    const rekeyed = changeImagePassphrase(imagePath, legacyPassword, newKey) ||
      changeImagePassphrase(imagePath, newKey, newKey);
    if (!rekeyed) return false;
    renameSync(pendingPath, keyPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move folders locked with the old Keychain password onto vault keys, then delete that password.
 */
function migrateLegacyLocks(vmk) {
  const legacyPassword = getLegacyPassword();
  if (legacyPassword === null) return;

  const legacyEntries = getLockRegistry().filter(
    (entry) => entry.type === "folder" && !existsSync(imageKeyPath(entry.dmgPath))
  );
  const stuck = [];
  for (const entry of legacyEntries) {
    if (!existsSync(entry.dmgPath) || !migrateImage(entry.dmgPath, legacyPassword, vmk)) {
      stuck.push(entry.target);
    }
  }
  if (stuck.length > 0) {
    console.log(chalk.yellow(
      `Could not re-key (image missing or busy): ${stuck.join(", ")}\n  The old password stays in Keychain until these are fixed or removed.`
    ));
    return;
  }
  deleteLegacyPassword();
  console.log(chalk.dim(legacyEntries.length > 0
    ? `Re-keyed ${legacyEntries.length} locked folder(s) and removed the old password from Keychain.`
    : "Removed the old tlock password from Keychain."));
}

// ─── Interactive password prompt ────────────────────────────────────

/**
 * Password prompt for runs without a terminal (e.g. an app launched from Finder).
 */
function promptPasswordDialog(message) {
  const label = message.replace(/:\s*$/, "");
  try {
    const answer = execFileSync(BIN.osascript, [
      "-e",
      `text returned of (display dialog "${label}" default answer "" with hidden answer with title "tlock" with icon caution)`,
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return answer.replace(/\n$/, "");
  } catch {
    throw new Error("Password entry cancelled.");
  }
}

/**
 * Prompt for a password with hidden input. Rejects if input ends without an answer (EOF, Ctrl-C, Ctrl-D).
 */
async function promptPassword(message = "Enter password: ") {
  if (!process.stdin.isTTY) return promptPasswordDialog(message);

  return new Promise((resolve, reject) => {
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Hide typed characters: only the prompt and newlines reach the output.
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === "string" && chunk !== message && chunk !== "\n") {
        return true;
      }
      return originalWrite(chunk, ...rest);
    };

    let answered = false;
    readlineInterface.on("close", () => {
      process.stdout.write = originalWrite;
      console.log();
      if (!answered) reject(new Error("Password entry cancelled."));
    });

    readlineInterface.question(message, (answer) => {
      answered = true;
      readlineInterface.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt the user to create the recovery passphrase (with confirmation).
 */
async function promptNewPassphrase() {
  console.log(chalk.cyan("First-time setup — create a recovery passphrase for tlock."));
  console.log(chalk.dim("Day to day, Touch ID or your Mac login password unlocks. The recovery passphrase is never stored."));
  console.log(chalk.dim("If you forget it and this Mac's Secure Enclave key is lost (new Mac, reinstall), locked folders cannot be recovered.\n"));

  const passphrase = await promptPassword("Create recovery passphrase: ");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Recovery passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }

  const confirmation = await promptPassword("Confirm recovery passphrase: ");
  if (passphrase !== confirmation) {
    throw new Error("Passphrases do not match.");
  }

  return passphrase;
}

// ─── First-run setup ────────────────────────────────────────────────

/**
 * Create the vault on first use, or rebuild a lost vault.json from existing key files.
 * Returns the vault key if it did either, else null.
 */
async function ensureVault() {
  if (vaultExists()) return null;

  let created;
  if (hasOrphanedKeys()) {
    console.log(chalk.yellow("tlock's vault.json is missing. Enter your recovery passphrase to rebuild it."));
    checkCooldown();
    created = restoreVault(await promptPassword("Recovery passphrase: "));
    if (!created) {
      recordFailure();
      throw new Error("That passphrase does not open any locked folder.");
    }
    clearFailures();
  } else {
    created = createVault(await promptNewPassphrase());
    console.log(chalk.green("Recovery passphrase set. It is not stored anywhere, so keep it safe."));
  }
  if (!created.secureEnclave) {
    console.log(chalk.yellow("Secure Enclave unavailable: tlock will ask for the recovery passphrase each time."));
  }
  console.log();
  return created.vmk;
}

// ─── Brute-force tracking ───────────────────────────────────────────

function getRecentFailures() {
  try {
    const now = Date.now();
    return readFileSync(AUTH_FAILURES_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((t) => now - t < COOLDOWN_WINDOW_MS);
  } catch {
    return [];
  }
}

function recordFailure() {
  ensureStorageDir();
  appendFileSync(AUTH_FAILURES_FILE, `${Date.now()}\n`, { mode: 0o600 });
}

function clearFailures() {
  try { unlinkSync(AUTH_FAILURES_FILE); } catch { /* none recorded */ }
}

function checkCooldown() {
  const failures = getRecentFailures();
  if (failures.length < MAX_FAILURES) return;
  const oldest = failures[failures.length - MAX_FAILURES];
  const remaining = Math.ceil((COOLDOWN_WINDOW_MS - (Date.now() - oldest)) / 1000);
  if (remaining > 0) {
    throw new Error(`Too many failed attempts. Try again in ${remaining}s.`);
  }
}

// ─── Main authenticate flow ─────────────────────────────────────────

const FALLBACK_MESSAGES = {
  "not-enrolled": "Touch ID is not set up for tlock on this Mac — use your recovery passphrase.",
  unavailable: "Secure Enclave unavailable — use your recovery passphrase.",
  denied: "Not authenticated — falling back to the recovery passphrase.",
  broken: "This Mac's Secure Enclave key no longer opens the vault (new Mac or reinstall?) — use your recovery passphrase.",
};

async function unlockVault(reason) {
  console.log(chalk.dim("Authenticating..."));
  const result = openVaultWithSecureEnclave(reason);
  if (result.vmk) {
    clearFailures();
    console.log(chalk.green("Authenticated."));
    return result.vmk;
  }
  console.log(chalk.dim(FALLBACK_MESSAGES[result.status]));

  checkCooldown();
  const vmk = openVaultWithPassphrase(await promptPassword("Recovery passphrase: "));
  if (!vmk) {
    recordFailure();
    const remaining = MAX_FAILURES - getRecentFailures().length;
    throw new Error(
      `Incorrect passphrase.${remaining > 0 ? ` ${remaining} attempt(s) remaining.` : " Locked temporarily."}`
    );
  }
  clearFailures();
  console.log(chalk.green("Authenticated via recovery passphrase."));

  if ((result.status === "broken" || result.status === "not-enrolled") && refreshSecureEnclave(vmk)) {
    console.log(chalk.dim("Touch ID / login password unlocking re-enabled for this Mac."));
  }
  return vmk;
}

/**
 * Touch ID or the Mac login password (enforced by the Secure Enclave), else the recovery passphrase.
 * Sets the vault up on first use and returns the vault key. Throws on failure.
 * reason completes the macOS prompt "tlock is trying to …".
 */
export async function authenticate(reason = "verify your identity") {
  const vmk = (await ensureVault()) || (await unlockVault(reason));
  migrateLegacyLocks(vmk);
  return vmk;
}
