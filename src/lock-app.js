import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "fs";
import { resolve, basename, join } from "path";
import chalk from "chalk";
import { addEntry, getEntry, removeEntry } from "./config.js";
import { authenticate, ensureFirstRunSetup } from "./auth.js";

const ORIGINAL_BINARY_SUFFIX = ".tlock-original";

/**
 * Resolve a user-provided app name or path to a full .app bundle path.
 * Checks /Applications first, then treats input as an absolute path.
 */
function resolveAppPath(appNameOrPath) {
  // If it already ends with .app and exists, use it directly
  if (appNameOrPath.endsWith(".app")) {
    const absolutePath = resolve(appNameOrPath);
    if (existsSync(absolutePath)) {
      return absolutePath;
    }
    // Try /Applications
    const applicationsPath = join("/Applications", basename(absolutePath));
    if (existsSync(applicationsPath)) {
      return applicationsPath;
    }
    throw new Error(`App not found: ${appNameOrPath}`);
  }

  // Bare name — try /Applications/<Name>.app
  const applicationsPath = join("/Applications", `${appNameOrPath}.app`);
  if (existsSync(applicationsPath)) {
    return applicationsPath;
  }

  throw new Error(
    `App not found: tried /Applications/${appNameOrPath}.app — provide a full path if the app is elsewhere.`
  );
}

/**
 * Read the CFBundleExecutable from the app's Info.plist to find the real binary name.
 */
function getExecutableName(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    throw new Error(`No Info.plist found at: ${plistPath}`);
  }

  try {
    const executableName = execSync(
      `defaults read "${plistPath}" CFBundleExecutable`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    ).trim();

    if (!executableName) {
      throw new Error("CFBundleExecutable is empty");
    }
    return executableName;
  } catch (error) {
    throw new Error(`Could not read CFBundleExecutable from ${plistPath}: ${error.message}`);
  }
}

/**
 * Build the wrapper shell script that gates app launch behind tlock auth.
 */
function buildWrapperScript(originalBinaryPath) {
  const tlockBin = resolve(process.argv[1] || "tlock");

  return [
    "#!/bin/bash",
    `# tlock wrapper — do not edit manually`,
    `TLOCK_BIN="${tlockBin}"`,
    `ORIGINAL_BINARY="${originalBinaryPath}"`,
    "",
    `if "$TLOCK_BIN" --auth-gate; then`,
    `  exec "$ORIGINAL_BINARY" "$@"`,
    `else`,
    `  osascript -e 'display dialog "Authentication failed. The app is locked by tlock." buttons {"OK"} default button "OK" with icon stop with title "tlock"'`,
    `  exit 1`,
    `fi`,
  ].join("\n");
}

/**
 * Validate that the target is a lockable .app bundle.
 */
function validateAppTarget(appPath) {
  if (!existsSync(appPath)) {
    throw new Error(`App does not exist: ${appPath}`);
  }
  if (!appPath.endsWith(".app")) {
    throw new Error(`Not an app bundle: ${appPath}`);
  }

  // SIP check — /System/Applications is protected
  if (appPath.startsWith("/System/")) {
    throw new Error(
      "Cannot lock system apps in /System/Applications — SIP (System Integrity Protection) blocks modification."
    );
  }

  const existing = getEntry(appPath);
  if (existing) {
    throw new Error(`Already locked: ${appPath}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock an app: rename its binary, install a wrapper that requires biometric auth.
 */
export async function lockApp(appNameOrPath) {
  const appPath = resolveAppPath(appNameOrPath);
  validateAppTarget(appPath);

  await ensureFirstRunSetup();
  await authenticate();

  const executableName = getExecutableName(appPath);
  const macosDir = join(appPath, "Contents", "MacOS");
  const binaryPath = join(macosDir, executableName);
  const renamedBinaryPath = join(macosDir, `${executableName}${ORIGINAL_BINARY_SUFFIX}`);

  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  // Rename original binary
  console.log(chalk.dim(`Renaming binary: ${executableName} → ${executableName}${ORIGINAL_BINARY_SUFFIX}`));
  renameSync(binaryPath, renamedBinaryPath);

  // Install wrapper script at the original binary path
  const wrapperContent = buildWrapperScript(renamedBinaryPath);
  writeFileSync(binaryPath, wrapperContent, { mode: 0o755 });

  addEntry({
    target: appPath,
    type: "app",
    originalPath: appPath,
    executableName,
  });

  console.log(chalk.green(`✓ Locked: ${basename(appPath)}`));
  console.log(chalk.dim("  App will now require Touch ID / password before launching."));
}

/**
 * Unlock an app: authenticate, then launch the original binary once.
 * The lock remains in place for next launch.
 */
export async function unlockApp(appNameOrPath) {
  const appPath = resolveAppPath(appNameOrPath);
  const entry = getEntry(appPath);

  if (!entry || entry.type !== "app") {
    throw new Error(`No locked app found for: ${appPath}`);
  }

  await authenticate();

  // Launch the original binary directly
  const macosDir = join(appPath, "Contents", "MacOS");
  const renamedBinaryPath = join(macosDir, `${entry.executableName}${ORIGINAL_BINARY_SUFFIX}`);

  if (!existsSync(renamedBinaryPath)) {
    throw new Error(`Original binary missing: ${renamedBinaryPath}`);
  }

  console.log(chalk.green(`✓ Launching ${basename(appPath)}...`));
  execSync(`open -a "${appPath}"`, { stdio: "ignore" });
}

/**
 * Permanently remove app lock: restore original binary, delete wrapper, deregister.
 */
export async function removeApp(appNameOrPath) {
  const appPath = resolveAppPath(appNameOrPath);
  const entry = getEntry(appPath);

  if (!entry || entry.type !== "app") {
    throw new Error(`No locked app found for: ${appPath}`);
  }

  await authenticate();

  const macosDir = join(appPath, "Contents", "MacOS");
  const binaryPath = join(macosDir, entry.executableName);
  const renamedBinaryPath = join(macosDir, `${entry.executableName}${ORIGINAL_BINARY_SUFFIX}`);

  if (!existsSync(renamedBinaryPath)) {
    throw new Error(`Original binary missing: ${renamedBinaryPath} — manual restore may be needed.`);
  }

  // Remove wrapper, restore original
  console.log(chalk.dim("Restoring original binary..."));
  unlinkSync(binaryPath);
  renameSync(renamedBinaryPath, binaryPath);
  chmodSync(binaryPath, 0o755);

  removeEntry(appPath);

  console.log(chalk.green(`✓ Unlocked permanently: ${basename(appPath)}`));
}

export default { lockApp, unlockApp, removeApp };
