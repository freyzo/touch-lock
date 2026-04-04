import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TLOCK_DIR = join(homedir(), ".tlock");
const CONFIG_FILE = join(TLOCK_DIR, "config.json");
const LOCK_FILE = join(TLOCK_DIR, "config.lock");
const LOCK_STALE_MS = 10_000;

function acquireLock() {
  ensureConfigDirectory();
  const maxWait = 5_000;
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Check for stale lock
      try {
        const st = statSync(LOCK_FILE);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_FILE);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > maxWait) {
        throw new Error("Timed out waiting for config lock. Remove ~/.tlock/config.lock if stuck.");
      }
      // Busy-wait briefly
      const deadline = Date.now() + 50;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

function ensureConfigDirectory() {
  if (!existsSync(TLOCK_DIR)) {
    mkdirSync(TLOCK_DIR, { recursive: true });
  }
}

let _configCache = null;

function readConfig() {
  if (_configCache) return structuredClone(_configCache);
  ensureConfigDirectory();
  if (!existsSync(CONFIG_FILE)) {
    return { entries: [] };
  }
  try {
    const rawContent = readFileSync(CONFIG_FILE, "utf-8");
    _configCache = JSON.parse(rawContent);
    return structuredClone(_configCache);
  } catch {
    return { entries: [] };
  }
}

function writeConfig(config) {
  ensureConfigDirectory();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  _configCache = structuredClone(config);
}

/**
 * Returns all lock registry entries.
 * Each entry: { target, type, dmgPath?, originalPath, createdAt }
 */
export function getLockRegistry() {
  return readConfig().entries;
}

/**
 * Find a single entry by its original target path.
 */
export function getEntry(targetPath) {
  const entries = getLockRegistry();
  return entries.find((entry) => entry.target === targetPath) || null;
}

/**
 * Add a new lock entry to the registry.
 * @param {{ target: string, type: "folder"|"app", dmgPath?: string, originalPath: string }} entry
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
 * Update fields on an existing entry (merge semantics).
 */
export function updateEntry(targetPath, updatedFields) {
  acquireLock();
  try {
    const config = readConfig();
    const entry = config.entries.find((entry) => entry.target === targetPath);
    if (!entry) {
      throw new Error(`No lock entry found for: ${targetPath}`);
    }
    Object.assign(entry, updatedFields);
    writeConfig(config);
    return entry;
  } finally {
    releaseLock();
  }
}

/**
 * Path to the ~/.tlock directory (exposed for DMG storage).
 */
export const TLOCK_STORAGE_DIR = TLOCK_DIR;

export default {
  getLockRegistry,
  getEntry,
  addEntry,
  removeEntry,
  updateEntry,
  TLOCK_STORAGE_DIR,
};
