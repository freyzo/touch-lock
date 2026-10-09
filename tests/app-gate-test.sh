#!/usr/bin/env bash
# Manual test for the app gate. Needs a locked app (default: Brave Browser) and you at the keyboard.
# Verifies:
# 1) approving Touch ID lets the app run
# 2) cancelling closes the app
# 3) if the gate crashes mid-prompt, the restarted gate asks again (the app is not left frozen)
# 4) if the gate is stopped mid-prompt, the app is closed
set -uo pipefail

# Usage: app-gate-test.sh [APP] [TEST...]   e.g. app-gate-test.sh "Brave Browser" 2
APP="${1:-Brave Browser}"
shift || true
ONLY=" ${*:-1 2 3 4} "
want() { [[ "$ONLY" == *" $1 "* ]]; }
SERVICE="gui/$(id -u)/com.freyzo.tlock.gate"
FAILED=0

app_pid() { pgrep -x "$APP" | head -1; }
gate_pid() { launchctl print "$SERVICE" 2>/dev/null | awk '/^\tpid =/{print $3}'; }
paused() { [ -n "$1" ] && ps -o stat= -p "$1" 2>/dev/null | grep -q T; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; FAILED=1; }

quit_app() {
  osascript -e "quit app \"$APP\"" 2>/dev/null
  for _ in $(seq 30); do [ -z "$(app_pid)" ] && return; sleep 0.5; done
  pkill -x "$APP"; sleep 2
  [ -z "$(app_pid)" ] || { echo "Could not quit $APP; quit it with Cmd+Q and rerun."; exit 1; }
}

# Launch the app and wait until the gate has paused it. Prints its pid.
launch_paused() {
  open -a "$APP"
  for _ in $(seq 30); do
    local pid; pid=$(app_pid)
    if paused "$pid"; then echo "$pid"; return; fi
    sleep 0.3
  done
}

# Wait until the app is running and not paused (approved), or gone (closed). Prints "running" or "closed".
wait_outcome() {
  for _ in $(seq "${1:-120}"); do
    local pid; pid=$(app_pid)
    if [ -z "$pid" ]; then echo closed; return; fi
    if ! paused "$pid"; then echo running; return; fi
    sleep 0.5
  done
  echo timeout
}

[ -n "$(gate_pid)" ] || { echo "The gate is not running. Run: node bin/tlock.js list"; exit 1; }

if want 1; then
echo "== 1) Approve"
quit_app
pid=$(launch_paused)
if [ -z "$pid" ]; then fail "$APP was not paused at launch"; else
  echo "  >> APPROVE the Touch ID prompt"
  outcome=$(wait_outcome)
  [ "$outcome" = running ] && pass "$APP opened after approval" || fail "expected the app to open, got: $outcome"
fi
fi

if want 2; then
echo "== 2) Cancel"
quit_app
pid=$(launch_paused)
if [ -z "$pid" ]; then fail "$APP was not paused at launch"; else
  echo "  >> click CANCEL on the prompt"
  outcome=$(wait_outcome)
  case "$outcome" in
    closed) pass "$APP was closed after cancel" ;;
    running)
      now=$(app_pid)
      if [ "$now" = "$pid" ]; then fail "$APP opened: the paused process (pid $pid) was resumed instead of closed"
      else fail "$APP opened: pid $pid was closed but a new $APP started (pid $now)"; fi
      echo "  Gate log:"; /usr/bin/log show --last 2m --predicate 'subsystem == "com.freyzo.tlock"' --style compact 2>/dev/null | grep -v "^Timestamp" | sed 's/^/    /'
      echo "  If the log says approved, Touch ID read a finger: click Cancel without touching the Touch ID key." ;;
    *) fail "no answer within 60s: $APP is still paused at the prompt" ;;
  esac
fi
fi

if want 3; then
echo "== 3) Gate crashes mid-prompt"
quit_app
pid=$(launch_paused)
if [ -z "$pid" ]; then fail "$APP was not paused at launch"; else
  old_gate=$(gate_pid)
  echo "  Killing the gate while the prompt is up. Do not touch the prompt yet."
  launchctl kill SIGKILL "$SERVICE"
  for _ in $(seq 40); do new_gate=$(gate_pid); [ -n "$new_gate" ] && [ "$new_gate" != "$old_gate" ] && break; sleep 0.5; done
  if [ -z "$new_gate" ] || [ "$new_gate" = "$old_gate" ]; then fail "gate did not restart"; else
    pass "gate restarted ($old_gate -> $new_gate)"
    echo "  >> A NEW prompt should appear. APPROVE it."
    outcome=$(wait_outcome)
    [ "$outcome" = running ] && pass "$APP opened after the restarted gate asked again" \
      || fail "expected the app to open, got: $outcome"
  fi
fi
fi

if want 4; then
echo "== 4) Gate stopped mid-prompt"
quit_app
pid=$(launch_paused)
if [ -z "$pid" ]; then fail "$APP was not paused at launch"; else
  echo "  Stopping the gate while the prompt is up. Do not touch the prompt."
  launchctl kill SIGTERM "$SERVICE"
  outcome=$(wait_outcome 20)
  [ "$outcome" = closed ] && pass "$APP was closed when the gate stopped" || fail "expected the app to close, got: $outcome"
fi
fi

quit_app
echo
[ "$FAILED" = 0 ] && echo "All app gate tests passed." || echo "Some app gate tests failed."
exit "$FAILED"
