#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import figlet from "figlet";
import { platform } from "os";
import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, join, resolve } from "path";
import { lockFolder, unlockFolder, removeFolder, shredFolder, lockAllFolders, isMountPoint } from "../src/lock-folder.js";
import { lockApp, unlockApp, removeApp, isAppLocked } from "../src/lock-app.js";
import { authenticate } from "../src/auth.js";
import { getLockRegistry, getEntry, canonicalPath, getSettings, updateSettings } from "../src/config.js";
import { parseDuration, describeAutoLock, ensureWatcher, runWatcher } from "../src/autolock.js";
import {
  clockTime,
  printKvBox,
  printLockedTargets,
  printStatusSummary,
  printEntryStatus,
  renderTable,
  stripAnsi,
  terminalColumns,
} from "../src/tui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")).version;

// ─── Shared color helpers ────────────────────────────────────────────
const terra  = chalk.ansi256(166);
const blue   = chalk.ansi256(33);
const blueLt = chalk.ansi256(75);

// Blue gradient matching #176be8: dark navy → royal blue → sky blue
// xterm-256: 18=#000087  19=#0000af  26=#005fd7  27=#005fff  33=#0087ff  75=#5fafff
const BLUE_STOPS = [18, 19, 26, 27, 33, 33, 75];

// Red for O: #de2158 ≈ xterm 161 (#d7005f)
const redO = chalk.ansi256(161);

function gradientLine(str) {
  const chars = str.split("");
  const total = chars.length || 1;
  return chars.map((ch, i) => {
    const idx = BLUE_STOPS[Math.round((i / (total - 1 || 1)) * (BLUE_STOPS.length - 1))];
    return chalk.ansi256(idx)(ch);
  }).join("");
}

/** Big ASCII banner only for a bare `tlock` and --help/-h. */
function shouldShowBanner() {
  const argv = process.argv.slice(2);
  return argv.length === 0 || argv.includes("--help") || argv.includes("-h");
}

