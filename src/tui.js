import chalk from "chalk";
import { basename } from "path";

const INDENT = "  ";

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
  return "─".repeat(Math.max(0, n));
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

const MARKS = { ok: "🟢", warn: "🟡", bad: "🔴" };
const commandStyle = chalk.ansi256(75);

/** Style a command the user can type, e.g. in a result hint. */
export function cmd(text) {
  return commandStyle(text);
}

/** Word-wrap text that may contain color codes, measuring only visible characters. */
function wrapWords(text, width) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && vlen(line) + 1 + vlen(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * What a command just did: a marked headline, then short dim detail lines (hints, next steps).
 * tone: "ok" (🟢), "warn" (🟡), "bad" (🔴).
 */
export function printResult(headline, details = [], tone = "ok") {
  const width = Math.max(20, terminalColumns() - INDENT.length - 4);
  const lines = ["", `${INDENT}${MARKS[tone]} ${headline}`];
  for (const detail of details) {
    lines.push(...wrapWords(detail, width).map((line) => `${INDENT}   ${chalk.dim(line)}`));
  }
  console.log(lines.join("\n"));
}

/** An error, formatted like a result: first line marked, later lines as hints. */
export function formatError(message) {
  const [first, ...rest] = String(message).split("\n");
  const hints = rest.map((line) => `${INDENT}   ${chalk.dim(line.trim())}`);
  return ["", `${INDENT}${MARKS.bad} ${chalk.red(first)}`, ...hints].join("\n");
}

/**
 * GNU-style help: Usage lines, a summary, then two-column sections, e.g.
 * { title: "Options", items: [["-h, --help", "display this help and exit"]] }.
 * Terms and descriptions share a line when they fit; otherwise the description goes below.
 */
export function renderHelp({ usage, summary, sections, footer }) {
  const width = terminalColumns() - 1;
  const termW = Math.max(...sections.flatMap((section) => section.items.map(([term]) => term.length)));
  const sideBySide = 2 + termW + 2 + 24 <= width;

  const out = usage.map((line, i) => `${i === 0 ? "Usage: " : "       "}${line}`);
  out.push(...summary.flatMap((line) => wrapWords(line, width)).map((line, i) => (i === 0 ? `\n${line}` : line)));
  for (const { title, items } of sections) {
    out.push("", chalk.bold(`${title}:`));
    for (const [term, text] of items) {
      if (sideBySide) {
        const lines = wrapWords(text, width - termW - 4);
        out.push(`  ${cmd(term.padEnd(termW))}  ${lines[0]}`);
        for (const line of lines.slice(1)) out.push(`  ${" ".repeat(termW)}  ${line}`);
      } else {
        out.push(`  ${cmd(term)}`);
        out.push(...wrapWords(text, width - 6).map((line) => `      ${line}`));
      }
    }
  }
  if (footer) out.push("", ...footer);
  return `${out.join("\n")}\n`;
}

export function displayPath(p) {
  const home = process.env.HOME;
  const s = String(p);
  if (home && (s === home || s.startsWith(`${home}/`))) {
    return `~${s.slice(home.length)}`;
  }
  return s;
}

/**
 * Borderless key/value panel: a title, then aligned label/value lines. Nothing is drawn out to a
 * fixed edge, so resizing the window afterwards cannot break it. Long values wrap under themselves;
 * when the value column would be too narrow, values go on their own line below the label.
 */
export function printKv(title, rows) {
  const width = Math.max(10, terminalColumns() - INDENT.length - 1);
  const gap = "  ";
  const labelW = Math.max(...rows.map(([label]) => vlen(label)));
  const valueW = width - labelW - gap.length;

  const lines = [INDENT + chalk.bold(title), ""];
  for (const [label, value] of rows) {
    if (valueW < 12) {
      lines.push(INDENT + label);
      lines.push(...wrapAnsi(value, width - 2).map((chunk) => `${INDENT}  ${chunk}`));
      continue;
    }
    wrapAnsi(value, valueW).forEach((chunk, i) => {
      const prefix = i === 0 ? label + " ".repeat(labelW - vlen(label)) : " ".repeat(labelW);
      lines.push(INDENT + prefix + gap + chunk);
    });
  }
  console.log(lines.join("\n"));
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Wrap plain text to width: breaks after "/" or a space, then inside long words after - _ . */
function wrapPlain(text, width) {
  const tokens = [];
  for (const token of String(text).split(/(?<=[/ ])/)) {
    tokens.push(...(token.length > width ? token.split(/(?<=[-_.])/) : [token]));
  }
  const lines = [];
  let line = "";
  for (const token of tokens) {
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

export function clockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const sum = (values) => values.reduce((total, value) => total + value, 0);
const GAP = "   ";

/**
 * Column widths that fit the terminal, or null if the columns' `min` widths do not.
 * Space above the minimums is shared in proportion to how much each column still needs.
 */
function fitColumns(columns, rows, width) {
  const budget = width - INDENT.length - GAP.length * (columns.length - 1) - 1;
  const natural = columns.map((column, i) =>
    Math.max(column.header.length, ...rows.map((row) => row[i].text.length))
  );
  const floors = columns.map((column, i) => Math.min(natural[i], Math.max(column.header.length, column.min)));
  const spare = budget - sum(floors);
  if (spare < 0) return null;

  const need = natural.map((n, i) => n - floors[i]);
  const totalNeed = sum(need);
  if (totalNeed <= spare) return natural;
  const widths = floors.map((floor, i) => floor + Math.floor((spare * need[i]) / totalNeed));
  for (let leftover = budget - sum(widths); leftover > 0; leftover--) {
    let neediest = 0;
    widths.forEach((w, i) => {
      if (natural[i] - w > natural[neediest] - widths[neediest]) neediest = i;
    });
    widths[neediest] += 1;
  }
  return widths;
}

/** Title parts on one line when they fit, otherwise one part per line. */
function titleLines(title, inner) {
  const parts = Array.isArray(title) ? title.filter(Boolean) : [title];
  const joined = parts.join("  ");
  return vlen(joined) <= inner ? [joined] : parts;
}

const paint = (cell, text) => (cell.style ? cell.style(text) : text);

function drawColumns(title, columns, rows, widths, width) {
  const rowLines = (cells) => {
    const wrapped = cells.map((cell, i) => wrapPlain(cell.text, widths[i]).map((text) => paint(cell, text)));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    return Array.from({ length: height }, (_, k) =>
      (INDENT + wrapped.map((lines, i) => fitVisible(lines[k] ?? "", widths[i])).join(GAP)).trimEnd()
    );
  };

  const tableWidth = sum(widths) + GAP.length * (widths.length - 1);
  const bodies = rows.map(rowLines);
  const spaced = bodies.some((lines) => lines.length > 1);
  const out = [
    ...titleLines(title, width - INDENT.length - 1).map((text) => INDENT + text),
    "",
    ...rowLines(columns.map((column) => ({ text: column.header.toUpperCase(), style: chalk.dim }))),
    INDENT + chalk.dim(hr(tableWidth)),
  ];
  bodies.forEach((lines, i) => {
    if (spaced && i > 0) out.push("");
    out.push(...lines);
  });
  return out.join("\n");
}

/**
 * One block per row for narrow terminals. The first two cells share a line only when that fits for
 * every row, so all blocks keep the same shape; the remaining cells go below, indented.
 */
function drawStacked(title, rows, width) {
  const inner = Math.max(10, width - INDENT.length - 1);
  const cellsOf = (row) => row.filter((cell) => cell.text);
  const pairFits = rows.every((row) => {
    const [first, second] = cellsOf(row);
    return !second || first.text.length + 2 + second.text.length <= inner;
  });
  const out = titleLines(title, inner).map((text) => INDENT + text);
  for (const row of rows) {
    const [first, ...rest] = cellsOf(row);
    out.push("");
    if (rest.length > 0 && pairFits) {
      out.push(`${INDENT}${paint(first, first.text)}  ${paint(rest[0], rest[0].text)}`);
      rest.shift();
    } else {
      out.push(...wrapPlain(first.text, inner).map((text) => INDENT + paint(first, text)));
    }
    for (const cell of rest) {
      out.push(...wrapPlain(cell.text, inner - 2).map((text) => `${INDENT}  ${paint(cell, text)}`));
    }
  }
  return out.join("\n");
}

/**
 * Borderless table sized to the terminal at print time; with no box to break, it also survives
 * the window being resized afterwards. Cells wrap at word and path boundaries; when space runs out,
 * columns with a `drop` rank go first (highest first), and below that each row becomes a block.
 * title: string or [title, detail]; columns: [{ header, min, drop? }]; rows: [[{ text, style? }]].
 */
export function renderTable(title, columns, rows) {
  const width = terminalColumns();
  let active = columns.map((_, i) => i);
  const pick = (row) => active.map((i) => row[i]);
  while (true) {
    const shownColumns = pick(columns);
    const shownRows = rows.map(pick);
    const widths = fitColumns(shownColumns, shownRows, width);
    if (widths) return drawColumns(title, shownColumns, shownRows, widths, width);

    const droppable = active.filter((i) => columns[i].drop).sort((a, b) => columns[b].drop - columns[a].drop);
    if (droppable.length === 0) return drawStacked(title, rows, width);
    active = active.filter((i) => i !== droppable[0]);
  }
}

const TONES = { ok: chalk.green, warn: chalk.yellow, bad: chalk.red };

/**
 * Registry table. stateOf(entry) returns { label, tone: "ok" | "warn" | "bad" }.
 */
export function printLockedTargets(entries, formatDate, stateOf) {
  const folders = entries.filter((entry) => entry.type === "folder").length;
  const apps = entries.length - folders;
  const counts = [folders && pluralize(folders, "folder"), apps && pluralize(apps, "app")]
    .filter(Boolean)
    .join(", ");

  const columns = [
    { header: "Name", min: 14 },
    { header: "Status", min: 9 },
    { header: "Path", min: 24 },
    { header: "Added", min: 16, drop: 1 },
  ];
  const rows = entries.map((entry) => {
    const state = stateOf(entry);
    return [
      { text: basename(entry.target) },
      { text: state.label, style: TONES[state.tone] },
      { text: displayPath(entry.target) },
      { text: formatDate(entry.createdAt), style: chalk.dim },
    ];
  });

  console.log(`\n${renderTable([chalk.bold("Locked"), chalk.dim(counts)], columns, rows)}\n`);
}

/**
 * Summary counts (status command, all targets).
 */
export function printStatusSummary(folderCount, appCount, total) {
  console.log();
  printKv("tlock status", [
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
  printKv("Lock status", rows);
}
