import { execSync, spawn } from "child_process";
import { existsSync, statSync, rmSync } from "fs";
import { resolve, basename } from "path";
import { createHash } from "crypto";
import chalk from "chalk";
import { addEntry, getEntry, removeEntry, TLOCK_STORAGE_DIR } from "./config.js";
import { authenticate, getKeychainPassword, ensureFirstRunSetup } from "./auth.js";

/**
 * Generate a deterministic DMG filename from the folder path.
 */
function generateDmgPath(folderPath) {
  const hash = createHash("sha256").update(folderPath).digest("hex").slice(0, 12);
  const name = basename(folderPath);
  return resolve(TLOCK_STORAGE_DIR, `${name}-${hash}.dmg`);
}

/**
 * Validate that the target is a real, lockable directory.
 */
function validateFolderTarget(folderPath) {
  if (!existsSync(folderPath)) {
    throw new Error(`Path does not exist: ${folderPath}`);
  }
  const stats = statSync(folderPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${folderPath}`);
  }
  const existing = getEntry(folderPath);
  if (existing) {
    throw new Error(`Already locked: ${folderPath}`);
  }
}

/**
 * Create an AES-256 encrypted DMG from a folder.
 * Pipes the master password into hdiutil via stdin.
 */
function createEncryptedDmg(folderPath, dmgPath, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hdiutilProcess = spawn("hdiutil", [
      "create",
      "-encryption", "AES-256",
      "-stdinpass",
      "-volname", basename(folderPath),
      "-srcfolder", folderPath,
      "-ov",
      "-format", "UDZO",
      dmgPath,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderrOutput = "";

    hdiutilProcess.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    // Pipe password into stdin
    hdiutilProcess.stdin.write(password);
    hdiutilProcess.stdin.end();

    hdiutilProcess.on("close", (exitCode) => {
      if (exitCode !== 0) {
        rejectPromise(new Error(`hdiutil create failed (exit ${exitCode}): ${stderrOutput}`));
      } else {
        resolvePromise();
      }
    });

    hdiutilProcess.on("error", (error) => {
      rejectPromise(new Error(`Failed to spawn hdiutil: ${error.message}`));
    });
  });
}

/**
 * Mount an encrypted DMG at the original folder path.
 * Pipes password via stdin.
 */
function mountDmg(dmgPath, mountPoint, password) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hdiutilProcess = spawn("hdiutil", [
      "attach",
      dmgPath,
      "-stdinpass",
      "-mountpoint", mountPoint,
      "-nobrowse",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stderrOutput = "";

    hdiutilProcess.stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });

    hdiutilProcess.stdin.write(password);
    hdiutilProcess.stdin.end();

    hdiutilProcess.on("close", (exitCode) => {
      if (exitCode !== 0) {
        rejectPromise(new Error(`hdiutil attach failed (exit ${exitCode}): ${stderrOutput}`));
      } else {
        resolvePromise();
      }
    });

    hdiutilProcess.on("error", (error) => {
      rejectPromise(new Error(`Failed to spawn hdiutil: ${error.message}`));
    });
  });
}

/**
 * Unmount (eject) a mounted DMG volume.
 */
function unmountDmg(mountPoint) {
  try {
    execSync(`hdiutil detach "${mountPoint}" -force`, { stdio: "ignore" });
  } catch {
    throw new Error(`Failed to unmount volume at: ${mountPoint}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock a folder: create encrypted DMG, remove original, register in config.
 */
export async function lockFolder(folderPath) {
  const absolutePath = resolve(folderPath);
  validateFolderTarget(absolutePath);

  await ensureFirstRunSetup();

  const dmgPath = generateDmgPath(absolutePath);
  const password = getKeychainPassword();

  console.log(chalk.dim(`Creating encrypted volume for ${basename(absolutePath)}...`));
  await createEncryptedDmg(absolutePath, dmgPath, password);

  // Verify DMG was created before deleting original
  if (!existsSync(dmgPath)) {
    throw new Error("DMG creation succeeded but file not found — aborting to protect data.");
  }

  console.log(chalk.dim("Removing original folder..."));
  rmSync(absolutePath, { recursive: true, force: true });

  addEntry({
    target: absolutePath,
    type: "folder",
    dmgPath,
    originalPath: absolutePath,
  });

  console.log(chalk.green(`✓ Locked: ${absolutePath}`));
  console.log(chalk.dim(`  DMG stored at: ${dmgPath}`));
}

/**
 * Unlock a folder: authenticate, then mount the DMG at the original path.
 */
export async function unlockFolder(folderPath) {
  const absolutePath = resolve(folderPath);
  const entry = getEntry(absolutePath);

  if (!entry || entry.type !== "folder") {
    throw new Error(`No locked folder found for: ${absolutePath}`);
  }

  if (!existsSync(entry.dmgPath)) {
    throw new Error(`DMG file missing: ${entry.dmgPath}`);
  }

  await authenticate();

  const password = getKeychainPassword();
  console.log(chalk.dim(`Mounting encrypted volume at ${absolutePath}...`));
  await mountDmg(entry.dmgPath, absolutePath, password);

  console.log(chalk.green(`✓ Unlocked: ${absolutePath}`));
  console.log(chalk.dim("  Eject the volume or run `tlock lock` again to re-lock."));
}

/**
 * Permanently remove a folder lock: mount, copy contents out, delete DMG, deregister.
 */
export async function removeFolder(folderPath) {
  const absolutePath = resolve(folderPath);
  const entry = getEntry(absolutePath);

  if (!entry || entry.type !== "folder") {
    throw new Error(`No locked folder found for: ${absolutePath}`);
  }

  if (!existsSync(entry.dmgPath)) {
    throw new Error(`DMG file missing: ${entry.dmgPath}`);
  }

  await authenticate();

  const password = getKeychainPassword();
  const tempMountPoint = resolve(TLOCK_STORAGE_DIR, `mount-${Date.now()}`);

  // Mount to a temp location
  console.log(chalk.dim("Mounting encrypted volume to restore contents..."));
  await mountDmg(entry.dmgPath, tempMountPoint, password);

  try {
    // Copy contents back to original path
    execSync(`cp -R "${tempMountPoint}/" "${absolutePath}"`, { stdio: "ignore" });
  } finally {
    // Always unmount temp, even if copy fails
    unmountDmg(tempMountPoint);
  }

  // Clean up DMG and registry
  rmSync(entry.dmgPath, { force: true });
  removeEntry(absolutePath);

  console.log(chalk.green(`✓ Permanently restored: ${absolutePath}`));
}

export default { lockFolder, unlockFolder, removeFolder };