function printBanner() {
  try {
    const font = "ANSI Shadow";
    const rc   = (ch) => figlet.textSync(ch, { font }).split("\n").slice(0, -1);

    // Fingerprint whorl — 9 wide × 7 tall, matches ANSI Shadow O dimensions
    const fingerprintO = [
      " ╭─────╮ ",
      "╭╯╭───╮╰╮",
      "│╰╯╭─╮╰╯│",
      "│  ╰─╯  │",
      "╰╮╭───╮╭╯",
      " ╰╯   ╰╯ ",
      "         ",
    ];

    // Render each letter; O gets red fingerprint, rest get blue gradient
    const groups = [
      { lines: rc("t"), color: gradientLine },
      { lines: rc("l"), color: gradientLine },
      { lines: fingerprintO, color: redO },
      { lines: rc("c"), color: gradientLine },
      { lines: rc("k"), color: gradientLine },
    ];

    const height = Math.max(...groups.map((g) => g.lines.length));
    groups.forEach((g) => {
      const w = g.lines[0]?.length || 0;
      while (g.lines.length < height) g.lines.push(" ".repeat(w));
    });

    const artLines = Array.from({ length: height }, (_, i) =>
      groups.map(({ lines, color }) => color(lines[i] || "")).join("")
    );

    const rawWidth    = stripAnsi(artLines[0]).length;
    const subtitleRaw = `made by freyzo  v${VERSION}`;
    const width       = Math.max(rawWidth, subtitleRaw.length) + 2;
    const dash        = blue("─");

    // Figlet art is ~45 columns; skip it rather than wrap and look broken.
    if (width + 4 > terminalColumns()) {
      console.log(`\n  tlock  ${blue("v" + VERSION)}\n`);
      return;
    }

    console.log("");
    console.log("  " + blue("┌") + dash.repeat(width) + blue("┐"));
    for (const line of artLines) {
      console.log("     " + line);
    }
    console.log("     " + chalk.dim("made by freyzo  ") + blue(`v${VERSION}`));
    console.log("  " + blue("└") + dash.repeat(width) + blue("┘"));
    console.log("");
  } catch {
    // The banner is decorative; never let a figlet error block the CLI.
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function enforceMaxOSPlatform() {
  if (platform() !== "darwin") {
    console.error(chalk.red("tlock requires macOS to run."));
    process.exit(1);
  }
}

/**
 * Find the registry entry for a user-supplied target: a path (symlinks resolved),
 * an app name in /Applications, or, for a bare name only, a unique basename match.
 */
function findEntryForTarget(target, command) {
  const exact = getEntry(canonicalPath(target)) || getEntry(`/Applications/${target}.app`);
  if (exact) return exact;
  if (target.includes("/")) return null;

  const matches = getLockRegistry().filter((e) => basename(e.target) === target);
  if (matches.length > 1) {
    throw new Error(
      `Multiple locks named "${target}". Use the full path:\n  ${matches.map((e) => `tlock ${command} ${e.target}`).join("\n  ")}`
    );
  }
  if (matches.length === 1) {
    console.log(chalk.dim(`Using lock: ${matches[0].target}`));
    return matches[0];
  }
  return null;
}

/**
 * Detect whether a lock target is a folder or an app bundle.
 * Returns "folder" | "app" | "unknown".
 */
function detectTargetType(target) {
  const registered = getEntry(canonicalPath(target));
  if (registered) return registered.type;
  if (target.endsWith(".app")) return "app";

  const absolutePath = resolve(target);
  const isFolder = existsSync(absolutePath) && statSync(absolutePath).isDirectory();
  const isApp = !target.includes("/") && existsSync(`/Applications/${target}.app`);
  if (isFolder && isApp) {
    throw new Error(
      `"${target}" matches both ./${target} and /Applications/${target}.app. Use ./${target} for the folder or ${target}.app for the app.`
    );
  }
  if (isApp) return "app";
  if (isFolder) return "folder";
  return "unknown";
}

async function runUnlock(target, forDuration) {
  const entry = findEntryForTarget(target, "unlock");
  if (!entry) {
    throw new Error(`No lock found for: ${target}`);
  }
  if (entry.type !== "folder") {
    if (forDuration) throw new Error("--for only applies to folders.");
    unlockApp(entry);
    return;
  }
  const autoLockAt = forDuration ? Date.now() + parseDuration(forDuration) : undefined;
  await unlockFolder(entry, { autoLockAt });
  ensureWatcher({ hasTimer: Boolean(autoLockAt) });
  console.log(chalk.dim(`  ${describeAutoLock(getSettings(), autoLockAt)} Change with \`tlock autolock\`.`));
}

function runLockAll() {
  const { locked, busy } = lockAllFolders();
  if (locked.length === 0 && busy.length === 0) {
    console.log(chalk.dim("No unlocked folders."));
    return;
  }
  for (const target of locked) console.log(chalk.green(`  Locked ${target}`));
  for (const { target } of busy) {
    console.log(chalk.yellow(`  In use, not locked: ${target} — close its files and run tlock --all again.`));
  }
  if (busy.length > 0) process.exitCode = 1;
}

function parseOnOff(value, flag) {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${flag} takes on or off.`);
}

function runAutolock(options) {
  const patch = {};
  if (options.idle !== undefined) {
    patch.idleMinutes = options.idle === "off" ? 0 : parseDuration(options.idle) / 60_000;
  }
  if (options.sleep !== undefined) patch.lockOnSleep = parseOnOff(options.sleep, "--sleep");
  if (options.screenLock !== undefined) patch.lockOnScreenLock = parseOnOff(options.screenLock, "--screen-lock");
  if (Object.keys(patch).length > 0) {
    updateSettings(patch);
    ensureWatcher();
  }

  const settings = getSettings();
  const onOff = (value) => (value ? chalk.green("on") : chalk.dim("off"));
  console.log();
  printKvBox("AUTO-LOCK", [
    [chalk.dim("Screen lock"), onOff(settings.lockOnScreenLock)],
    [chalk.dim("Sleep"), onOff(settings.lockOnSleep)],
    [chalk.dim("Idle"), settings.idleMinutes > 0 ? chalk.green(`${settings.idleMinutes} min`) : chalk.dim("off")],
  ]);
  console.log(chalk.dim("  Applies to unlocked folders. Per unlock: tlock unlock <folder> --for 30m"));
}

async function runRemove(target, { force = false } = {}) {
  const entry = findEntryForTarget(target, "remove");
  if (!entry) {
    throw new Error(`No lock found for: ${target}`);
  }
  if (entry.type === "folder") {
    await removeFolder(entry, { force });
  } else {
    await removeApp(entry, { force });
  }
}

async function runShred(target) {
  const entry = findEntryForTarget(target, "shred");
  if (!entry) {
    throw new Error(`No lock found for: ${target}. shred only destroys folders locked by tlock.`);
  }
  if (entry.type !== "folder") {
    throw new Error(`shred works on locked folders only. To unlock an app for good: tlock remove ${entry.target}`);
  }
  await shredFolder(entry);
}

/**
 * Wrap an async action with consistent error handling.
 */
function withErrorHandling(asyncAction) {
  return async (...args) => {
    try {
      await asyncAction(...args);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error.message}`));
      process.exit(1);
    }
  };
}

