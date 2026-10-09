import { execFileSync, spawn } from "child_process";
import {
  existsSync,
  statSync,
  rmSync,
  rmdirSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  lstatSync,
  readdirSync,
} from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { createHash } from "crypto";
import chalk from "chalk";
import ora from "ora";
import {
  addEntry,
  getEntry,
  getLockRegistry,
  removeEntry,
  updateEntry,
  canonicalPath,
  ensureStorageDir,
  TLOCK_STORAGE_DIR,
} from "./config.js";
import { authenticate, getLegacyPassword } from "./auth.js";
import { imageKeyPath, writeImageKey, readImageKey } from "./vault.js";
import { wipeTree, destroyFile, resetQuickLookCache, flushMetadata } from "./shred.js";
import { BIN } from "./bins.js";
import { printResult, cmd, displayPath, shellPath } from "./tui.js";

// Sparse bundle: only used space is stored, in 8 MB bands that Time Machine backs up incrementally.
const IMAGE_MAX_SIZE = "1t";
const VOLUME_METADATA = new Set([
  ".fseventsd",
  ".Spotlight-V100",
  ".Trashes",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
]);
const STALE_MOUNT_DIR_MS = 60 * 60 * 1000;

/**
 * Deterministic image filename for a folder path.
 */
function generateImagePath(folderPath) {
  const hash = createHash("sha256").update(folderPath).digest("hex").slice(0, 12);
  return join(TLOCK_STORAGE_DIR, `${basename(folderPath)}-${hash}.sparsebundle`);
}

function isInside(child, parent) {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export function isMountPoint(targetPath) {
  try {
    return statSync(targetPath).dev !== statSync(dirname(targetPath)).dev;
  } catch {
    return false;
  }
}

/**
 * Validate that a new lock target is a plain directory that is safe to encrypt and then delete.
 */
function validateFolderTarget(folderPath) {
  if (!existsSync(folderPath)) {
    throw new Error(`Path does not exist: ${folderPath}`);
  }
  if (!statSync(folderPath).isDirectory()) {
    throw new Error(`Not a directory: ${folderPath}`);
  }
  const storageDir = canonicalPath(TLOCK_STORAGE_DIR);
  if (folderPath === storageDir || isInside(storageDir, folderPath) || isInside(folderPath, storageDir)) {
    throw new Error(`Refusing to lock ${folderPath}: it is or contains tlock's storage (${storageDir}).`);
  }
  if (isMountPoint(folderPath)) {
    throw new Error(`Refusing to lock ${folderPath}: it is a mounted volume. Lock a folder on it instead.`);
  }
  for (const entry of getLockRegistry()) {
    if (entry.type !== "folder") continue;
    if (isInside(entry.target, folderPath)) {
      throw new Error(`Refusing to lock ${folderPath}: it contains locked folder ${entry.target}. Remove that lock first.`);
    }
    if (isInside(folderPath, entry.target)) {
      throw new Error(`Refusing to lock ${folderPath}: it is inside locked folder ${entry.target}.`);
    }
  }
}

/**
 * Refuse when something new sits at a locked folder's path: mounting would hide it, restoring would overwrite it.
 * Only call while the folder's own volume is not mounted there.
 */
function assertPathFree(folderPath) {
  if (!existsSync(folderPath)) return;
  const inUse = !statSync(folderPath).isDirectory() ||
    readdirSync(folderPath).some((name) => name !== ".DS_Store");
  if (inUse) {
    throw new Error(
      `${displayPath(folderPath)} already exists and is not empty (made while the folder was locked)\n` +
        "Rename or move it aside, then retry."
    );
  }
}

function sanitizeVolumeName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 27);
  return sanitized || "tlock-volume";
}

/**
 * The image's own random key, or the old Keychain password for a lock not yet re-keyed.
 */
function imagePassphrase(entry, vmk) {
  const keyPath = imageKeyPath(entry.dmgPath);
  if (existsSync(keyPath)) return readImageKey(keyPath, vmk);
  const legacyPassword = getLegacyPassword();
  if (legacyPassword === null) {
    throw new Error(`Key file missing: ${keyPath}\n  Without it the image cannot be opened. If you moved it, put it back.`);
  }
  return legacyPassword;
}

