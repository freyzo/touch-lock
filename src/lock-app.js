import { execFileSync } from "child_process";
import { existsSync, readdirSync, renameSync, chmodSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { resolve, basename, join } from "path";
import { addEntry, getEntry, removeEntry, canonicalPath } from "./config.js";
import { authenticate } from "./auth.js";
import { BIN } from "./bins.js";
import { printResult } from "./tui.js";
import { appGateRunning, syncAppGate } from "./app-gate.js";

// Apps are locked by tlock's app gate (src/app-gate.js) and never modified.
// tlock 0.2.0 and earlier swapped the app's executable for a wrapper script; those locks can still be removed.
const LEGACY_SUFFIX = ".tlock-original";
const LEGACY_HEADER = "#!/bin/bash\n# tlock wrapper";

// Apps the Mac needs to stay usable; locking them could lock the user out.
const NEVER_LOCK = new Set([
  "com.apple.finder",
  "com.apple.dock",
  "com.apple.loginwindow",
  "com.apple.systemuiserver",
  "com.apple.systempreferences",
  "com.freyzo.tlock.gate",
]);

const APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  join(homedir(), "Applications"),
];

/** "Brave Browser" for /Applications/Brave Browser.app. */
function appName(appPath) {
  return basename(appPath, ".app");
}

/** Every installed app as { name, path }, from the usual app folders. */
export function installedApps() {
  const apps = [];
  for (const dir of APP_DIRS) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".app")) apps.push({ name: file.slice(0, -4), path: join(dir, file) });
      }
    } catch { /* folder missing */ }
  }
  return apps;
}

/**
 * An app path or name (any capitalization, with or without .app) as a bundle path, or null.
 */
export function findApp(appNameOrPath) {
  if (appNameOrPath.includes("/")) {
    const absolutePath = resolve(appNameOrPath);
    return absolutePath.endsWith(".app") && existsSync(absolutePath) ? canonicalPath(absolutePath) : null;
  }
  const wanted = appNameOrPath.replace(/\.app$/i, "").toLowerCase();
  const match = installedApps().find((app) => app.name.toLowerCase() === wanted);
  return match ? canonicalPath(match.path) : null;
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

function bundleId(appPath) {
  const id = readPlistKey(join(appPath, "Contents", "Info.plist"), "CFBundleIdentifier");
  if (!id) throw new Error(`Could not read the bundle identifier of ${appPath}`);
  return id;
}

function isRunning(id) {
  try {
    const out = execFileSync(BIN.osascript, ["-e", `application id "${id}" is running`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function isLegacyWrapper(binaryPath) {
  let fd;
  try {
    fd = openSync(binaryPath, "r");
    const header = Buffer.alloc(LEGACY_HEADER.length);
    readSync(fd, header, 0, header.length, 0);
    return header.toString("utf-8") === LEGACY_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function legacyPaths(entry) {
  const binaryPath = join(entry.target, "Contents", "MacOS", entry.executableName);
  return { binaryPath, originalPath: `${binaryPath}${LEGACY_SUFFIX}` };
}

/** Whether the lock is in force: the gate is running (or, for an old lock, the wrapper is still in place). */
export function isAppLocked(entry) {
  if (entry.bundleId) return appGateRunning();
  return isLegacyWrapper(legacyPaths(entry).binaryPath);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock an app: from its next launch, it is paused until Touch ID or the Mac password succeeds.
 */
export async function lockApp(appNameOrPath) {
  const appPath = findApp(appNameOrPath);
  if (!appPath) throw new Error(`App not found: ${appNameOrPath}`);
  const id = bundleId(appPath);
  if (NEVER_LOCK.has(id)) throw new Error(`${appName(appPath)} cannot be locked: the Mac needs it to stay usable`);

  const existing = getEntry(appPath);
  if (existing && !existing.bundleId) {
    throw new Error(
      `${appName(appPath)} has a lock from an older tlock that modified the app\n` +
        `Remove it first, then lock again: tlock -r "${appName(appPath)}"`
    );
  }
  if (existing) {
    syncAppGate();
    printResult(`${appName(appPath)} is already locked`);
    return;
  }

  await authenticate(`lock \u201C${appName(appPath)}\u201D`);
  addEntry({ target: appPath, type: "app", bundleId: id });
  try {
    syncAppGate();
  } catch (error) {
    removeEntry(appPath);
    throw error;
  }

  printResult(
    `Locked ${appName(appPath)}`,
    isRunning(id) ? ["It is open right now; Touch ID is asked the next time it starts."] : []
  );
}

/**
 * Open a locked app; the gate asks for Touch ID as it starts.
 */
export function unlockApp(entry) {
  if (!existsSync(entry.target)) {
    throw new Error(`App not found: ${entry.target}\nForget this lock with: tlock -r --force "${appName(entry.target)}"`);
  }
  printResult(`Opening ${appName(entry.target)}`);
  execFileSync(BIN.open, ["-a", entry.target], { stdio: "ignore" });
}

/**
 * Remove an app lock. Old wrapper locks get the app's real executable put back.
 */
export async function removeApp(entry, { force = false } = {}) {
  const appPath = entry.target;
  if (entry.bundleId) {
    await authenticate(`remove the lock on \u201C${appName(appPath)}\u201D`);
    removeEntry(appPath);
    syncAppGate();
    printResult(`Unlocked ${appName(appPath)}`);
    return;
  }

  const { binaryPath, originalPath } = legacyPaths(entry);
  if (!existsSync(originalPath)) {
    if (isLegacyWrapper(binaryPath) && !force) {
      throw new Error(
        `Original executable missing: ${originalPath}\nReinstall the app, or forget this lock with: tlock -r --force "${appName(appPath)}"`
      );
    }
    removeEntry(appPath);
    printResult(`Forgot the lock on ${appName(appPath)}`);
    return;
  }

  await authenticate(`remove the lock on \u201C${appName(appPath)}\u201D`);
  renameSync(originalPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  removeEntry(appPath);
  printResult(`Unlocked ${appName(appPath)}`);
}
