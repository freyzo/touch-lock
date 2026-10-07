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
  canonicalPath,
  ensureStorageDir,
  TLOCK_STORAGE_DIR,
} from "./config.js";
import { authenticate, getKeychainPassword, ensureFirstRunSetup } from "./auth.js";
import { printKvBox } from "./tui.js";

// Sparse image: only the space actually used is stored on disk.
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
  return join(TLOCK_STORAGE_DIR, `${basename(folderPath)}-${hash}.sparseimage`);
}

function isInside(child, parent) {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function isMountPoint(targetPath) {
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

function sanitizeVolumeName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 27);
  return sanitized || "tlock-volume";
}

function requirePassword() {
  const password = getKeychainPassword();
  if (!password) {
    throw new Error("Could not read the tlock master password from Keychain.");
  }
  return password;
}

function commandError(error) {
  return String(error.stderr || "").trim() || error.message;
}

/**
 * Run hdiutil with the password piped to stdin (-stdinpass).
 */
function runHdiutil(args, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hdiutilProcess = spawn("hdiutil", args, { stdio: ["pipe", "ignore", "pipe"] });

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

function attachImage(imagePath, mountPoint, password, { browse = false, readonly = false } = {}) {
  const args = ["attach", imagePath, "-stdinpass", "-mountpoint", mountPoint];
  if (!browse) args.push("-nobrowse");
  if (readonly) args.push("-readonly");
  return runHdiutil(args, password);
}

/**
 * Eject a mounted volume. Without force, refuses while files on it are in use.
 */
function detach(mountPoint, { force = false } = {}) {
  try {
    execFileSync("hdiutil", ["detach", mountPoint, ...(force ? ["-force"] : [])], {
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
      execFileSync("ditto", [join(volumePath, name), join(destination, name)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      throw new Error(`Copying ${name} failed: ${commandError(error)}`);
    }
  }
}

/**
 * Create an AES-256 encrypted, writable APFS sparse image and copy the folder into it.
 */
async function createEncryptedImage(folderPath, imagePath, password) {
  ensureStorageDir();
  await runHdiutil([
    "create",
    "-size", IMAGE_MAX_SIZE,
    "-type", "SPARSE",
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
      execFileSync("ditto", [folderPath, mountPoint], { stdio: ["ignore", "ignore", "pipe"] });
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
    rmSync(imagePath, { force: true });
    throw error;
  } finally {
    removeEmptyDir(mountPoint);
  }
}

/**
 * Put an unlocked folder away again by ejecting its volume.
 */
function relockFolder(entry) {
  if (!isMountPoint(entry.target)) {
    throw new Error(`Already locked: ${entry.target}\n  Open it with: tlock unlock ${entry.target}`);
  }
  detach(entry.target);
  removeEmptyDir(entry.target);

  console.log();
  printKvBox("LOCKED FOLDER", [
    [chalk.dim("Path"), chalk.green(entry.target)],
    [chalk.dim("Image"), chalk.dim(entry.dmgPath)],
  ]);
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

  await ensureFirstRunSetup();
  await authenticate();
  const password = requirePassword();

  const spinner = ora({
    text: chalk.dim(`Encrypting ${basename(absolutePath)}...`),
    color: "yellow",
    spinner: "dots",
  }).start();
  try {
    await createEncryptedImage(absolutePath, imagePath, password);
  } finally {
    spinner.stop();
  }
  chmodSync(imagePath, 0o600);
  console.log(chalk.green("  Encrypted volume created"));

  // Register before deleting anything, so the data is never unreachable through tlock.
  try {
    addEntry({ target: absolutePath, type: "folder", dmgPath: imagePath });
  } catch (error) {
    rmSync(imagePath, { force: true });
    throw error;
  }

  const rmSpinner = ora({ text: chalk.dim("Removing original folder..."), color: "yellow", spinner: "dots" }).start();
  try {
    rmSync(absolutePath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Your data is encrypted and registered, but the original folder could not be fully deleted (${error.message}). Delete what is left of ${absolutePath} by hand.`
    );
  } finally {
    rmSpinner.stop();
  }
  console.log(chalk.dim("  Original folder removed"));

  console.log();
  printKvBox("LOCKED FOLDER", [
    [chalk.dim("Path"), chalk.green(absolutePath)],
    [chalk.dim("Image"), chalk.dim(imagePath)],
  ]);
}

/**
 * Unlock a folder: authenticate, then mount its image at the original path.
 */
export async function unlockFolder(entry) {
  const absolutePath = entry.target;

  if (!existsSync(entry.dmgPath)) {
    throw new Error(`Encrypted image missing: ${entry.dmgPath}`);
  }
  if (isMountPoint(absolutePath)) {
    console.log(chalk.dim(`Already unlocked: ${absolutePath}`));
    return;
  }

  await authenticate();
  const password = requirePassword();

  const spinner = ora({ text: chalk.dim("Mounting encrypted volume..."), color: "yellow", spinner: "dots" }).start();
  try {
    await attachImage(entry.dmgPath, absolutePath, password, { browse: true });
  } finally {
    spinner.stop();
  }
  console.log(chalk.green("  Volume mounted"));

  console.log();
  printKvBox("UNLOCKED FOLDER", [[chalk.dim("Path"), chalk.green(absolutePath)]]);
  if (entry.dmgPath.endsWith(".dmg")) {
    console.log(chalk.yellow(
      `  This lock was made by an older tlock and opens read-only. To make it writable: tlock remove ${absolutePath}, then tlock ${absolutePath}.`
    ));
  }
  console.log(chalk.dim(
    `  When done, lock it again with \`tlock ${absolutePath}\` (or eject it in Finder). To get a normal folder back: \`tlock remove ${absolutePath}\`.`
  ));
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
    console.log(chalk.dim(`Forgot the lock for ${absolutePath}.`));
    return;
  }

  await authenticate();
  const password = requirePassword();

  // A volume left open by `tlock unlock` must be ejected before the image can be attached again.
  if (isMountPoint(absolutePath)) detach(absolutePath);
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
  console.log(chalk.green("  Contents restored"));

  rmSync(entry.dmgPath, { force: true });
  removeEntry(absolutePath);

  console.log();
  printKvBox("RESTORED", [[chalk.dim("Path"), chalk.green(absolutePath)]]);
}
