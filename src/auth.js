import { execFileSync } from "child_process";
import { createInterface } from "readline";
import { createHash, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, chmodSync, unlinkSync, renameSync, readdirSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import { TLOCK_STORAGE_DIR, ensureStorageDir } from "./config.js";

const AUTH_FAILURES_FILE = join(TLOCK_STORAGE_DIR, ".auth-failures");
const MAX_FAILURES = 5;
const COOLDOWN_WINDOW_MS = 60_000;
const MIN_PASSWORD_LENGTH = 8;

const KEYCHAIN_SERVICE = "tlock";
const KEYCHAIN_ACCOUNT = "master";

// ─── Keychain (macOS `security` CLI wrapper) ────────────────────────

/**
 * Store the master password in the login keychain.
 * Sent to `security -i` on stdin (hex-encoded) so it never appears in any process's argv.
 */
function setKeychainPassword(password) {
  const hex = Buffer.from(password, "utf-8").toString("hex");
  try {
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -X ${hex}\n`,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (error) {
    throw new Error(`Failed to store password in Keychain: ${String(error.stderr || error.message).trim()}`);
  }
  const stored = getKeychainPassword();
  if (stored === null || !passwordsMatch(password, stored)) {
    throw new Error("Keychain did not return the password just stored. Check Keychain Access for a \"tlock\" item.");
  }
}

/**
 * Retrieve the master password from the login keychain, or null if none exists.
 */
export function getKeychainPassword() {
  try {
    const result = execFileSync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
    ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    // Existing images were encrypted with the trimmed value, so keep trimming.
    return result.trim();
  } catch {
    return null;
  }
}

function hasStoredPassword() {
  return getKeychainPassword() !== null;
}

// ─── Touch ID (Swift subprocess bridge) ─────────────────────────────

const TOUCHID_SWIFT_SOURCE = `
import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
    fputs("unavailable", stderr)
    exit(2)
}

let semaphore = DispatchSemaphore(value: 0)
var success = false

context.evaluatePolicy(
    .deviceOwnerAuthenticationWithBiometrics,
    localizedReason: "tlock needs to verify your identity"
) { result, _ in
    success = result
    semaphore.signal()
}

semaphore.wait()
exit(success ? 0 : 1)
`;

// Named by source hash so an upgraded tlock never runs a stale helper.
const HELPER_NAME_PATTERN = /^touchid-helper(-[0-9a-f]{12})?$/;
const TOUCHID_BINARY = join(
  TLOCK_STORAGE_DIR,
  `touchid-helper-${createHash("sha256").update(TOUCHID_SWIFT_SOURCE).digest("hex").slice(0, 12)}`
);

function ensureCompiledHelper() {
  if (existsSync(TOUCHID_BINARY)) return TOUCHID_BINARY;

  ensureStorageDir();
  const srcFile = `${TOUCHID_BINARY}.${process.pid}.swift`;
  const tempBinary = `${TOUCHID_BINARY}.${process.pid}.tmp`;
  writeFileSync(srcFile, TOUCHID_SWIFT_SOURCE, { mode: 0o600 });
  try {
    execFileSync("swiftc", [
      "-o", tempBinary,
      "-framework", "LocalAuthentication",
      srcFile,
    ], { stdio: "ignore" });
    chmodSync(tempBinary, 0o700);
    renameSync(tempBinary, TOUCHID_BINARY);
  } catch {
    try { unlinkSync(tempBinary); } catch { /* never created */ }
    return null;
  } finally {
    try { unlinkSync(srcFile); } catch { /* ignore */ }
  }
  removeOldHelpers();
  return TOUCHID_BINARY;
}

function removeOldHelpers() {
  for (const name of readdirSync(TLOCK_STORAGE_DIR)) {
    const helperPath = join(TLOCK_STORAGE_DIR, name);
    if (HELPER_NAME_PATTERN.test(name) && helperPath !== TOUCHID_BINARY) {
      try { unlinkSync(helperPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Attempt Touch ID authentication.
 * Returns: "success" | "failed" | "unavailable"
 */
function authenticateWithTouchID() {
  let binary = null;
  try { binary = ensureCompiledHelper(); } catch { /* fall back to the interpreter */ }

  try {
    if (binary) {
      execFileSync(binary, [], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30000,
      });
    } else {
      execFileSync("swift", ["-e", TOUCHID_SWIFT_SOURCE], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 30000,
      });
    }
    return "success";
  } catch (error) {
    if (error.status === 2) {
      return "unavailable";
    }
    return "failed";
  }
}

// ─── Interactive password prompt ────────────────────────────────────

/**
 * Password prompt for runs without a terminal (e.g. an app launched from Finder).
 */
function promptPasswordDialog(message) {
  const label = message.replace(/:\s*$/, "");
  try {
    const answer = execFileSync("osascript", [
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
 * Prompt the user to create a new master password (with confirmation).
 */
async function promptNewPassword() {
  console.log(chalk.cyan("First-time setup — create a master password for tlock."));
  console.log(chalk.dim("This is your fallback if Touch ID is unavailable.\n"));

  const password = await promptPassword("Create password: ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== password.trim()) {
    throw new Error("Password cannot start or end with a space.");
  }

  const confirmation = await promptPassword("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  return password;
}

// ─── First-run setup ────────────────────────────────────────────────

/**
 * Ensure a master password exists in the Keychain.
 * If not, prompt the user to create one.
 */
export async function ensureFirstRunSetup() {
  if (hasStoredPassword()) {
    return;
  }
  const password = await promptNewPassword();
  setKeychainPassword(password);
  console.log(chalk.green("Master password saved to macOS Keychain.\n"));
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

function safeEqual(a, b) {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

// `security -w` prints non-ASCII passwords as hex.
function passwordsMatch(entered, stored) {
  const candidate = entered.trim();
  return safeEqual(candidate, stored) ||
    safeEqual(Buffer.from(candidate, "utf-8").toString("hex"), stored.toLowerCase());
}

// ─── Main authenticate flow ─────────────────────────────────────────

/**
 * Touch ID first; if it fails or is unavailable, the master password
 * (rate-limited, timing-safe compare). Throws on failure.
 */
export async function authenticate() {
  console.log(chalk.dim("Authenticating..."));

  const biometricResult = authenticateWithTouchID();

  if (biometricResult === "success") {
    clearFailures();
    console.log(chalk.green("Authenticated via Touch ID."));
    return;
  }

  if (biometricResult === "unavailable") {
    console.log(chalk.dim("Touch ID unavailable — falling back to password."));
  } else {
    console.log(chalk.dim("Touch ID failed — falling back to password."));
  }

  checkCooldown();
  const storedPassword = getKeychainPassword();
  if (!storedPassword) {
    throw new Error("No master password found. Run tlock on a target first to set one up.");
  }

  const enteredPassword = await promptPassword("Enter master password: ");
  if (!passwordsMatch(enteredPassword, storedPassword)) {
    recordFailure();
    const remaining = MAX_FAILURES - getRecentFailures().length;
    throw new Error(
      `Incorrect password.${remaining > 0 ? ` ${remaining} attempt(s) remaining.` : " Account locked temporarily."}`
    );
  }

  clearFailures();
  console.log(chalk.green("Authenticated via password."));
}
