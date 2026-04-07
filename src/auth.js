import { execFileSync } from "child_process";
import { createInterface } from "readline";
import { timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import chalk from "chalk";

const TLOCK_DIR = join(homedir(), ".tlock");
const AUTH_FAILURES_FILE = join(TLOCK_DIR, ".auth-failures");
const MAX_FAILURES = 5;
const COOLDOWN_WINDOW_MS = 60_000;
const COOLDOWN_PENALTY_MS = 30_000;

const KEYCHAIN_SERVICE = "tlock";
const KEYCHAIN_ACCOUNT = "master";

// ─── Keychain (macOS `security` CLI wrapper) ────────────────────────

/**
 * Store the master password in the macOS login keychain.
 */
export function setKeychainPassword(password) {
  try {
    try {
      execFileSync("security", [
        "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT,
      ], { stdio: "ignore" });
    } catch {
      // Entry didn't exist
    }
    execFileSync("security", [
      "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", password,
    ], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`Failed to store password in Keychain: ${error.message}`);
  }
}

/**
 * Retrieve the master password from the macOS login keychain.
 * Returns null if no entry exists.
 */
export function getKeychainPassword() {
  try {
    const result = execFileSync("security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Returns true if a master password is already stored in the Keychain.
 */
export function hasStoredPassword() {
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

const TOUCHID_BINARY = join(TLOCK_DIR, "touchid-helper");

function ensureCompiledHelper() {
  if (existsSync(TOUCHID_BINARY)) return TOUCHID_BINARY;

  mkdirSync(TLOCK_DIR, { recursive: true });
  const srcFile = join(TLOCK_DIR, "touchid-helper.swift");
  writeFileSync(srcFile, TOUCHID_SWIFT_SOURCE, { mode: 0o600 });
  try {
    execFileSync("swiftc", [
      "-o", TOUCHID_BINARY,
      "-framework", "LocalAuthentication",
      srcFile,
    ], { stdio: "ignore" });
    chmodSync(TOUCHID_BINARY, 0o700);
  } catch {
    return null;
  } finally {
    try { unlinkSync(srcFile); } catch { /* ignore */ }
  }
  return TOUCHID_BINARY;
}

/**
 * Attempt Touch ID authentication.
 * Returns: "success" | "failed" | "unavailable"
 */
export function authenticateWithTouchID() {
  let binary = null;
  try { binary = ensureCompiledHelper(); } catch { /* fall through */ }

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
 * Prompt the user to type a password (hidden input).
 */
export function promptPassword(message = "Enter password: ") {
  return new Promise((resolve) => {
    const readlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Mute output to hide typed characters
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      if (typeof chunk === "string" && chunk !== message && chunk !== "\n") {
        return true;
      }
      return originalWrite(chunk);
    };

    readlineInterface.question(message, (answer) => {
      process.stdout.write = originalWrite;
      console.log(); // newline after hidden input
      readlineInterface.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt the user to create a new master password (with confirmation).
 */
export async function promptNewPassword() {
  console.log(chalk.cyan("First-time setup — create a master password for tlock."));
  console.log(chalk.dim("This is your fallback if Touch ID is unavailable.\n"));

  const MIN_PASSWORD_LENGTH = 8;
  const password = await promptPassword("Create password: ");
  if (!password || password.length === 0) {
    throw new Error("Password cannot be empty.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
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
    if (!existsSync(AUTH_FAILURES_FILE)) return [];
    const raw = readFileSync(AUTH_FAILURES_FILE, "utf-8").trim();
    if (!raw) return [];
    const now = Date.now();
    return raw.split("\n").map(Number).filter((t) => now - t < COOLDOWN_WINDOW_MS);
  } catch {
    return [];
  }
}

function recordFailure() {
  mkdirSync(TLOCK_DIR, { recursive: true });
  const failures = getRecentFailures();
  failures.push(Date.now());
  writeFileSync(AUTH_FAILURES_FILE, failures.join("\n"), { mode: 0o600 });
}

function clearFailures() {
  try {
    writeFileSync(AUTH_FAILURES_FILE, "", { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function checkCooldown() {
  const failures = getRecentFailures();
  if (failures.length >= MAX_FAILURES) {
    const oldest = failures[failures.length - MAX_FAILURES];
    const elapsed = Date.now() - oldest;
    const remaining = Math.ceil((COOLDOWN_PENALTY_MS - (elapsed - COOLDOWN_WINDOW_MS + COOLDOWN_PENALTY_MS)) / 1000);
    if (remaining > 0) {
      throw new Error(`Too many failed attempts. Try again in ${remaining}s.`);
    }
  }
}

function passwordsMatch(entered, stored) {
  const a = Buffer.from(entered);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Main authenticate flow ─────────────────────────────────────────

/**
 * Full authentication flow:
 *   1. Check cooldown from brute-force protection
 *   2. Try Touch ID
 *   3. On failure/unavailability, fall back to password prompt with timing-safe compare
 *   4. Track failed attempts, clear on success
 */
export async function authenticate() {
  checkCooldown();
  console.log(chalk.dim("Authenticating..."));

  const biometricResult = authenticateWithTouchID();

  if (biometricResult === "success") {
    clearFailures();
    console.log(chalk.green("Authenticated via Touch ID."));
    return true;
  }

  if (biometricResult === "unavailable") {
    console.log(chalk.dim("Touch ID unavailable — falling back to password."));
  } else {
    console.log(chalk.dim("Touch ID failed — falling back to password."));
  }

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
  return true;
}

export default {
  setKeychainPassword,
  getKeychainPassword,
  hasStoredPassword,
  authenticateWithTouchID,
  promptPassword,
  promptNewPassword,
  ensureFirstRunSetup,
  authenticate,
};
