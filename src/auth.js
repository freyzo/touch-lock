import { execSync, execFileSync } from "child_process";
import { createInterface } from "readline";
import chalk from "chalk";

const KEYCHAIN_SERVICE = "tlock";
const KEYCHAIN_ACCOUNT = "master";

// ─── Keychain (macOS `security` CLI wrapper) ────────────────────────

/**
 * Store the master password in the macOS login keychain.
 */
export function setKeychainPassword(password) {
  try {
    // Delete any existing entry first (ignore errors if missing)
    try {
      execSync(
        `security delete-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}"`,
        { stdio: "ignore" }
      );
    } catch {
      // Entry didn't exist — that's fine
    }
    execSync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w "${password}"`,
      { stdio: "ignore" }
    );
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
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
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

/**
 * Attempt Touch ID authentication.
 * Returns: "success" | "failed" | "unavailable"
 */
export function authenticateWithTouchID() {
  try {
    execFileSync("swift", ["-e", TOUCHID_SWIFT_SOURCE], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 30000,
    });
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

  const password = await promptPassword("Create password: ");
  if (!password || password.length === 0) {
    throw new Error("Password cannot be empty.");
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
  console.log(chalk.green("✓ Master password saved to macOS Keychain.\n"));
}

// ─── Main authenticate flow ─────────────────────────────────────────

/**
 * Full authentication flow:
 *   1. Try Touch ID
 *   2. On failure or unavailability, fall back to password prompt
 *   3. Verify password against Keychain
 *
 * Throws on authentication failure.
 */
export async function authenticate() {
  console.log(chalk.dim("Authenticating..."));

  // Attempt biometric first
  const biometricResult = authenticateWithTouchID();

  if (biometricResult === "success") {
    console.log(chalk.green("✓ Authenticated via Touch ID."));
    return true;
  }

  if (biometricResult === "unavailable") {
    console.log(chalk.dim("Touch ID unavailable — falling back to password."));
  } else {
    console.log(chalk.dim("Touch ID failed — falling back to password."));
  }

  // Password fallback
  const storedPassword = getKeychainPassword();
  if (!storedPassword) {
    throw new Error("No master password found. Run tlock on a target first to set one up.");
  }

  const enteredPassword = await promptPassword("Enter master password: ");
  if (enteredPassword !== storedPassword) {
    throw new Error("Incorrect password.");
  }

  console.log(chalk.green("✓ Authenticated via password."));
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
