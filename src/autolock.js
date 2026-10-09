import { execFileSync, spawn } from "child_process";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { TLOCK_STORAGE_DIR, ensureStorageDir, getLockRegistry, getSettings } from "./config.js";
import { ejectFolder, isMountPoint } from "./lock-folder.js";
import { BIN } from "./bins.js";

const PID_FILE = join(TLOCK_STORAGE_DIR, "autolock.pid");
const WATCH_COMMAND = "autolock-watch";
const TICK_MS = 5_000;
// A tick this much later than scheduled means the Mac was asleep in between.
const SLEEP_GAP_MS = 30_000;
const TLOCK_SCRIPT = fileURLToPath(new URL("../bin/tlock.js", import.meta.url));
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * "90s", "30m", "2h", or a bare number of minutes, in milliseconds.
 */
export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)([smh]?)$/.exec(String(text).trim());
  if (!match || Number(match[1]) <= 0) {
    throw new Error(`Invalid duration "${text}". Use e.g. 90s, 30m, 2h.`);
  }
  return Math.round(Number(match[1]) * UNIT_MS[match[2] || "m"]);
}

function runText(binary, args, input) {
  return execFileSync(binary, args, {
    input,
    encoding: "utf-8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    timeout: 10_000,
  });
}

/** Time since the last keyboard, mouse or trackpad input. */
function idleMs() {
  try {
    const match = /"HIDIdleTime" = (\d+)/.exec(runText(BIN.ioreg, ["-c", "IOHIDSystem", "-d", "4"]));
    return match ? Number(match[1]) / 1e6 : 0;
  } catch {
    return 0;
  }
}

/** Screen locked, or another user switched in on the console. */
function isScreenLocked() {
  try {
    const plist = runText(BIN.ioreg, ["-n", "Root", "-d1", "-a"]);
    const users = JSON.parse(runText(BIN.plutil, ["-extract", "IOConsoleUsers", "json", "-o", "-", "-"], plist));
    const mine = users.find((user) => user.kCGSSessionUserIDKey === process.getuid());
    return !mine || !mine.kCGSSessionOnConsoleKey || mine.CGSSessionScreenIsLocked === true;
  } catch {
    return false;
  }
}

function notify(message) {
  try {
    execFileSync(BIN.osascript, [
      "-e",
      `display notification "${message.replace(/["\\]/g, "\\$&")}" with title "tlock"`,
    ], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // Notifications are best effort.
  }
}

function anyRuleEnabled(settings) {
  return settings.idleMinutes > 0 || settings.lockOnSleep || settings.lockOnScreenLock;
}

// ─── Watcher process ────────────────────────────────────────────────

function readPid() {
  try {
    return Number(readFileSync(PID_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function watcherRunning() {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return runText(BIN.ps, ["-p", String(pid), "-o", "command="]).includes(WATCH_COMMAND);
  } catch {
    return false;
  }
}

/**
 * Start the background watcher if any auto-lock rule applies and it is not already running.
 */
export function ensureWatcher({ hasTimer = false } = {}) {
  if (!hasTimer && !anyRuleEnabled(getSettings())) return;
  if (watcherRunning()) return;
  spawn(process.execPath, [...process.execArgv, TLOCK_SCRIPT, WATCH_COMMAND], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function claimPidFile() {
  if (watcherRunning()) return false;
  ensureStorageDir();
  rmSync(PID_FILE, { force: true });
  try {
    writeFileSync(PID_FILE, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function lockReason(settings, slept) {
  if (slept && settings.lockOnSleep) return "Mac slept";
  if (settings.lockOnScreenLock && isScreenLocked()) return "screen locked";
  if (settings.idleMinutes > 0 && idleMs() >= settings.idleMinutes * 60_000) {
    return `idle ${settings.idleMinutes} min`;
  }
  return null;
}

/**
 * Poll until no folder is unlocked: eject folders on sleep, screen lock, idle, or their --for timer.
 * Busy volumes are retried every tick; the user is notified once.
 */
export async function runWatcher() {
  if (!claimPidFile()) return;
  const releasePidFile = () => {
    if (readPid() === process.pid) rmSync(PID_FILE, { force: true });
  };
  process.on("SIGTERM", () => {
    releasePidFile();
    process.exit(0);
  });

  const warned = new Set();
  let lastTick = Date.now();
  try {
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      const now = Date.now();
      const slept = now - lastTick > TICK_MS + SLEEP_GAP_MS;
      lastTick = now;

      const settings = getSettings();
      const unlocked = getLockRegistry().filter((entry) => entry.type === "folder" && isMountPoint(entry.target));
      if (unlocked.length === 0) return;
      if (!anyRuleEnabled(settings) && !unlocked.some((entry) => entry.autoLockAt)) return;

      const sharedReason = lockReason(settings, slept);
      for (const entry of unlocked) {
        const reason = sharedReason || (entry.autoLockAt && now >= entry.autoLockAt ? "timer" : null);
        if (!reason) {
          warned.delete(entry.target);
          continue;
        }
        try {
          ejectFolder(entry);
          warned.delete(entry.target);
          notify(`Locked ${basename(entry.target)} (${reason}).`);
        } catch {
          if (!warned.has(entry.target)) {
            warned.add(entry.target);
            notify(`Could not lock ${basename(entry.target)}: files on it are in use. Retrying.`);
          }
        }
      }
    }
  } finally {
    releasePidFile();
  }
}