function commandError(error) {
  return String(error.stderr || "").trim() || error.message;
}

/**
 * Run hdiutil with the password piped to stdin (-stdinpass).
 */
function runHdiutil(args, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hdiutilProcess = spawn(BIN.hdiutil, args, { stdio: ["pipe", "ignore", "pipe"] });

    let stderrOutput = "";
    hdiutilProcess.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    // hdiutil may exit before reading the password; its exit code reports why.
    hdiutilProcess.stdin.on("error", () => {});

    hdiutilProcess.on("error", (error) => {
      rejectPromise(new Error(`Failed to run hdiutil: ${error.message}`));
    });
    hdiutilProcess.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`hdiutil ${args[0]} failed (exit ${exitCode}): ${stderrOutput.trim()}`));
      }
    });

    hdiutilProcess.stdin.end(password);
  });
}

// -nobrowse keeps the volume off the Desktop and Finder sidebar; it is still reachable at its path.
function attachImage(imagePath, mountPoint, password, { readonly = false } = {}) {
  const args = ["attach", imagePath, "-stdinpass", "-mountpoint", mountPoint, "-nobrowse"];
  if (readonly) args.push("-readonly");
  return runHdiutil(args, password);
}

/**
 * Eject a mounted volume. Without force, refuses while files on it are in use.
 */
