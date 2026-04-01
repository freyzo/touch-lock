import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TLOCK_DIR = join(homedir(), ".tlock");
const CONFIG_FILE = join(TLOCK_DIR, "config.json");

function ensureConfigDirectory() {
  if (!existsSync(TLOCK_DIR)) {
    mkdirSync(TLOCK_DIR, { recursive: true });
  }
}

function readConfig() {
  ensureConfigDirectory();
  if (!existsSync(CONFIG_FILE)) {
    return { entries: [] };
  }
  try {
    const rawContent = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(rawContent);
  } catch {
    return { entries: [] };
  }
}

function writeConfig(config) {
  ensureConfigDirectory();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
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
}

/**
 * Remove a lock entry by target path.
 * Returns the removed entry, or null if not found.
 */
export function removeEntry(targetPath) {
  const config = readConfig();
  const entryIndex = config.entries.findIndex((entry) => entry.target === targetPath);
  if (entryIndex === -1) {
    return null;
  }
  const [removedEntry] = config.entries.splice(entryIndex, 1);
  writeConfig(config);
  return removedEntry;
}

/**
 * Update fields on an existing entry (merge semantics).
 */
export function updateEntry(targetPath, updatedFields) {
  const config = readConfig();
  const entry = config.entries.find((entry) => entry.target === targetPath);
  if (!entry) {
    throw new Error(`No lock entry found for: ${targetPath}`);
  }
  Object.assign(entry, updatedFields);
  writeConfig(config);
  return entry;
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
