#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import figlet from "figlet";
import { platform } from "os";
import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { basename, dirname, join, resolve } from "path";
import { lockFolder, unlockFolder, removeFolder, shredFolder } from "../src/lock-folder.js";
import { lockApp, unlockApp, removeApp } from "../src/lock-app.js";
import { authenticate } from "../src/auth.js";
import { getLockRegistry, getEntry, canonicalPath } from "../src/config.js";
import {
  printLockedTargetsTable,
  printStatusSummary,
  printEntryStatus,
  stripAnsi,
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

async function runUnlock(target) {
  const entry = findEntryForTarget(target, "unlock");
  if (!entry) {
    throw new Error(`No lock found for: ${target}`);
  }
  if (entry.type === "folder") {
    await unlockFolder(entry);
  } else {
    unlockApp(entry);
  }
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
  .option("-r, --remove <target>", "Permanently remove lock and restore target")
  .option("-s, --shred <target>", "Destroy a locked folder for good (no restore)");

// Default command: lock a target
program
  .argument("[target]", "folder path or app name to lock (run again on an unlocked folder to lock it)")
  .action(
    withErrorHandling(async (target) => {
      const options = program.opts();
      if ([options.unlock, options.remove, options.shred].filter(Boolean).length > 1) {
        throw new Error("Use only one of --unlock/-u, --remove/-r, --shred/-s.");
      }
      if (options.unlock) {
        await runUnlock(options.unlock);
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
  .action(withErrorHandling((target) => runUnlock(target)));

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
      printLockedTargetsTable(entries, formatDate);
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