function detach(mountPoint, { force = false } = {}) {
  try {
    execFileSync(BIN.hdiutil, ["detach", mountPoint, ...(force ? ["-force"] : [])], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const hint = force ? "" : "\n  Close any files or apps using it, then retry.";
    throw new Error(`Could not eject ${mountPoint}: ${commandError(error)}${hint}`);
  }
}

// rmdir never deletes contents, so a still-mounted volume is left intact.
function removeEmptyDir(dirPath) {
  try { rmdirSync(dirPath); } catch { /* not empty, still mounted, or already gone */ }
}

/**
 * Fresh temp mount point under ~/.tlock; also clears empty ones left by interrupted runs.
 */
function makeTempMountDir() {
  ensureStorageDir();
  for (const name of readdirSync(TLOCK_STORAGE_DIR)) {
    if (!name.startsWith("mount-")) continue;
    const dirPath = join(TLOCK_STORAGE_DIR, name);
    try {
      if (Date.now() - statSync(dirPath).mtimeMs > STALE_MOUNT_DIR_MS) removeEmptyDir(dirPath);
    } catch { /* ignore */ }
  }
  return mkdtempSync(join(TLOCK_STORAGE_DIR, "mount-"));
}

function copyOutOfVolume(volumePath, destination) {
  for (const name of readdirSync(volumePath)) {
    if (VOLUME_METADATA.has(name)) continue;
    try {
      execFileSync(BIN.ditto, [join(volumePath, name), join(destination, name)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      throw new Error(`Copying ${name} failed: ${commandError(error)}`);
    }
  }
}

/**
 * Create an AES-256 encrypted, writable APFS sparse bundle and copy the folder into it.
 */
async function createEncryptedImage(folderPath, imagePath, password) {
  ensureStorageDir();
  await runHdiutil([
    "create",
    "-size", IMAGE_MAX_SIZE,
    "-type", "SPARSEBUNDLE",
    "-fs", "APFS",
    "-encryption", "AES-256",
    "-stdinpass",
    "-volname", sanitizeVolumeName(basename(folderPath)),
    imagePath,
  ], password);

  const mountPoint = makeTempMountDir();
  try {
    await attachImage(imagePath, mountPoint, password);
    let copyError = null;
    try {
      execFileSync(BIN.ditto, [folderPath, mountPoint], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      copyError = new Error(`Copying into the encrypted volume failed: ${commandError(error)}`);
    }
    try {
      detach(mountPoint, { force: true });
    } catch (error) {
      throw copyError || error;
    }
    if (copyError) throw copyError;
  } catch (error) {
    rmSync(imagePath, { recursive: true, force: true });
    throw error;
  } finally {
    removeEmptyDir(mountPoint);
  }
}

/**
 * Eject an unlocked folder's volume (refuses while files on it are in use) and clear its auto-lock timer.
 */
export function ejectFolder(entry) {
  detach(entry.target);
  removeEmptyDir(entry.target);
  if (entry.autoLockAt) updateEntry(entry.target, { autoLockAt: undefined });
}

/**
 * Eject every unlocked folder. Returns { locked: [paths], busy: [{ target, reason }] }.
 */
export function lockAllFolders() {
  const result = { locked: [], busy: [] };
  for (const entry of getLockRegistry()) {
    if (entry.type !== "folder" || !isMountPoint(entry.target)) continue;
    try {
      ejectFolder(entry);
      result.locked.push(entry.target);
    } catch (error) {
      result.busy.push({ target: entry.target, reason: error.message });
    }
  }
  return result;
}

/**
 * Put an unlocked folder away again by ejecting its volume.
 */
function relockFolder(entry) {
  if (!isMountPoint(entry.target)) {
    throw new Error(`Already locked: ${entry.target}\n  Open it with: tlock unlock ${entry.target}`);
  }
  ejectFolder(entry);

  printResult(`Locked ${displayPath(entry.target)}`);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock a folder: encrypt it into a sparse image, register it, then delete the original.
 * On a registered folder that is currently unlocked, eject it instead.
 */
export async function lockFolder(folderPath) {
  const rawPath = resolve(folderPath);

  if (existsSync(rawPath) && lstatSync(rawPath).isSymbolicLink()) {
    throw new Error(
      `Refusing to lock a symlink. "${rawPath}" points to "${canonicalPath(rawPath)}". Lock the real path instead.`
    );
  }

  const absolutePath = canonicalPath(rawPath);
  const existing = getEntry(absolutePath);
  if (existing) {
    relockFolder(existing);
    return;
  }

  validateFolderTarget(absolutePath);
  const imagePath = generateImagePath(absolutePath);
  if (existsSync(imagePath)) {
    throw new Error(
      `An encrypted image for this folder already exists: ${imagePath}\n  It may hold an earlier lock of this folder. Move it aside, then retry.`
    );
  }

  const vmk = await authenticate(`lock “${basename(absolutePath)}”`);
  const keyPath = imageKeyPath(imagePath);
  const password = writeImageKey(keyPath, vmk);

  const spinner = ora({
    text: chalk.dim(`Encrypting ${basename(absolutePath)}...`),
    color: "yellow",
    spinner: "dots",
  }).start();
  try {
    await createEncryptedImage(absolutePath, imagePath, password);
  } catch (error) {
    rmSync(keyPath, { force: true });
    throw error;
  } finally {
    spinner.stop();
  }
  chmodSync(imagePath, 0o700);

  // Register before deleting anything, so the data is never unreachable through tlock.
  try {
    addEntry({ target: absolutePath, type: "folder", dmgPath: imagePath });
  } catch (error) {
    rmSync(imagePath, { recursive: true, force: true });
    rmSync(keyPath, { force: true });
    throw error;
  }

  const rmSpinner = ora({ text: chalk.dim("Wiping original folder..."), color: "yellow", spinner: "dots" }).start();
  try {
    wipeTree(absolutePath);
  } catch (error) {
    throw new Error(
      `Your data is encrypted and registered, but the original folder could not be fully deleted (${error.message}). Delete what is left of ${absolutePath} by hand.`
    );
  } finally {
    rmSpinner.stop();
  }
  resetQuickLookCache();

  printResult(`Locked ${displayPath(absolutePath)}`);
}

/**
 * Unlock a folder: authenticate, then mount its image at the original path.
 * autoLockAt (epoch ms) sets a per-unlock timer for the auto-lock watcher.
 */
export async function unlockFolder(entry, { autoLockAt } = {}) {
  const absolutePath = entry.target;

  if (!existsSync(entry.dmgPath)) {
    throw new Error(`Encrypted image missing: ${entry.dmgPath}`);
  }
  if (isMountPoint(absolutePath)) {
    if (autoLockAt) updateEntry(absolutePath, { autoLockAt });
    printResult(`${displayPath(absolutePath)} is already open`);
    return;
  }
  assertPathFree(absolutePath);

  const vmk = await authenticate(`unlock “${basename(absolutePath)}”`);
  const password = imagePassphrase(entry, vmk);

  const spinner = ora({ text: chalk.dim("Mounting encrypted volume..."), color: "yellow", spinner: "dots" }).start();
  try {
    await attachImage(entry.dmgPath, absolutePath, password);
  } finally {
    spinner.stop();
  }
  updateEntry(absolutePath, { autoLockAt });

  printResult(`Opened ${displayPath(absolutePath)}`);
  if (entry.dmgPath.endsWith(".dmg")) {
    printResult("This lock was made by an older tlock and opens read-only", [
      `To make it writable: ${cmd(`tlock -r ${shellPath(absolutePath)}`)}, then ${cmd(`tlock ${shellPath(absolutePath)}`)}`,
    ], "warn");
  }
}

/**
 * Permanently remove a folder lock: copy contents back to the original path, delete the image, deregister.
 * With force, only forgets a lock whose image is missing.
 */
export async function removeFolder(entry, { force = false } = {}) {
  const absolutePath = entry.target;

  if (!existsSync(entry.dmgPath)) {
    if (!force) {
      throw new Error(
        `Encrypted image missing: ${entry.dmgPath}\n  If you moved it, put it back. To forget this lock anyway: tlock remove --force ${absolutePath}`
      );
    }
    removeEntry(absolutePath);
    rmSync(imageKeyPath(entry.dmgPath), { force: true });
    printResult(`Forgot the lock on ${displayPath(absolutePath)}`);
    return;
  }

  const wasOpen = isMountPoint(absolutePath);
  if (!wasOpen) assertPathFree(absolutePath);
  const vmk = await authenticate(`remove the lock on “${basename(absolutePath)}”`);
  const password = imagePassphrase(entry, vmk);

  // A volume left open by `tlock unlock` must be ejected before the image can be attached again.
  if (wasOpen) {
    detach(absolutePath);
    assertPathFree(absolutePath);
  }
  mkdirSync(absolutePath, { recursive: true });

  const mountPoint = makeTempMountDir();
  const spinner = ora({ text: chalk.dim("Restoring contents..."), color: "yellow", spinner: "dots" }).start();
  try {
    await attachImage(entry.dmgPath, mountPoint, password, { readonly: true });
    let copyError = null;
    try {
      copyOutOfVolume(mountPoint, absolutePath);
    } catch (error) {
      copyError = error;
    }
    try {
      detach(mountPoint, { force: true });
    } catch (error) {
      if (!copyError) throw error;
    }
    if (copyError) throw new Error(`Restore failed: ${copyError.message}`);
  } finally {
    spinner.stop();
    removeEmptyDir(mountPoint);
  }

  rmSync(entry.dmgPath, { recursive: true, force: true });
  destroyFile(imageKeyPath(entry.dmgPath));
  removeEntry(absolutePath);

  printResult(`Unlocked ${displayPath(absolutePath)}`);
}

/**
 * Destroy a folder lock for good (like lok -s): erase the image's keys, wipe the key file, delete the image.
 */
export async function shredFolder(entry) {
  const absolutePath = entry.target;
  await authenticate(`permanently destroy “${basename(absolutePath)}”`);

  if (isMountPoint(absolutePath)) detach(absolutePath);
  removeEmptyDir(absolutePath);

  if (existsSync(entry.dmgPath)) {
    try {
      execFileSync(BIN.hdiutil, ["erasekeys", entry.dmgPath], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      console.log(chalk.yellow(`  Could not erase the image's keys (${commandError(error)}); deleting it anyway.`));
    }
  }
  destroyFile(imageKeyPath(entry.dmgPath));
  rmSync(entry.dmgPath, { recursive: true, force: true });
  removeEntry(absolutePath);
  flushMetadata(absolutePath);

  printResult(`Destroyed ${displayPath(absolutePath)}`);
}
