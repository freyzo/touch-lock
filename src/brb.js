import { execFile } from "child_process";
import { lockAllFolders } from "./lock-folder.js";
import { helperBinary, secureEnclaveHelperFailure } from "./vault.js";
import { printResult, cmd, displayPath } from "./tui.js";

// Below this, a gap between time away and time awake is clock noise, not sleep.
const SLEEP_NOTICE_SECONDS = 30;

/** "45 s", "11 min", "1 h 5 min". */
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** Lock the screen through the helper; resolves with { away, asleep } in seconds once it is unlocked. */
function lockScreenUntilUnlocked(helper) {
  return new Promise((resolve, reject) => {
    execFile(helper, ["brb"], { encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || error.message;
        // Exit 5: the screen did lock, but stayed locked past the 12-hour limit.
        reject(new Error(error.code === 5
          ? `tlock brb stopped keeping the Mac awake: ${detail}`
          : `Could not lock the screen: ${detail}\nLock it with Control-Command-Q instead.`));
        return;
      }
      const [away, asleep] = stdout.trim().split(" ").map(Number);
      resolve({ away, asleep });
    });
  });
}

/**
 * Stepping away: lock tlock's open folders, then lock the screen like Control-Command-Q while keeping
 * the Mac awake, so apps, terminals and agents keep running. No app is paused, closed or changed.
 * Returns once the screen is unlocked.
 */
export async function brb() {
  const helper = helperBinary();
  if (!helper) {
    throw new Error(
      `tlock brb needs tlock's Swift helper, which could not be built: ${secureEnclaveHelperFailure()}\n` +
        "Lock the screen with Control-Command-Q instead."
    );
  }

  const { locked, busy } = lockAllFolders();
  for (const target of locked) printResult(`Locked ${displayPath(target)}`);
  for (const { target } of busy) {
    printResult(`${displayPath(target)} is in use, left open`, [
      `Files on it are open. The screen still locks; run ${cmd("tlock --all")} when you are back.`,
    ], "warn");
  }

  printResult("Locking the screen", ["Apps and agents keep running, and the Mac stays awake until you unlock."]);
  const { away, asleep } = await lockScreenUntilUnlocked(helper);

  if (asleep >= SLEEP_NOTICE_SECONDS) {
    printResult(`Back after ${formatDuration(away)}`, [
      `The Mac slept for ${formatDuration(asleep)} anyway, and work paused then. Closing the lid on battery always sleeps it.`,
    ], "warn");
  } else {
    printResult(`Back after ${formatDuration(away)}`);
  }
}
