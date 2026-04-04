#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { platform } from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import figlet from "figlet";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")).version;

// ─── Shared color helpers ────────────────────────────────────────────
const terra    = (s) => `\x1b[38;5;166m${s}\x1b[0m`;
const terraLt  = (s) => `\x1b[38;5;172m${s}\x1b[0m`;

// Blue gradient matching #176be8: dark navy → royal blue → sky blue
// xterm-256: 18=#000087  19=#0000af  26=#005fd7  27=#005fff  33=#0087ff  75=#5fafff
const BLUE_STOPS = [18, 19, 26, 27, 33, 33, 75];

// Red for O: #de2158 ≈ xterm 161 (#d7005f)
const redO = (s) => `\x1b[38;5;161m${s}\x1b[0m`;

function gradientLine(str) {
  const chars = str.split("");
  const total = chars.length || 1;
  return chars.map((ch, i) => {
    const idx = BLUE_STOPS[Math.round((i / (total - 1 || 1)) * (BLUE_STOPS.length - 1))];
    return `\x1b[38;5;${idx}m${ch}\x1b[0m`;
  }).join("");
}

/** Big ASCII banner only for top-level help — not for list/status/version/lock/etc. */
function shouldPrintBanner() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return true;
  if (argv.includes("auth-gate")) return false;
  if (argv.includes("-V") || argv.includes("--version")) return false;
  const subcommands = new Set(["unlock", "list", "remove", "status"]);
  const first = argv[0];
  if (first && subcommands.has(first)) return false;
  if (first && !first.startsWith("-")) return false;
  if (argv.includes("-u") || argv.includes("--unlock") || argv.includes("-r") || argv.includes("--remove")) {
    return false;
  }
  return argv.includes("-h") || argv.includes("--help");
}

async function printBanner() {
  if (process.argv.includes("auth-gate")) return;
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

    const rawWidth    = artLines[0].replace(/\x1b\[[0-9;]*m/g, "").length;
    const subtitleRaw = `made by freyzo  v${VERSION}`;
    const width       = Math.max(rawWidth, subtitleRaw.length) + 2;
    const blueAnsi    = (s) => `\x1b[38;5;33m${s}\x1b[0m`;
    const dash        = blueAnsi("─");

    console.log("");
    console.log("  " + blueAnsi("┌") + dash.repeat(width) + blueAnsi("┐"));
    for (const line of artLines) {
      console.log("     " + line);
    }
    console.log("     " + chalk.dim("made by freyzo  ") + blueAnsi(`v${VERSION}`));
    console.log("  " + blueAnsi("└") + dash.repeat(width) + blueAnsi("┘"));
    console.log("");
  } catch {
    // deps missing — skip silently
  }
}
import { resolve, basename } from "path";
import { existsSync, statSync } from "fs";
import { lockFolder, unlockFolder, removeFolder } from "../src/lock-folder.js";
import { lockApp, unlockApp, removeApp } from "../src/lock-app.js";
import { authenticate } from "../src/auth.js";
import { getLockRegistry, getEntry } from "../src/config.js";

// ─── Helpers ────────────────────────────────────────────────────────

function enforceMaxOSPlatform() {
  if (platform() !== "darwin") {
    console.error(chalk.red("tlock requires macOS to run."));
    process.exit(1);
  }
}

/**
 * Find registry entry for a user-supplied target (full path, cwd-relative, or folder basename).
 */
function findEntryForTarget(target) {
  const candidates = [
    resolve(target),
    `/Applications/${target}.app`,
  ];
  for (const p of candidates) {
    const entry = getEntry(p);
    if (entry) return entry;
  }
  const base = basename(target.replace(/\/$/, ""));
  const entries = getLockRegistry();
  const byBase = entries.filter((e) => basename(e.target) === base);
  if (byBase.length > 1) {
    throw new Error(
      `Multiple locks named "${base}". Use full path. Try:\n  ${byBase.map((e) => `tlock unlock ${e.target}`).join("\n  ")}`
    );
  }
  if (byBase.length === 1) return byBase[0];
  return null;
}

/**
 * Detect whether a target is a folder or an app bundle.
 * Returns "folder" | "app" | "unknown".
 */

function detectTargetType(target) {
  if (target.endsWith(".app")) return "app";
  // Bare name — check if it resolves to an app in /Applications
  if (existsSync(`/Applications/${target}.app`)) return "app";
  // Check registry for previously locked target
  const entry = findEntryForTarget(target);
  const absolutePath = resolve(target);
  if (entry) return entry.type;
  // Check filesystem
  if (existsSync(absolutePath) && statSync(absolutePath).isDirectory()) return "folder";
  return "unknown";
}

/**
 * Wrap an async action with consistent error handling.
 */