/**
 * Compact local timestamp, e.g. 2026-10-07 14:05.
 */
function formatDate(isoString) {
  const date = new Date(isoString);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function lockState(entry) {
  if (entry.type === "app") {
    return isAppLocked(entry) ? { label: "locked", tone: "ok" } : { label: "lock lost", tone: "bad" };
  }
  if (!isMountPoint(entry.target)) return { label: "locked", tone: "ok" };
  return { label: entry.autoLockAt ? `open until ${clockTime(entry.autoLockAt)}` : "open", tone: "warn" };
}

const QUICK_REFERENCE = [
  ["Lock a folder or app", 'tlock <folder>   tlock "App Name"'],
  ["Open a locked folder", "tlock -u <folder>"],
  ["Open it for a while", "tlock -u <folder> --for 30m"],
  ["Lock it again", "tlock <folder>"],
  ["Lock everything now", "tlock --all"],
  ["Auto-lock rules", "tlock autolock --idle 15m"],
  ["See your locks", "tlock list"],
  ["Restore normal folder/app", "tlock -r <target>"],
  ["Destroy a folder for good", "tlock -s <folder>"],
];

function quickReference() {
  const columns = [
    { header: "Task", min: 16 },
    { header: "Command", min: 28 },
  ];
  const rows = QUICK_REFERENCE.map(([task, command]) => [{ text: task }, { text: command, style: blueLt }]);
  return `\n${renderTable(blue("QUICK REFERENCE"), columns, rows)}\n`;
}

// ─── CLI ────────────────────────────────────────────────────────────

const program = new Command();

program.configureHelp({
  styleTitle:           (s) => blue(s),
  styleCommandText:     (s) => blueLt(s),
  styleOptionText:      (s) => blueLt(s),
  styleArgumentText:    (s) => terra(s),
  styleSubcommandText:  (s) => blueLt(s),
  styleDescriptionText: (s) => chalk.dim(s),
  styleOptionTerm:      (s) => blueLt(s),
});

program
  .name("tlock")
  .description(chalk.dim("Lock folders and apps with Touch ID on macOS"))
  .version(VERSION)
  .option("-u, --unlock <target>", "Unlock a locked folder/app")
  .option("--for <duration>", "With --unlock: lock the folder again after this long (e.g. 30m, 2h)")
  .option("-a, --all", "Lock every unlocked folder now")
  .option("-r, --remove <target>", "Permanently remove lock and restore target")
  .option("-s, --shred <target>", "Destroy a locked folder for good (no restore)")
  .addHelpText("after", quickReference);

// Default command: lock a target
program
  .argument("[target]", "folder path or app name to lock (run again on an unlocked folder to lock it)")
  .action(
    withErrorHandling(async (target) => {
      const options = program.opts();
      if ([options.unlock, options.remove, options.shred, options.all].filter(Boolean).length > 1) {
        throw new Error("Use only one of --unlock/-u, --remove/-r, --shred/-s, --all/-a.");
      }
      if (options.for && !options.unlock) {
        throw new Error("--for goes with --unlock, e.g. tlock -u <folder> --for 30m");
      }
      if (options.all) {
        if (target) throw new Error("--all takes no target.");
        runLockAll();
        return;
      }
      if (options.unlock) {
        await runUnlock(options.unlock, options.for);
        return;
      }
      if (options.remove) {
        await runRemove(options.remove);
        return;
      }
      if (options.shred) {
        await runShred(options.shred);
        return;
      }

      if (!target) {
        program.help();
        return;
      }

      const targetType = detectTargetType(target);
      if (targetType === "app") {
        await lockApp(target);
      } else if (targetType === "folder") {
        await lockFolder(target);
      } else {
        throw new Error(
          `Cannot determine target type for "${target}". Provide a valid folder path or .app name.`
        );
      }
    })
  );

// unlock
program
  .command("unlock <target>")
  .description("Unlock a locked folder, or launch a locked app")
  .option("--for <duration>", "Lock the folder again after this long (e.g. 30m, 2h)")
  .action(withErrorHandling((target, options) => runUnlock(target, options.for ?? program.opts().for)));

// list
program
  .command("list")
  .description("List all locked targets")
  .action(
    withErrorHandling(async () => {
      const entries = getLockRegistry();
      if (entries.length === 0) {
        console.log("\n  " + chalk.dim("No locked targets.") + "\n");
        return;
      }
      printLockedTargets(entries, formatDate, lockState);
    })
  );

// remove
program
  .command("remove <target>")
  .description("Permanently remove lock and restore target")
  .option("-f, --force", "Forget the lock even when there is nothing to restore (image or app binary missing)")
  .action(withErrorHandling((target, options) => runRemove(target, options)));

// shred
program
  .command("shred <target>")
  .description("Destroy a locked folder for good: erase its keys and delete the image (no restore)")
  .action(withErrorHandling((target) => runShred(target)));

// autolock
program
  .command("autolock")
  .description("Show or change when unlocked folders lock themselves")
  .option("--idle <duration>", "Lock after this long without keyboard/mouse input (e.g. 15m), or off")
  .option("--sleep <on|off>", "Lock when the Mac sleeps")
  .option("--screen-lock <on|off>", "Lock when the screen locks or another user switches in")
  .action(withErrorHandling(async (options) => runAutolock(options)));

// status
program
  .command("status [target]")
  .description("Show lock status of a target (exit code 1 if not locked) or all targets")
  .action(
    withErrorHandling(async (target) => {
      if (!target) {
        const entries = getLockRegistry();
        const folders = entries.filter((e) => e.type === "folder");
        const apps    = entries.filter((e) => e.type === "app");

        printStatusSummary(folders.length, apps.length, entries.length);
        return;
      }
      const entry = findEntryForTarget(target, "status");
      if (!entry) {
        console.log(chalk.dim(`Not locked: ${target}`));
        process.exitCode = 1;
        return;
      }
      console.log();
      printEntryStatus(entry, formatDate);
      console.log();
    })
  );

// Hidden background watcher started by `tlock unlock`
program
  .command("autolock-watch", { hidden: true })
  .action(() => runWatcher());

// Hidden subcommand used by the app-lock wrapper script
program
  .command("auth-gate", { hidden: true })
  .action(async () => {
    // Fail closed: only the explicit success below may exit 0.
    process.exitCode = 1;
    try {
      await authenticate("open a locked app");
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });

// ─── Run ────────────────────────────────────────────────────────────

enforceMaxOSPlatform();
if (shouldShowBanner()) printBanner();
await program.parseAsync();
