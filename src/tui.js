import chalk from "chalk";
import { basename } from "path";

const B = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  lj: "├",
  rj: "┤",
};

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function vlen(s) {
  return stripAnsi(s).length;
}

/** Usable terminal width; never assume a fixed size. */
export function terminalColumns() {
  const fromEnv = Number.parseInt(process.env.COLUMNS || "", 10);
  const n = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : process.stdout.columns;
  return Math.max(20, n || 80);
}

function hr(n) {
  return B.h.repeat(Math.max(0, n));
}

function truncMiddle(s, max) {
  const t = stripAnsi(s);
  if (max <= 0) return "";
  if (t.length <= max) return s;
  if (max === 1) return "…";
  const left = Math.ceil((max - 1) / 2);
  const right = max - 1 - left;
  return t.slice(0, left) + "…" + (right > 0 ? t.slice(-right) : "");
}

function fitVisible(s, width) {
  const w = Math.max(0, width);
  const clipped = truncMiddle(s, w);
  return clipped + " ".repeat(Math.max(0, w - vlen(clipped)));
}

function wrapAnsi(s, width) {
  const w = Math.max(1, width);
  const str = String(s);
  const chunks = [];
  let visible = 0;
  let buf = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\u001b") {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) {
        buf += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (visible === w) {
      chunks.push(buf);
      buf = "";
      visible = 0;
    }
    buf += str[i];
    visible += 1;
    i += 1;
  }
  if (buf.length > 0 || chunks.length === 0) chunks.push(buf);
  return chunks;
}

function displayPath(p) {
  const home = process.env.HOME;
  const s = String(p);
  if (home && (s === home || s.startsWith(`${home}/`))) {
    return `~${s.slice(home.length)}`;
  }
  return s;
}

function boxLine(indent, border, inner) {
  return indent + border(B.v) + " " + inner + " " + border(B.v);
}

/**
 * Key/value panel. Width follows the terminal; long values wrap inside the box.
 */
export function printKvBox(title, rows) {
  const indent = "  ";
  const border = chalk.green;
  const titleStyle = chalk.cyan;
  const cols = terminalColumns();
  const innerW = Math.max(8, cols - indent.length - 4);

  const labelW = Math.min(
    Math.max(4, ...rows.map(([a]) => vlen(a))),
    Math.max(4, innerW - 4)
  );

  const innerLines = [];
  for (const [label, value] of rows) {
    const lbl = fitVisible(label, labelW);
    const gap = 2;
    const valueW = innerW - labelW - gap;
    if (valueW < 8) {
      for (const chunk of wrapAnsi(`${stripAnsi(label)}  ${value}`, innerW)) {
        innerLines.push(fitVisible(chunk, innerW));
      }
      continue;
    }
    const wrapped = wrapAnsi(value, valueW);
    wrapped.forEach((chunk, i) => {
      const prefix = i === 0 ? lbl : " ".repeat(labelW);
      innerLines.push(fitVisible(`${prefix}${" ".repeat(gap)}${chunk}`, innerW));
    });
  }

  const top = indent + border(B.tl + hr(innerW + 2) + B.tr);
  const titleLine = boxLine(indent, border, fitVisible(titleStyle(title), innerW));
  const sep = indent + border(B.lj + hr(innerW + 2) + B.rj);
  const body = innerLines.map((line) => boxLine(indent, border, line));
  const bot = indent + border(B.bl + hr(innerW + 2) + B.br);

  console.log([top, titleLine, sep, ...body, bot].join("\n"));
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Wrap plain text to width, preferring breaks after "/" or a space. */
function wrapPlain(text, width) {
  const lines = [];
  let line = "";
  for (const token of String(text).split(/(?<=[/ ])/)) {
    if (line && line.length + token.length > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    let rest = token;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    line += rest;
  }
  if (line || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

function clockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Registry list as short blocks: name and state, then path and date.
 * No columns, so it reads the same at any terminal width.
 */
export function printLockedTargets(entries, formatDate, isUnlocked) {
  const width = terminalColumns();
  const detailWidth = Math.max(10, width - 4);
  const folders = entries.filter((entry) => entry.type === "folder").length;
  const apps = entries.length - folders;
  const counts = [folders && pluralize(folders, "folder"), apps && pluralize(apps, "app")]
    .filter(Boolean)
    .join(", ");

  const lines = ["", `  ${chalk.cyan.bold("Locks")}  ${chalk.dim(counts)}`, ""];
  for (const entry of entries) {
    let state = chalk.dim("app");
    if (entry.type === "folder") {
      state = !isUnlocked(entry)
        ? chalk.green("locked")
        : chalk.yellow(entry.autoLockAt ? `open until ${clockTime(entry.autoLockAt)}` : "open");
    }
    const name = basename(entry.target).replace(/\.app$/, "");

    const details = wrapPlain(displayPath(entry.target), detailWidth);
    const added = `added ${formatDate(entry.createdAt)}`;
    const last = details[details.length - 1];
    if (last.length + 2 + added.length <= detailWidth) {
      details[details.length - 1] = `${last}  ${added}`;
    } else {
      details.push(added);
    }

    if (name.length + 2 + vlen(state) <= width - 2) {
      lines.push(`  ${chalk.bold(name)}  ${state}`);
    } else {
      lines.push(`  ${chalk.bold(truncMiddle(name, width - 2))}`);
      lines.push(`    ${state}`);
    }
    lines.push(...details.map((detail) => `    ${chalk.dim(detail)}`), "");
  }
  console.log(lines.join("\n"));
}

/**
 * Summary counts (status command, all targets).
 */
export function printStatusSummary(folderCount, appCount, total) {
  console.log();
  printKvBox("TLOCK STATUS", [
    [chalk.dim("Folders"), chalk.green(String(folderCount))],
    [chalk.dim("Apps"), chalk.green(String(appCount))],
    [chalk.dim("Total"), chalk.green(String(total))],
  ]);
  console.log();
}

/**
 * Single-entry status (tlock status <path>).
 */
export function printEntryStatus(entry, formatDate) {
  const rows = [
    [chalk.dim("Path"), chalk.green(displayPath(entry.target))],
    [chalk.dim("Type"), chalk.green(entry.type)],
    [chalk.dim("Locked at"), chalk.green(formatDate(entry.createdAt))],
  ];
  if (entry.dmgPath) {
    rows.push([chalk.dim("Image"), chalk.dim(displayPath(entry.dmgPath))]);
  }
  printKvBox("LOCK STATUS", rows);
}
