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
 * Key/value panel, as wide as its content (up to the terminal); long values wrap inside the box.
 */
export function printKvBox(title, rows) {
  const indent = "  ";
  const border = chalk.green;
  const titleStyle = chalk.cyan;
  const cols = terminalColumns();
  // One spare column so a slightly narrower window does not re-wrap the box.
  const maxInner = Math.max(8, cols - indent.length - 5);
  const naturalLabelW = Math.max(4, ...rows.map(([a]) => vlen(a)));
  const contentW = Math.max(vlen(title), ...rows.map(([, value]) => naturalLabelW + 2 + vlen(value)));
  const innerW = Math.min(maxInner, contentW);

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

/** One block per row for narrow terminals: first two cells on one line if they fit, the rest below. */
function drawStacked(title, rows, width) {
  const inner = Math.max(10, width - INDENT.length - 1);
  const out = titleLines(title, inner).map((text) => INDENT + text);
  for (const row of rows) {
    const [first, ...rest] = row.filter((cell) => cell.text);
    out.push("");
    if (rest.length > 0 && first.text.length + 2 + rest[0].text.length <= inner) {
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

  console.log(`\n${renderTable([chalk.cyan("LOCKED TARGETS"), chalk.dim(counts)], columns, rows)}\n`);
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
