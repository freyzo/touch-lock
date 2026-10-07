#!/usr/bin/env bash
set -euo pipefail

# Manual pen test for folder locking, run against this checkout (not a global install).
# Verifies:
# 1) `tlock <folder>` locks it and the original path disappears
# 2) `tlock unlock <folder>` restores the contents and the volume is writable
# 3) `tlock <folder>` while unlocked locks (ejects) it again
# 4) `tlock remove <folder>` brings back a normal folder with every file
# 5) `tlock shred <folder>` on a fresh lock leaves no folder, image, key file, or registry entry

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "ERROR: dependencies missing. Run npm install in $REPO_DIR first."
  exit 1
fi
tlock() { node "$REPO_DIR/bin/tlock.js" "$@"; }

ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$(mktemp -d "${ROOT%/}/tlock-pen-test.XXXXXX")"
TARGET="$TEST_DIR/secret-$(basename "$TEST_DIR")"
MARKER_FILE="$TARGET/proof.txt"
MARKER_VALUE="top-secret-$(date +%s)"
LOG="$TEST_DIR.log"

cleanup() {
  # Best-effort cleanup so a failed run leaves no lock behind.
  if tlock status "$TARGET" >/dev/null 2>&1; then
    echo "Cleaning up: removing the test lock (you may be prompted)."
    tlock remove "$TARGET" || true
  fi
  rm -rf "$TEST_DIR" "$LOG" || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*"
  exit 1
}

# Prompts stay visible; output is also saved to $LOG for checks.
run() { tlock "$@" 2>&1 | tee "$LOG"; }

mkdir -p "$TARGET"
printf "%s\n" "$MARKER_VALUE" > "$MARKER_FILE"

echo "== Step 1: lock folder =="
run "$TARGET" || fail "lock command failed."
grep -q "LOCKED FOLDER" "$LOG" || fail "lock command did not report success."
[ ! -e "$TARGET" ] || fail "locked folder path still exists on filesystem."
echo "PASS: direct path access is denied while locked."

echo "== Step 2: unlock, read, and write =="
run unlock "$TARGET" || fail "unlock command failed."
grep -q "UNLOCKED FOLDER" "$LOG" || fail "unlock command did not report success."
[ "$(cat "$MARKER_FILE" 2>/dev/null)" = "$MARKER_VALUE" ] || fail "marker file missing or changed after unlock."
echo "added while unlocked" > "$TARGET/added.txt" || fail "unlocked volume is not writable."
echo "PASS: contents intact and volume writable."

echo "== Step 3: lock again (eject) =="
run "$TARGET" || fail "re-lock command failed."
[ ! -e "$TARGET/added.txt" ] || fail "folder still readable after re-lock."
echo "PASS: re-lock put the volume away."

echo "== Step 4: remove lock and restore =="
run remove "$TARGET" || fail "remove command failed."
grep -q "RESTORED" "$LOG" || fail "remove command did not report success."
[ "$(cat "$MARKER_FILE" 2>/dev/null)" = "$MARKER_VALUE" ] || fail "marker file missing after remove."
[ -f "$TARGET/added.txt" ] || fail "file added while unlocked was lost."
! tlock status "$TARGET" >/dev/null 2>&1 || fail "lock still registered after remove."
echo "PASS: lock, unlock, re-lock, and remove round-trip verified."

echo "== Step 5: lock again, then shred =="
run "$TARGET" || fail "lock before shred failed."
run shred "$TARGET" || fail "shred command failed."
grep -q "SHREDDED" "$LOG" || fail "shred command did not report success."
[ ! -e "$TARGET" ] || fail "shredded folder path still exists."
! tlock status "$TARGET" >/dev/null 2>&1 || fail "lock still registered after shred."
if compgen -G "$HOME/.tlock/$(basename "$TARGET")-*" >/dev/null; then
  fail "image or key file left after shred."
fi
echo "PASS: shred left nothing behind."
