import { execFileSync } from "child_process";
import {
  existsSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "fs";
import { resolve, basename, join, delimiter, sep } from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { addEntry, getEntry, removeEntry, canonicalPath } from "./config.js";
import { authenticate } from "./auth.js";
import { BIN } from "./bins.js";
import { printKvBox } from "./tui.js";

const ORIGINAL_BINARY_SUFFIX = ".tlock-original";
const WRAPPER_HEADER = "#!/bin/bash\n# tlock wrapper";
const TLOCK_SCRIPT = fileURLToPath(new URL("../bin/tlock.js", import.meta.url));

/**
 * Resolve an app name or .app path to a bundle path.
 * A .app path is used as given, falling back to /Applications/<basename>; a bare name maps to /Applications/<name>.app.
 */
function resolveAppPath(appNameOrPath) {
  if (appNameOrPath.endsWith(".app")) {
    const absolutePath = resolve(appNameOrPath);
    if (existsSync(absolutePath)) {
      return canonicalPath(absolutePath);
    }
    const applicationsPath = join("/Applications", basename(absolutePath));
    if (existsSync(applicationsPath)) {
      return canonicalPath(applicationsPath);
    }
    throw new Error(`App not found: ${appNameOrPath}`);
  }

  const applicationsPath = join("/Applications", `${appNameOrPath}.app`);
  if (existsSync(applicationsPath)) {
    return canonicalPath(applicationsPath);
  }

  throw new Error(
    `App not found: tried /Applications/${appNameOrPath}.app — provide a full path if the app is elsewhere.`
  );
}

function readPlistKey(plistPath, key) {
  try {
    return execFileSync(BIN.plutil, ["-extract", key, "raw", "-o", "-", plistPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the CFBundleExecutable from the app's Info.plist to find the real binary name.
 */
function getExecutableName(appPath) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) {
    throw new Error(`No Info.plist found at: ${plistPath}`);
  }

  // Safari Web Apps (PWAs) have no binary to lock
  if (readPlistKey(plistPath, "LSTemplateApplication") === "true") {
    throw new Error(
      `${appPath} is a Safari Web App (PWA) and has no executable.\n` +
      `  tlock only works with native .app bundles (e.g. GitHub.app, Brave Browser.app).`
    );
  }

  const executableName = readPlistKey(plistPath, "CFBundleExecutable");
  if (!executableName) {
    throw new Error(`Could not read CFBundleExecutable from ${plistPath}`);
  }
  // Comes from the app's own Info.plist, so it must name a file inside Contents/MacOS.
  if (executableName.includes("/") || executableName === "." || executableName === "..") {
    throw new Error(`Refusing unusual CFBundleExecutable "${executableName}" in ${plistPath}`);
  }
  return executableName;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Node path that survives upgrades: prefer a PATH entry (e.g. /opt/homebrew/bin/node) over the versioned execPath.
 */
function stableNodePath() {
  const realNode = realpathSync(process.execPath);
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, "node");
    try {
      if (realpathSync(candidate) === realNode) return candidate;
    } catch { /* not in this dir */ }
  }
  return process.execPath;
}

/**
 * Wrapper script that gates app launch behind `tlock auth-gate`.
 * Uses absolute node and tlock paths because apps launched from Finder get a minimal PATH.
 */
function buildWrapperScript(originalBinaryPath) {
  return [
    WRAPPER_HEADER + " — do not edit manually",
    `NODE_BIN=${shellQuote(stableNodePath())}`,
    `TLOCK_JS=${shellQuote(TLOCK_SCRIPT)}`,
    `ORIGINAL_BINARY=${shellQuote(originalBinaryPath)}`,
    "",
    `if [ ! -x "$NODE_BIN" ] || [ ! -f "$TLOCK_JS" ]; then`,
    `  ${BIN.osascript} -e 'display dialog "tlock could not start: Node.js or tlock has moved. Reinstall tlock, then run tlock on this app again to repair it." buttons {"OK"} default button "OK" with icon stop with title "tlock"'`,
    `  exit 1`,
    `fi`,
    `if "$NODE_BIN" "$TLOCK_JS" auth-gate; then`,
    `  exec "$ORIGINAL_BINARY" "$@"`,
    `fi`,
    `${BIN.osascript} -e 'display dialog "Authentication failed. The app is locked by tlock." buttons {"OK"} default button "OK" with icon stop with title "tlock"'`,
    `exit 1`,
    "",
  ].join("\n");
}

function isTlockWrapper(binaryPath) {
  let fd;
  try {
    fd = openSync(binaryPath, "r");
    const header = Buffer.alloc(WRAPPER_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    return header.toString("utf-8") === WRAPPER_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomically put a fresh wrapper at binaryPath. With moveOriginal, the real binary
 * is moved to renamedBinaryPath first and moved back if anything fails.
 */
function installWrapper(binaryPath, renamedBinaryPath, { moveOriginal }) {
  const tempPath = `${binaryPath}.tlock-tmp`;
  writeFileSync(tempPath, buildWrapperScript(renamedBinaryPath));
  chmodSync(tempPath, 0o755);
  try {
    if (moveOriginal) renameSync(binaryPath, renamedBinaryPath);
    try {
      renameSync(tempPath, binaryPath);
    } catch (error) {
      if (moveOriginal) renameSync(renamedBinaryPath, binaryPath);
      throw error;
    }
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function assertPersistentInstall() {
  if (TLOCK_SCRIPT.includes(`${sep}_npx${sep}`)) {
    throw new Error("App locking needs a global install (the npx cache is temporary): npm i -g @freyzo/tlock");
  }
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
}

function appBinaryPaths(appPath, executableName) {
  const binaryPath = join(appPath, "Contents", "MacOS", executableName);
  return { binaryPath, renamedBinaryPath: `${binaryPath}${ORIGINAL_BINARY_SUFFIX}` };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock an app: move its binary aside and install a wrapper that requires Touch ID or the password.
 * On an app that is already wrapped, refreshes the wrapper (e.g. after Node or tlock moved).
 */
export async function lockApp(appNameOrPath) {
  const appPath = resolveAppPath(appNameOrPath);
  validateAppTarget(appPath);
  assertPersistentInstall();

  const executableName = getExecutableName(appPath);
  const { binaryPath, renamedBinaryPath } = appBinaryPaths(appPath, executableName);
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found: ${binaryPath}`);
  }

  const existing = getEntry(appPath);

  if (isTlockWrapper(binaryPath)) {
    if (!existsSync(renamedBinaryPath)) {
      throw new Error(`${binaryPath} is a tlock wrapper but the original binary is missing. Reinstall the app.`);
    }
    installWrapper(binaryPath, renamedBinaryPath, { moveOriginal: false });
    if (!existing) addEntry({ target: appPath, type: "app", executableName });
    console.log();
    printKvBox("LOCKED APP", [
      [chalk.dim("App"), chalk.green(basename(appPath))],
      [chalk.dim("Note"), chalk.dim("Already locked — wrapper refreshed.")],
    ]);
    return;
  }

  if (existsSync(renamedBinaryPath)) {
    throw new Error(`Found a leftover ${renamedBinaryPath}. Move or delete it, then retry.`);
  }
  if (existing) {
    // An app update or reinstall replaced the wrapper: re-apply the lock.
    console.log(chalk.dim("Lock was lost (app updated?) — re-applying."));
    removeEntry(appPath);
  }

  await authenticate(`lock “${basename(appPath)}”`);

  addEntry({ target: appPath, type: "app", executableName });
  console.log(
    chalk.dim(`Renaming binary: ${executableName} -> ${executableName}${ORIGINAL_BINARY_SUFFIX}`)
  );
  try {
    installWrapper(binaryPath, renamedBinaryPath, { moveOriginal: true });
  } catch (error) {
    removeEntry(appPath);
    throw new Error(
      `Could not install the lock wrapper (${error.message}).\n  If access was denied, allow your terminal under System Settings > Privacy & Security > App Management.`
    );
  }

  console.log();
  printKvBox("LOCKED APP", [
    [chalk.dim("App"), chalk.green(basename(appPath))],
    [chalk.dim("Note"), chalk.dim("Touch ID or password required before launch.")],
  ]);
}

/**
 * Launch a locked app through LaunchServices; its wrapper asks for Touch ID or the password.
 */
export function unlockApp(entry) {
  const appPath = entry.target;
  if (!existsSync(appPath)) {
    throw new Error(`App not found: ${appPath}\n  To forget this lock: tlock remove ${appPath}`);
  }
  const { binaryPath } = appBinaryPaths(appPath, entry.executableName);
  if (!isTlockWrapper(binaryPath)) {
    console.log(chalk.yellow(
      `${basename(appPath)} is no longer locked (app updated?). Run \`tlock ${appPath}\` to lock it again.`
    ));
  }

  console.log();
  printKvBox("LAUNCH", [
    [chalk.dim("App"), chalk.green(basename(appPath))],
    [chalk.dim("Note"), chalk.dim("Authenticate in the tlock prompt.")],
  ]);
  execFileSync(BIN.open, ["-a", appPath], { stdio: "ignore" });
}

/**
 * Permanently remove an app lock: put the original binary back and deregister.
 * Locks with nothing left to restore (app deleted or updated) are just forgotten;
 * with force, also forgets a wrapped app whose original binary is missing.
 */
export async function removeApp(entry, { force = false } = {}) {
  const appPath = entry.target;
  const { binaryPath, renamedBinaryPath } = appBinaryPaths(appPath, entry.executableName);

  if (!existsSync(renamedBinaryPath)) {
    const wrapped = isTlockWrapper(binaryPath);
    if (wrapped && !force) {
      throw new Error(
        `Original binary missing: ${renamedBinaryPath}\n  Reinstall the app, or forget this lock with: tlock remove --force ${appPath}`
      );
    }
    removeEntry(appPath);
    console.log(chalk.dim(wrapped
      ? `Forgot the lock for ${basename(appPath)}. Reinstall the app to repair it.`
      : `Nothing to restore for ${basename(appPath)} (app removed or updated) — removed it from tlock.`));
    return;
  }

  await authenticate(`remove the lock on “${basename(appPath)}”`);

  console.log(chalk.dim("Restoring original binary..."));
  renameSync(renamedBinaryPath, binaryPath);
  chmodSync(binaryPath, 0o755);

  removeEntry(appPath);

  console.log();
  printKvBox("UNLOCKED APP", [[chalk.dim("App"), chalk.green(basename(appPath))]]);
}
