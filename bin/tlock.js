#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { platform } from "os";
import { readFileSync, readdirSync, existsSync, statSync, renameSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { basename, dirname, join, resolve } from "path";
import { lockFolder, unlockFolder, removeFolder, shredFolder, lockAllFolders, isMountPoint } from "../src/lock-folder.js";
import { unlockApp, removeApp, isAppLocked } from "../src/lock-app.js";
import { authenticate, replaceVault } from "../src/auth.js";
import {
  getLockRegistry,
  getEntry,
  removeEntry,
  canonicalPath,
  getSettings,
  updateSettings,
  TLOCK_STORAGE_DIR,
} from "../src/config.js";
import { parseDuration, ensureWatcher, runWatcher } from "../src/autolock.js";
import {
  clockTime,
  printKv,
  printResult,
  displayPath,
  formatError,
  renderHelp,
  cmd,
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
  return argv.length === 0 || (argv.length === 1 && ["-h", "--help"].includes(argv[0]));
}

// Letters from the figlet "ANSI Shadow" font, built in so the banner needs no dependency.
const ANSI_SHADOW = {
  t: [
    "████████╗",
    "╚══██╔══╝",
    "   ██║   ",
    "   ██║   ",
    "   ██║   ",
    "   ╚═╝   ",
  ],
  l: [
    "██╗     ",
    "██║     ",
    "██║     ",
    "██║     ",
    "███████╗",
    "╚══════╝",
  ],
  c: [
    " ██████╗",
    "██╔════╝",
    "██║     ",
    "██║     ",
    "╚██████╗",
    " ╚═════╝",
  ],
  k: [
    "██╗  ██╗",
    "██║ ██╔╝",
    "█████╔╝ ",
    "██╔═██╗ ",
    "██║  ██╗",
    "╚═╝  ╚═╝",
  ],
};

function printBanner() {
  try {
    const rc = (ch) => [...ANSI_SHADOW[ch]];

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

    // Banner art is ~45 columns; skip it rather than wrap and look broken.
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
    // The banner is decorative; never let it block the CLI.
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

  const matches = getLockRegistry().filter(
    (e) => basename(e.target).toLowerCase() === target.toLowerCase() ||
      basename(e.target, ".app").toLowerCase() === target.toLowerCase()
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple locks named "${target}". Use the full path:\n  ${matches.map((e) => `tlock ${command} ${e.target}`).join("\n  ")}`
    );
  }
  if (matches.length === 1) {
    console.log(chalk.dim(`  Using ${matches[0].target}`));
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
  const isApp = !target.includes("/") && installedApps().some((name) => name.toLowerCase() === target.toLowerCase());
  if (isFolder && isApp) {
    throw new Error(
      `"${target}" matches both ./${target} and /Applications/${target}.app. Use ./${target} for the folder or ${target}.app for the app.`
    );
  }
  if (isApp) return "app";
  if (isFolder) return "folder";
  return "unknown";
}

/** Quote an argument for display if it has spaces; keep ~ outside the quotes so it still expands. */
function shellArg(text) {
  if (!/[\s'"()&;$]/.test(text)) return text;
  return text.startsWith("~/") ? `~/"${text.slice(2)}"` : `"${text}"`;
}

/** Names of apps in /Applications, without ".app". */
function installedApps() {
  try {
    return readdirSync("/Applications").filter((name) => name.endsWith(".app")).map((name) => name.slice(0, -4));
  } catch {
    return [];
  }
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** The folder (next to target) or app whose name is closest to a mistyped target, or null. */
function closestName(target) {
  const wanted = basename(target).toLowerCase();
  let folders = [];
  try {
    const parent = dirname(resolve(target));
    folders = readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => (target.includes("/") ? join(dirname(target), entry.name) : entry.name));
  } catch { /* parent missing */ }
  const candidates = target.includes("/") ? folders : [...folders, ...installedApps()];
  const prefixed = candidates.filter((candidate) => basename(candidate).toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  let best = null;
  let bestDistance = Math.max(2, Math.floor(wanted.length / 4)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, basename(candidate).toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function runList() {
  const entries = getLockRegistry();
  if (entries.length === 0) {
    console.log(`\n  ${chalk.dim("Nothing is locked.")}`);
    return;
  }
  printLockedTargets(entries, formatDate, lockState);
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
}

function runLockAll() {
  const { locked, busy } = lockAllFolders();
  if (locked.length === 0 && busy.length === 0) {
    printResult("Nothing to lock");
    return;
  }
  for (const target of locked) printResult(`Locked ${displayPath(target)}`);
  for (const { target } of busy) {
    printResult(`${target} is in use, not locked`, [`Close its files, then run ${cmd("tlock --all")} again.`], "warn");
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
  printKv("Auto-lock", [
    [chalk.dim("Screen lock"), onOff(settings.lockOnScreenLock)],
    [chalk.dim("Sleep"), onOff(settings.lockOnSleep)],
    [chalk.dim("Idle"), settings.idleMinutes > 0 ? chalk.green(`${settings.idleMinutes} min`) : chalk.dim("off")],
  ]);
  console.log();
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

function askLine(question) {
  const readlineInterface = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) =>
    readlineInterface.question(question, (answer) => {
      readlineInterface.close();
      resolveAnswer(answer.trim());
    })
  );
}

/**
 * Forgotten recovery passphrase: set a new one. Locked folders cannot be opened without the old
 * passphrase, so their images and keys are moved aside (not deleted) and their locks forgotten.
 * Locked apps stay locked and use the new passphrase.
 */
async function runReset() {
  if (!process.stdin.isTTY) throw new Error("tlock reset must be run in a terminal.");
  const folders = getLockRegistry().filter((entry) => entry.type === "folder");
  const open = folders.filter((entry) => isMountPoint(entry.target));
  if (open.length > 0) {
    throw new Error(
      `${open.map((entry) => entry.target).join(", ")} ${open.length === 1 ? "is" : "are"} open right now. ` +
        "Copy out anything you need, put it away with tlock <folder>, then run tlock reset again."
    );
  }

  console.log(chalk.bold("\n  Reset the recovery passphrase\n"));
  console.log("  Use this only if you forgot your recovery passphrase and Touch ID does not work.");
  if (folders.length > 0) {
    console.log(chalk.yellow(`\n  ! These locked folders cannot be opened without the old passphrase:`));
    for (const entry of folders) console.log(`    ${displayPath(entry.target)}`);
    console.log(chalk.dim("\n  Their encrypted images are moved aside, not deleted. If you remember the old passphrase"));
    console.log(chalk.dim("  later, move the files back into ~/.tlock to recover them."));
  }
  console.log(chalk.dim("  Locked apps stay locked and will use the new passphrase.\n"));

  if ((await askLine("  Type reset to continue: ")) !== "reset") {
    printResult("Cancelled", [], "warn");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = join(TLOCK_STORAGE_DIR, `reset-${stamp}`);
  console.log();
  await replaceVault(archiveDir);
  for (const entry of folders) {
    if (entry.dmgPath && existsSync(entry.dmgPath)) {
      renameSync(entry.dmgPath, join(archiveDir, basename(entry.dmgPath)));
    }
    removeEntry(entry.target);
  }

  printResult("Reset done");
}

/**
 * Wrap an async action with consistent error handling.
 */
function withErrorHandling(asyncAction) {
  return async (...args) => {
    try {
      await asyncAction(...args);
    } catch (error) {
      console.error(formatError(error.message));
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

function mainHelp() {
  return renderHelp({
    usage: ["tlock [OPTION]... TARGET", "tlock COMMAND [OPTION]... [TARGET]"],
    summary: [
      "Lock folders behind Touch ID on macOS.",
      "With no COMMAND, lock TARGET, a folder path.",
    ],
    sections: [
      {
        title: "Commands",
        items: [
          ["unlock, -u TARGET", "open a locked folder"],
          ["remove, -r TARGET", "remove the lock and restore TARGET"],
          ["shred, -s FOLDER", "destroy a locked folder for good"],
          ["list", "list locked folders"],
          ["status [TARGET]", "show whether TARGET is locked, or totals"],
          ["autolock", "show or change when open folders lock themselves"],
          ["reset", "set a new recovery passphrase if you forgot it"],
        ],
      },
      {
        title: "Options",
        items: [
          ["-a, --all", "lock every open folder"],
          ["    --for DURATION", "with unlock: lock again after DURATION (30m, 2h)"],
          ["-h, --help", "display this help and exit"],
          ["-v, --version", "output version information and exit"],
        ],
      },
      {
        title: "Examples",
        items: [
          ["tlock ~/Taxes", "lock a folder"],
          ["tlock -r ~/Taxes", "turn ~/Taxes back into a normal folder"],
          ["tlock -u ~/Taxes --for 30m", "open a folder for 30 minutes"],
        ],
      },
    ],
    footer: ["Run 'tlock COMMAND --help' for more on a command."],
  });
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
  .description("lock folders behind Touch ID on macOS")
  .version(VERSION, "-v, --version", "output version information and exit")
  .helpOption("-h, --help", "display this help and exit")
  .option("-u, --unlock <TARGET>", "open a locked folder")
  .option("--for <DURATION>", "with unlock: lock again after DURATION (30m, 2h)")
  .option("-a, --all", "lock every open folder")
  .option("-r, --remove <TARGET>", "remove the lock and restore TARGET")
  .option("-s, --shred <FOLDER>", "destroy a locked folder for good")
  .configureOutput({ outputError: (text, write) => {
    const message = text.replace(/^error: /, "").trim();
    let quoteHint = /^too many arguments\./.test(message)
      ? `\n${chalk.dim('     Put quotes around names with spaces: tlock "Brave Browser"')}`
      : "";
    // A command typed as a flag, e.g. --status or -reset: point to the command.
    const flagged = /unknown option '-{1,2}([a-z-]+)'/.exec(message)?.[1];
    if (flagged && program.commands.some((command) => command.name() === flagged && !command._hidden)) {
      quoteHint = `\n${chalk.dim(`     Did you mean: tlock ${flagged}`)}`;
    }
    write(`${formatError(message)}${quoteHint}\n${chalk.dim("     Try 'tlock --help' for more information.")}\n`);
  } });

program.allowExcessArguments(false);
program.showSuggestionAfterError(false);

// The main screen is hand-written; subcommands use commander's generated help with the same wording.
program.configureHelp({ ...program.configureHelp(), showGlobalOptions: false });
program.helpInformation = mainHelp;

// Default command: lock a target
program
  .argument("[TARGET]", "folder path to lock")
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
        throw new Error(
          "App locking is turned off in this version\n" +
            "Locking an app modified it, and some apps (Brave, for one) lost their extensions.\n" +
            "A safer app lock that leaves apps untouched is planned. Folder locking works as before.\n" +
            `To remove an app lock made by an older tlock: tlock -r "${basename(target, ".app")}"`
        );
      } else if (targetType === "folder") {
        await lockFolder(target);
      } else {
        const suggestion = closestName(target);
        throw new Error(
          `No folder or app named "${displayPath(target)}"` +
            (suggestion ? `\nDid you mean: tlock ${shellArg(displayPath(suggestion))}` : "")
        );
      }
    })
  );

// unlock
program
  .command("unlock <TARGET>")
  .usage("[OPTION]... TARGET")
  .description("open a locked folder")
  .option("--for <DURATION>", "lock the folder again after DURATION (30m, 2h)")
  .action(withErrorHandling((target, options) => runUnlock(target, options.for ?? program.opts().for)));

// list
program
  .command("list")
  .usage("[OPTION]...")
  .description("list locked folders")
  .action(withErrorHandling(async () => runList()));

// remove
program
  .command("remove <TARGET>")
  .usage("[OPTION]... TARGET")
  .description("remove the lock and restore TARGET")
  .option("-f, --force", "forget the lock even if there is nothing to restore")
  .action(withErrorHandling((target, options) => runRemove(target, options)));

// shred
program
  .command("shred <FOLDER>")
  .usage("FOLDER")
  .description("destroy a locked folder for good: erase its keys and delete its image")
  .action(withErrorHandling((target) => runShred(target)));

// autolock
program
  .command("autolock")
  .usage("[OPTION]...")
  .description("show or change when open folders lock themselves")
  .option("--idle <DURATION>", "lock after DURATION without input (15m), or off")
  .option("--sleep <on|off>", "lock when the Mac sleeps")
  .option("--screen-lock <on|off>", "lock when the screen locks")
  .action(withErrorHandling(async (options) => runAutolock(options)));

// reset
program
  .command("reset")
  .usage("[OPTION]...")
  .description("set a new recovery passphrase if you forgot it; locked folders are moved aside")
  .action(withErrorHandling(() => runReset()));

// status
program
  .command("status [TARGET]")
  .usage("[TARGET]")
  .description("show whether TARGET is locked (exit status 1 if not); with no TARGET, totals")
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
        printResult(`${target} is not locked`, [], "warn");
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

/**
 * A whole word after a single dash (-list, -reset, -version) means that command or long option,
 * not bundled short flags: -reset would otherwise read as -r eset and try to remove "eset".
 */
function normalizeArgs(argv) {
  const longOptions = new Set(program.options.map((option) => option.long?.slice(2)).filter(Boolean));
  longOptions.add("help");
  const commands = new Set(program.commands.filter((command) => !command._hidden).map((command) => command.name()));
  return argv.map((arg) => {
    const word = /^-([a-z][a-z-]{2,})$/.exec(arg)?.[1];
    if (!word) return arg;
    if (longOptions.has(word)) return `--${word}`;
    if (commands.has(word)) return word;
    return arg;
  });
}

process.argv = [...process.argv.slice(0, 2), ...normalizeArgs(process.argv.slice(2))];
enforceMaxOSPlatform();
if (shouldShowBanner()) printBanner();
await program.parseAsync();
