import chalk from "chalk";

const B = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  lj: "├",
  rj: "┤",
  tm: "┬",
  bm: "┴",
  mm: "┼",
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

function printStackedTable(entries, formatDate, indent, innerW, border, titleStyle, dim) {
  const lines = [
    indent + border(B.tl + hr(innerW + 2) + B.tr),
    boxLine(indent, border, fitVisible(titleStyle("LOCKED TARGETS"), innerW)),
    indent + border(B.lj + hr(innerW + 2) + B.rj),
  ];

  entries.forEach((e, i) => {
    const typeW = 6;
    const type = fitVisible(e.type, typeW);
    const gap = 2;
    const pathBudget = Math.max(4, innerW - typeW - gap);
    const pathLines = wrapAnsi(displayPath(e.target), pathBudget);
    pathLines.forEach((pl, j) => {
      const prefix = j === 0 ? type : " ".repeat(typeW);
      lines.push(boxLine(indent, border, fitVisible(`${prefix}${" ".repeat(gap)}${pl}`, innerW)));
    });
    const when = `${" ".repeat(typeW + gap)}${formatDate(e.createdAt)}`;
    lines.push(boxLine(indent, border, fitVisible(dim(when), innerW)));
    if (i < entries.length - 1) {
      lines.push(indent + border(B.lj + hr(innerW + 2) + B.rj));
    }
  });

  lines.push(indent + border(B.bl + hr(innerW + 2) + B.br));
  console.log("\n" + lines.join("\n") + "\n");
}

/**
 * Registry list. Three columns when there is room; stacked rows when the
 * terminal is too narrow. Every line is clipped to the current width.
 */
export function printLockedTargetsTable(entries, formatDate) {
  const indent = "  ";
  const titleStyle = chalk.cyan;
  const border = chalk.green;
  const dim = chalk.dim;
  const cols = terminalColumns();
  const innerW = Math.max(8, cols - indent.length - 4);

  // indent + 4 borders + 6 cell pads = 12 columns of chrome for a 3-col row.
  const chrome = indent.length + 10;
  const budget = cols - chrome;
  const wType = 6;
  const dates = entries.map((e) => formatDate(e.createdAt));
  const wWhen = Math.max(vlen("Locked at"), ...dates.map((d) => vlen(d)));
  const wPath = budget - wType - wWhen;
  // Need a readable path column and the full timestamp; otherwise stack.
  if (wPath < 16) {
    printStackedTable(entries, formatDate, indent, innerW, border, titleStyle, dim);
    return;
  }

  const c1 = wType + 2;
  const c2 = wPath + 2;
  const c3 = wWhen + 2;
  const titlePad = c1 + c2 + c3;

  const lines = [];
  lines.push(indent + border(B.tl + hr(titlePad + 2) + B.tr));
  lines.push(boxLine(indent, border, fitVisible(titleStyle("LOCKED TARGETS"), titlePad)));
  lines.push(indent + border(B.lj + hr(c1) + B.tm + hr(c2) + B.tm + hr(c3) + B.rj));
  lines.push(
    indent +
      border(B.v) +
      " " +
      dim(fitVisible("Type", wType)) +
      " " +
      border(B.v) +
      " " +
      dim(fitVisible("Path", wPath)) +
      " " +
      border(B.v) +
      " " +
      dim(fitVisible("Locked at", wWhen)) +
      " " +
      border(B.v)
  );
  lines.push(indent + border(B.lj + hr(c1) + B.mm + hr(c2) + B.mm + hr(c3) + B.rj));

  for (const e of entries) {
    lines.push(
      indent +
        border(B.v) +
        " " +
        fitVisible(e.type, wType) +
        " " +
        border(B.v) +
        " " +
        fitVisible(truncMiddle(displayPath(e.target), wPath), wPath) +
        " " +
        border(B.v) +
        " " +
        fitVisible(formatDate(e.createdAt), wWhen) +
        " " +
        border(B.v)
    );
  }

  lines.push(indent + border(B.bl + hr(c1) + B.bm + hr(c2) + B.bm + hr(c3) + B.br));
  console.log("\n" + lines.join("\n") + "\n");
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
