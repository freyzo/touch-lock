#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { platform } from "os";
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
    resolve(process.cwd(), target),
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

program
  .name("tlock")
  .description("Lock folders and apps with Touch ID on macOS")
  .version("0.1.2");

// Default command: lock a target
program
  .argument("[target]", "folder path or app name to lock")
  .action(
    withErrorHandling(async (target) => {
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
      console.log(chalk.bold("\nLocked targets:\n"));
      for (const entry of entries) {
        const typeLabel =
          entry.type === "folder"
            ? chalk.blue("[folder]")
            : chalk.magenta("[app]   ");
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
        console.log(chalk.bold("\ntlock status\n"));
        console.log(`  Locked folders: ${chalk.cyan(folderCount)}`);
        console.log(`  Locked apps:    ${chalk.cyan(appCount)}`);
        console.log(`  Total:          ${chalk.cyan(entries.length)}`);
        console.log();
        return;
      }
      const entry = findEntryForTarget(target);
      if (!entry) {
        console.log(chalk.dim(`Not locked: ${target}`));
        return;
      }
      console.log(chalk.bold(`\n${entry.target}\n`));
      console.log(`  Type:       ${entry.type}`);
      console.log(`  Locked at:  ${formatDate(entry.createdAt)}`);
      if (entry.dmgPath) {
        console.log(`  DMG:        ${entry.dmgPath}`);
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
program.parse();
