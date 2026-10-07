import { execFileSync } from "child_process";
import { randomFillSync } from "crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { BIN } from "./bins.js";

const CHUNK_SIZE = 1024 * 1024;

/**
 * Overwrite a regular file in place with random bytes (like lok's wipe).
 * Best effort: APFS snapshots, clones and SSD wear-levelling can still hold old blocks.
 */
export function overwriteFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const { size, nlink } = fstatSync(fd);
    // Another hard link still needs these bytes.
    if (nlink > 1) return;
    const buffer = Buffer.alloc(Math.min(CHUNK_SIZE, size));
    for (let offset = 0; offset < size; offset += buffer.length) {
      const length = Math.min(buffer.length, size - offset);
      randomFillSync(buffer, 0, length);
      writeSync(fd, buffer, 0, length, offset);
    }
    fsyncSync(fd);
  } catch {
    // Unwritable or vanished: deletion still follows.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Overwrite then delete a single file.
 */
export function destroyFile(filePath) {
  overwriteFile(filePath);
  rmSync(filePath, { force: true });
}

/**
 * Overwrite every regular file under dirPath on the same volume, then delete the tree.
 */
export function wipeTree(dirPath) {
  const rootDevice = lstatSync(dirPath).dev;
  const walk = (current) => {
    let names;
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      const childPath = join(current, name);
      let stats;
      try { stats = lstatSync(childPath); } catch { continue; }
      if (stats.dev !== rootDevice) continue;
      if (stats.isDirectory()) walk(childPath);
      else if (stats.isFile()) overwriteFile(childPath);
    }
  };
  walk(dirPath);
  rmSync(dirPath, { recursive: true, force: true });
}

function runQuietly(binary, args) {
  try {
    execFileSync(binary, args, { stdio: "ignore", timeout: 15_000 });
  } catch {
    // Best effort.
  }
}

/**
 * Drop Quick Look thumbnails, which are cached outside the encrypted image.
 */
export function resetQuickLookCache() {
  runQuietly(BIN.qlmanage, ["-r", "cache"]);
}

/**
 * lok -s style cleanup: thumbnails, Recents, Finder recent folders and the parent's .DS_Store.
 */
export function flushMetadata(targetPath) {
  resetQuickLookCache();
  runQuietly(BIN.defaults, ["delete", "com.apple.recentitems"]);
  runQuietly(BIN.defaults, ["delete", "com.apple.finder", "FXRecentFolders"]);
  runQuietly(BIN.killall, ["-HUP", "cfprefsd"]);
  rmSync(join(dirname(targetPath), ".DS_Store"), { force: true });
}
