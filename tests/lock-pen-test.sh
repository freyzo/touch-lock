#!/usr/bin/env bash
set -euo pipefail

# Canonical manual pen test for folder locking behavior.
# Verifies:
# 1) `tlock <folder>` reports locked
# 2) direct access to original path fails while locked
# 3) `tlock unlock <folder>` restores access

if ! command -v tlock >/dev/null 2>&1; then
  echo "ERROR: tlock command not found in PATH."
  echo "Install first: npm install -g @freyzo/tlock"
  exit 1
fi

ROOT="${TMPDIR:-/tmp}"
TEST_DIR="$ROOT/tlock-pen-test-$RANDOM"
TARGET="$TEST_DIR/secret-folder"
MARKER_FILE="$TARGET/proof.txt"
MARKER_VALUE="top-secret-$(date +%s)"

cleanup() {
  # Best-effort cleanup so repeated test runs do not collide.
  if tlock status "$TARGET" >/dev/null 2>&1; then
    tlock remove "$TARGET" >/dev/null 2>&1 || true
  fi
  rm -rf "$TEST_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$TARGET"
printf "%s\n" "$MARKER_VALUE" > "$MARKER_FILE"

echo "== Step 1: lock folder =="
LOCK_OUT="$(tlock "$TARGET" 2>&1 || true)"
echo "$LOCK_OUT"
if ! printf "%s" "$LOCK_OUT" | rg -q "LOCKED FOLDER"; then
  echo "FAIL: lock command did not report success."
  exit 1
fi

echo "== Step 2: verify hard barrier while locked =="
if [ -e "$TARGET" ]; then
  echo "FAIL: locked folder path still exists on filesystem."
  exit 1
fi
if ls "$TARGET" >/dev/null 2>&1; then
  echo "FAIL: filesystem access unexpectedly succeeded while locked."
  exit 1
fi
echo "PASS: direct path access is denied while locked."

echo "== Step 3: unlock and verify access restored =="
echo "You may be prompted for Touch ID/password."
UNLOCK_OUT="$(tlock unlock "$TARGET" 2>&1 || true)"
echo "$UNLOCK_OUT"
if ! printf "%s" "$UNLOCK_OUT" | rg -q "UNLOCKED FOLDER"; then
  echo "FAIL: unlock command did not report success."
  exit 1
fi
if [ ! -f "$MARKER_FILE" ]; then
  echo "FAIL: marker file missing after unlock."
  exit 1
fi
if [ "$(cat "$MARKER_FILE")" != "$MARKER_VALUE" ]; then
  echo "FAIL: marker file content changed after lock/unlock."
  exit 1
fi
echo "PASS: lock barrier and unlock recovery verified."

echo "== Optional finalization =="
echo "Run this if you want to remove lock registry + DMG now:"
echo "  tlock remove \"$TARGET\""
