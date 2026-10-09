import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  renameSync,
  chmodSync,
  realpathSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";

const TLOCK_DIR = join(homedir(), ".tlock");
const CONFIG_FILE = join(TLOCK_DIR, "config.json");
const LOCK_FILE = join(TLOCK_DIR, "config.lock");
const LOCK_STALE_MS = 5_000;
const LOCK_MAX_WAIT_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

const DEFAULT_SETTINGS = { idleMinutes: 15, lockOnSleep: true, lockOnScreenLock: true };

/**
 * Create ~/.tlock (owner-only) if needed.
 */
export function ensureStorageDir() {
  mkdirSync(TLOCK_DIR, { recursive: true, mode: 0o700 });
  chmodSync(TLOCK_DIR, 0o700);
}

/**
 * Absolute path with symlinks resolved. For a missing leaf (e.g. a locked folder), resolves its parent.
 */
export function canonicalPath(targetPath) {
  const absolutePath = resolve(targetPath);
  try {
    return realpathSync(absolutePath);
  } catch {
    try {
      return join(realpathSync(dirname(absolutePath)), basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

function acquireLock() {
  ensureStorageDir();
  const start = Date.now();
  while (true) {
    try {
      closeSync(openSync(LOCK_FILE, "wx"));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(LOCK_FILE);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() - start > LOCK_MAX_WAIT_MS) {
      throw new Error(`Timed out waiting for config lock. Remove ${LOCK_FILE} if stuck.`);
    }
    Atomics.wait(sleepCell, 0, 0, 50);
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// Read fresh every time: another tlock process may have changed the file.
function readConfig() {
  if (!existsSync(CONFIG_FILE)) {
    return { entries: [] };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch (err) {
    throw new Error(`Cannot read ${CONFIG_FILE} (${err.message}). Fix it or move it aside; tlock will not overwrite it.`);
  }
  if (!config || !Array.isArray(config.entries)) {
    throw new Error(`${CONFIG_FILE} has no "entries" list. Fix it or move it aside; tlock will not overwrite it.`);
  }
  return config;
}

function writeConfig(config) {
  ensureStorageDir();
  const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tempFile, CONFIG_FILE);
}

/**
 * Returns all lock registry entries.
 * Each entry: { target, type: "folder"|"app", dmgPath? (folder image), executableName? (app), autoLockAt? (epoch ms), createdAt }
 */
export function getLockRegistry() {
  return readConfig().entries;
}

/**
 * Find a single entry by its original target path.
 */
export function getEntry(targetPath) {
  const entries = getLockRegistry();
  // macOS paths ignore case by default, so ~/taxes finds the lock on ~/Taxes.
  const wanted = targetPath.toLowerCase();
  return (
    entries.find((entry) => entry.target === targetPath) ||
    entries.find((entry) => entry.target.toLowerCase() === wanted) ||
    null
  );
}

/**
 * Add a new lock entry to the registry.
 * @param {{ target: string, type: "folder"|"app", dmgPath?: string, executableName?: string }} entry
 */
export function addEntry(entry) {
  acquireLock();
  try {
    const config = readConfig();
    const alreadyExists = config.entries.some((existing) => existing.target === entry.target);
    if (alreadyExists) {
      throw new Error(`Target already locked: ${entry.target}`);
    }
    config.entries.push({
      ...entry,
      createdAt: new Date().toISOString(),
    });
    writeConfig(config);
  } finally {
    releaseLock();
  }
}

/**
 * Remove a lock entry by target path.
 * Returns the removed entry, or null if not found.
 */
export function removeEntry(targetPath) {
  acquireLock();
  try {
    const config = readConfig();
    const entryIndex = config.entries.findIndex((entry) => entry.target === targetPath);
    if (entryIndex === -1) {
      return null;
    }
    const [removedEntry] = config.entries.splice(entryIndex, 1);
    writeConfig(config);
    return removedEntry;
  } finally {
    releaseLock();
  }
}

/**
 * Merge fields into an existing entry (undefined values are dropped on write).
 */
export function updateEntry(targetPath, patch) {
  acquireLock();
  try {
    const config = readConfig();
    const entry = config.entries.find((existing) => existing.target === targetPath);
    if (!entry) return;
    Object.assign(entry, patch);
    writeConfig(config);
  } finally {
    releaseLock();
  }
}

/**
 * Auto-lock settings: { idleMinutes (0 = off), lockOnSleep, lockOnScreenLock }.
 */
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readConfig().settings };
}

export function updateSettings(patch) {
  acquireLock();
  try {
    const config = readConfig();
    config.settings = { ...config.settings, ...patch };
    writeConfig(config);
  } finally {
    releaseLock();
  }
}

/**
 * Path to the ~/.tlock directory (encrypted images, helper, registry).
 */
export const TLOCK_STORAGE_DIR = TLOCK_DIR;
