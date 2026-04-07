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

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function vlen(s) {
  return stripAnsi(s).length;
}

function padEndVisible(s, width) {
  const n = vlen(s);
  if (n >= width) return s;
  return s + " ".repeat(width - n);
}

function hr(n) {
  return B.h.repeat(n);
}

/**
 * Key/value panel (boxed header + rows).
 */
export function printKvBox(title, rows, opts = {}) {
  const {
    indent = "  ",
    border = chalk.green,
    titleStyle = chalk.cyan,
  } = opts;

  const labelW = Math.max(4, ...rows.map(([a]) => vlen(a)));
  const rowTexts = rows.map(([label, value]) => {
    const lbl = padEndVisible(label, labelW);
    return `${lbl}  ${value}`;
  });

  const innerW = Math.max(
    stripAnsi(title).length,
    ...rowTexts.map((r) => vlen(r)),
    28
  );

  const top = indent + border(B.tl + hr(innerW + 2) + B.tr);
  const titleLine =
    indent +
    border(B.v) +
    " " +
    padEndVisible(titleStyle(title), innerW) +
    " " +
    border(B.v);
  const sep = indent + border(B.lj + hr(innerW + 2) + B.rj);
  const body = rowTexts.map(
    (rt) =>
      indent +
      border(B.v) +
      " " +
      padEndVisible(rt, innerW) +
      " " +
      border(B.v)
  );
  const bot = indent + border(B.bl + hr(innerW + 2) + B.br);

  console.log([top, titleLine, sep, ...body, bot].join("\n"));
}

/**
 * Registry list as a column table.
 */
export function printLockedTargetsTable(entries, formatDate) {
  const indent = "  ";
  const termW = Math.max(60, Math.min(process.stdout.columns || 80, 120));
  const wType = 8;
  const wWhen = 24;
  const wPath = Math.max(24, termW - indent.length - wType - wWhen - 8);

  const titleStyle = chalk.cyan;
  const border = chalk.green;
  const dim = chalk.dim;

  const trunc = (s, max) => {
    const t = stripAnsi(s);
    if (t.length <= max) return s;
    const left = Math.max(4, Math.floor(max / 2) - 2);
    const right = max - left - 3;
    return t.slice(0, left) + "…" + t.slice(-right);
  };

  const c1 = wType + 2;
  const c2 = wPath + 2;
  const c3 = wWhen + 2;
  const titlePad = c1 + c2 + c3;

  const lines = [];
  lines.push(
    indent + border(B.tl + hr(c1) + B.tm + hr(c2) + B.tm + hr(c3) + B.tr)
  );
  lines.push(
    indent +
      border(B.v) +
      " " +
      padEndVisible(titleStyle("LOCKED TARGETS"), titlePad) +
      " " +
      border(B.v)
  );
  lines.push(
    indent + border(B.lj + hr(c1) + B.tm + hr(c2) + B.tm + hr(c3) + B.rj)
  );
  lines.push(
    indent +
      border(B.v) +
      " " +
      dim(padEndVisible("Type", wType)) +
      " " +
      border(B.v) +
      " " +
      dim(padEndVisible("Path", wPath)) +
      " " +
      border(B.v) +
      " " +
      dim(padEndVisible("Locked at", wWhen)) +
      " " +
      border(B.v)
  );
  lines.push(
    indent + border(B.lj + hr(c1) + B.mm + hr(c2) + B.mm + hr(c3) + B.rj)
  );

  for (const e of entries) {
    const t = padEndVisible(e.type, wType);
    const p = padEndVisible(trunc(e.target, wPath), wPath);
    const w = padEndVisible(formatDate(e.createdAt), wWhen);
    lines.push(
      indent +
        border(B.v) +
        " " +
        t +
        " " +
        border(B.v) +
        " " +
        p +
        " " +
        border(B.v) +
        " " +
        w +
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
  printKvBox(
    "TLOCK STATUS",
    [
      [chalk.dim("Folders"), chalk.green(String(folderCount))],
      [chalk.dim("Apps"), chalk.green(String(appCount))],
      [chalk.dim("Total"), chalk.green(String(total))],
    ],
    { titleStyle: chalk.cyan }
  );
  console.log();
}

/**
 * Single-entry status (tlock status <path>).
 */
export function printEntryStatus(entry, formatDate) {
  const rows = [
    [chalk.dim("Type"), chalk.green(entry.type)],
    [chalk.dim("Locked at"), chalk.green(formatDate(entry.createdAt))],
  ];
  if (entry.dmgPath) {
    rows.push([chalk.dim("DMG"), chalk.dim(entry.dmgPath)]);
  }
  printKvBox("LOCK STATUS", rows, { titleStyle: chalk.cyan });
}
