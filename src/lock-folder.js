import { execFileSync, spawn } from "child_process";
import { existsSync, statSync, rmSync, mkdirSync, chmodSync, realpathSync, lstatSync } from "fs";
import { resolve, basename } from "path";
import { createHash } from "crypto";
import chalk from "chalk";
import ora from "ora";
import { addEntry, getEntry, removeEntry, TLOCK_STORAGE_DIR } from "./config.js";
import { authenticate, getKeychainPassword, ensureFirstRunSetup } from "./auth.js";
import { printKvBox } from "./tui.js";

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

function sanitizeVolumeName(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 27);
  return sanitized || "tlock-volume";
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
      "-volname", sanitizeVolumeName(basename(folderPath)),
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
    execFileSync("hdiutil", ["detach", mountPoint, "-force"], { stdio: "ignore" });
  } catch {
    throw new Error(`Failed to unmount volume at: ${mountPoint}`);
  }
}

/**
 * Eject if this path is a volume mount (no-op if not mounted).
 * Needed before a second `hdiutil attach` of the same DMG (e.g. after `unlock`).
 */
function detachIfMounted(mountPoint) {
  if (!existsSync(mountPoint)) return;
  try {
    execFileSync("hdiutil", ["detach", mountPoint, "-force"], { stdio: "ignore" });
  } catch {
    /* not a mount or already ejected */
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Lock a folder: create encrypted DMG, remove original, register in config.
 */
export async function lockFolder(folderPath) {
  const rawPath = resolve(folderPath);

  if (existsSync(rawPath) && lstatSync(rawPath).isSymbolicLink()) {
    const realTarget = realpathSync(rawPath);
    throw new Error(
      `Refusing to lock a symlink. "${rawPath}" points to "${realTarget}". Lock the real path instead.`
    );
  }

  const absolutePath = existsSync(rawPath) ? realpathSync(rawPath) : rawPath;
  validateFolderTarget(absolutePath);

  await ensureFirstRunSetup();
  await authenticate();

  const dmgPath = generateDmgPath(absolutePath);
  const password = getKeychainPassword();

  const spinner = ora({
    text: chalk.dim(`Encrypting ${basename(absolutePath)}...`),
    color: "yellow",
    spinner: "dots",
  }).start();

  try {
    await createEncryptedDmg(absolutePath, dmgPath, password);
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Encryption failed: ${err.message}`));
    throw err;
  }

  if (!existsSync(dmgPath)) {
    spinner.stop();
    console.error(chalk.red("DMG not found after creation — aborting to protect data."));
    throw new Error("DMG creation succeeded but file not found — aborting to protect data.");
  }
  chmodSync(dmgPath, 0o600);
  spinner.stop();
  console.log(chalk.green("  Encrypted volume created"));

  const rmSpinner = ora({ text: chalk.dim("Removing original folder..."), color: "yellow", spinner: "dots" }).start();
  rmSync(absolutePath, { recursive: true, force: true });
  rmSpinner.stop();
  console.log(chalk.dim("  Original folder removed"));

  addEntry({
    target: absolutePath,
    type: "folder",
    dmgPath,
    originalPath: absolutePath,
  });

  console.log();
  printKvBox(
    "LOCKED FOLDER",
    [
      [chalk.dim("Path"), chalk.green(absolutePath)],
      [chalk.dim("DMG"), chalk.dim(dmgPath)],
    ],
    { titleStyle: chalk.cyan }
  );
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
  const spinner = ora({ text: chalk.dim("Mounting encrypted volume..."), color: "yellow", spinner: "dots" }).start();
  try {
    await mountDmg(entry.dmgPath, absolutePath, password);
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Mount failed: ${err.message}`));
    throw err;
  }
  spinner.stop();
  console.log(chalk.green("  Volume mounted"));

  console.log();
  printKvBox(
    "UNLOCKED FOLDER",
    [[chalk.dim("Path"), chalk.green(absolutePath)]],
    { titleStyle: chalk.cyan }
  );
  console.log(
    chalk.dim(
      "  When done: eject this volume in Finder (or Disk Utility). Data stays in the encrypted .dmg — run `tlock unlock` again next time. To drop tlock and get a normal folder: `tlock remove <path>`."
    )
  );
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

  // Same DMG may already be mounted at absolutePath from a prior `unlock` — second attach fails with "Resource busy"
  detachIfMounted(absolutePath);

  mkdirSync(tempMountPoint, { recursive: true });
  if (!existsSync(absolutePath)) {
    mkdirSync(absolutePath, { recursive: true });
  }

  // Mount to a temp location
  const spinner = ora({ text: chalk.dim("Restoring contents..."), color: "yellow", spinner: "dots" }).start();
  try {
    await mountDmg(entry.dmgPath, tempMountPoint, password);
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Mount failed: ${err.message}`));
    throw err;
  }

  try {
    execFileSync("cp", ["-R", `${tempMountPoint}/`, absolutePath], { stdio: "ignore" });
    spinner.stop();
    console.log(chalk.green("  Contents restored"));
  } catch (err) {
    spinner.stop();
    console.error(chalk.red(`Restore failed: ${err.message}`));
    throw err;
  } finally {
    try { unmountDmg(tempMountPoint); } catch { /* best effort */ }
    rmSync(tempMountPoint, { recursive: true, force: true });
  }

  // Clean up DMG and registry
  rmSync(entry.dmgPath, { force: true });
  removeEntry(absolutePath);

  console.log();
  printKvBox(
    "RESTORED",
    [[chalk.dim("Path"), chalk.green(absolutePath)]],
    { titleStyle: chalk.cyan }
  );
}

export default { lockFolder, unlockFolder, removeFolder };