function withErrorHandling(asyncAction) {
  return async (...args) => {
    try {
      await asyncAction(...args);
    } catch (error) {
      console.error(chalk.red(`\n✗ ${error.message}`));
      process.exit(1);
    }
  };
}

/**
 * Format a date string for display.
 */
function formatDate(isoString) {
  return new Date(isoString).toLocaleString();
}

// ─── CLI ────────────────────────────────────────────────────────────

const program = new Command();

program.configureHelp({
  styleTitle:          (s) => terra(s),
  styleCommandText:    (s) => terraLt(s),
  styleOptionText:     (s) => terra(s),
  styleArgumentText:   (s) => terraLt(s),
  styleSubcommandText: (s) => terraLt(s),
});

program
  .name("tlock")
  .description(chalk.dim("Lock folders and apps with Touch ID on macOS"))
  .version(VERSION)
  .option("-u, --unlock <target>", "Unlock a locked folder/app")
  .option("-r, --remove <target>", "Permanently remove lock and restore target");

// Default command: lock a target
program
  .argument("[target]", "folder path or app name to lock")
  .action(
    withErrorHandling(async (target) => {
      const options = program.opts();
      if (options.unlock && options.remove) {
        throw new Error("Use either --unlock/-u or --remove/-r, not both.");
      }

      if (options.unlock) {
        const entry = findEntryForTarget(options.unlock);
        if (!entry) {
          throw new Error(`No lock found for: ${options.unlock}`);
        }
        if (entry.type === "folder") {
          await unlockFolder(entry.target);
        } else {
          await unlockApp(entry.target);
        }
        return;
      }

      if (options.remove) {
        const entry = findEntryForTarget(options.remove);
        if (!entry) {
          throw new Error(`No lock found for: ${options.remove}`);
        }
        if (entry.type === "folder") {
          await removeFolder(entry.target);
        } else {
          await removeApp(entry.target);
        }
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
  .description("Unlock a previously locked folder or app")
  .action(
    withErrorHandling(async (target) => {
      const entry = findEntryForTarget(target);
      if (!entry) {
        throw new Error(`No lock found for: ${target}`);
      }
      if (entry.type === "folder") {
        await unlockFolder(entry.target);
      } else {
        await unlockApp(entry.target);
  }
    })
);

// list
program
  .command("list")
  .description("List all locked targets")
  .action(
    withErrorHandling(async () => {
      const entries = getLockRegistry();
      if (entries.length === 0) {
        console.log(chalk.dim("No locked targets."));
        return;
      }
      console.log("\n  " + terra("🔒 locked targets") + "\n");
      for (const entry of entries) {
        const typeLabel =
          entry.type === "folder"
            ? terra("[folder]")
            : terraLt("[app]   ");
        const dateLabel = chalk.dim(formatDate(entry.createdAt));
        console.log(`  ${typeLabel}  ${entry.target}  ${dateLabel}`);
      }
      console.log();
  })
);

// remove
program
  .command("remove <target>")
  .description("Permanently remove lock and restore target")
  .action(
    withErrorHandling(async (target) => {
      const entry = findEntryForTarget(target);
      if (!entry) {
        throw new Error(`No lock found for: ${target}`);
      }
      if (entry.type === "folder") {
        await removeFolder(entry.target);
      } else {
        await removeApp(entry.target);
  }
    })
);

// status
program
  .command("status [target]")
  .description("Show lock status of a target or all targets")
  .action(
    withErrorHandling(async (target) => {
      if (!target) {
        // Show summary
        const entries = getLockRegistry();
        const folderCount = entries.filter((e) => e.type === "folder").length;
        const appCount = entries.filter((e) => e.type === "app").length;
        console.log("\n  " + terra("tlock status") + "\n");
        console.log(`  ${chalk.dim("folders")}  ${terra(folderCount)}`);
        console.log(`  ${chalk.dim("apps    ")}  ${terra(appCount)}`);
        console.log(`  ${chalk.dim("total   ")}  ${terra(entries.length)}`);
        console.log();
        return;
      }
      const entry = findEntryForTarget(target);
      if (!entry) {
        console.log(chalk.dim(`Not locked: ${target}`));
        return;
      }
      console.log("\n  " + terra("🔒 " + entry.target) + "\n");
      console.log(`  ${chalk.dim("type      ")}  ${entry.type}`);
      console.log(`  ${chalk.dim("locked at ")}  ${formatDate(entry.createdAt)}`);
      if (entry.dmgPath) {
        console.log(`  ${chalk.dim("dmg       ")}  ${entry.dmgPath}`);
      }
      console.log();
  })
);

// Hidden subcommand used by the app-lock wrapper script
program
  .command("auth-gate", { hidden: true })
  .action(async () => {
    try {

      await authenticate();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  });

// ─── Run ────────────────────────────────────────────────────────────

enforceMaxOSPlatform();
if (shouldPrintBanner()) await printBanner();
program.parse();
