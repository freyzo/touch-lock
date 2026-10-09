import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { TLOCK_STORAGE_DIR, ensureStorageDir, getLockRegistry } from "./config.js";
import { BIN } from "./bins.js";
import { buildIcon, runSwiftc } from "./vault.js";

// Locked apps are never modified. A LaunchAgent watches app launches; when a locked app starts,
// it is paused (SIGSTOP) until Touch ID or the Mac password succeeds, and closed otherwise.

const GATE_SOURCE = `
import AppKit
import LocalAuthentication
import os

let gateLog = Logger(subsystem: "com.freyzo.tlock", category: "gate")

let listPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
// Apps paused and waiting for Touch ID, so a restarted gate can ask again instead of leaving them frozen.
let heldPath = listPath + ".held"

func readLines(_ path: String) -> [String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
    return text.split(separator: "\\n").map(String.init)
}

func lockedBundleIDs() -> Set<String> {
    Set(readLines(listPath))
}

final class Gate {
    private var seen = Set<pid_t>()
    private var held = Set<pid_t>()
    private var observation: NSKeyValueObservation?
    private var termination: DispatchSourceSignal?

    func start() {
        // Apps already open when the gate starts (e.g. at login, or when the lock was added) keep running,
        // except ones a previous gate paused and never resolved.
        seen = Set(NSWorkspace.shared.runningApplications.map(\\.processIdentifier))
        let locked = lockedBundleIDs()
        for pid in readLines(heldPath).compactMap({ pid_t($0) }) {
            if let app = NSRunningApplication(processIdentifier: pid),
               let id = app.bundleIdentifier, locked.contains(id) {
                hold(app)
            }
        }
        saveHeld()
        observation = NSWorkspace.shared.observe(\\.runningApplications, options: [.new]) { [weak self] workspace, _ in
            self?.scan(workspace.runningApplications)
        }
        // Stopped mid-prompt (lock removed, gate updated): close paused apps rather than leave them frozen.
        signal(SIGTERM, SIG_IGN)
        termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination?.setEventHandler { [weak self] in
            self?.held.forEach { kill($0, SIGKILL) }
            try? FileManager.default.removeItem(atPath: heldPath)
            exit(0)
        }
        termination?.resume()
    }

    private func saveHeld() {
        let text = held.map(String.init).joined(separator: "\\n")
        try? text.write(toFile: heldPath, atomically: true, encoding: .utf8)
    }

    private func scan(_ apps: [NSRunningApplication]) {
        seen.formIntersection(Set(apps.map(\\.processIdentifier)))
        let locked = lockedBundleIDs()
        for app in apps where !seen.contains(app.processIdentifier) {
            seen.insert(app.processIdentifier)
            if let id = app.bundleIdentifier, locked.contains(id) { hold(app) }
        }
    }

    private func hold(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        kill(pid, SIGSTOP)
        held.insert(pid)
        saveHeld()
        let name = app.localizedName ?? "this app"
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "open \\u{201C}\\(name)\\u{201D}") { ok, error in
            let id = app.bundleIdentifier ?? name
            let outcome = ok ? "approved" : "denied (\\(error.map { String(describing: $0) } ?? "no error"))"
            gateLog.notice("\\(id, privacy: .public) pid \\(pid): \\(outcome, privacy: .public)")
            DispatchQueue.main.async {
                self.held.remove(pid)
                self.saveHeld()
                if ok {
                    kill(pid, SIGCONT)
                    app.activate()
                } else {
                    kill(pid, SIGKILL)
                }
            }
        }
    }
}

let gate = Gate()
gate.start()
NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
`;

const GATE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>tlock</string>
  <key>CFBundleIdentifier</key><string>com.freyzo.tlock.gate</string>
  <key>CFBundleName</key><string>tlock</string>
  <key>CFBundleDisplayName</key><string>tlock</string>
  <key>CFBundleIconFile</key><string>tlock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

const GATE_DIR = join(
  TLOCK_STORAGE_DIR,
  `gate-${createHash("sha256").update(GATE_SOURCE).update(GATE_INFO_PLIST).digest("hex").slice(0, 12)}`
);
const GATE_APP = join(GATE_DIR, "tlock.app");
const GATE_BINARY = join(GATE_APP, "Contents", "MacOS", "tlock");
const APP_LIST = join(TLOCK_STORAGE_DIR, "locked-apps");
const AGENT_LABEL = "com.freyzo.tlock.gate";
const AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
const SERVICE = `gui/${process.getuid()}/${AGENT_LABEL}`;

function buildGate() {
  ensureStorageDir();
  mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  const tempApp = join(GATE_DIR, `tlock.${process.pid}.app`);
  const contents = join(tempApp, "Contents");
  const srcFile = join(GATE_DIR, `gate.${process.pid}.swift`);
  try {
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), GATE_INFO_PLIST);
    writeFileSync(srcFile, GATE_SOURCE, { mode: 0o600 });
    runSwiftc(["-O", "-o", join(contents, "MacOS", "tlock"), srcFile]);
    buildIcon(join(contents, "Resources", "tlock.icns"));
    try {
      execFileSync(BIN.codesign, ["--force", "--sign", "-", tempApp], { stdio: "ignore" });
    } catch {
      // The linker's ad-hoc signature on the binary still applies.
    }
    renameSync(tempApp, GATE_APP);
  } catch (error) {
    rmSync(tempApp, { recursive: true, force: true });
    if (existsSync(GATE_BINARY)) return;
    const detail = String(error.stderr || error.message || "").trim().split("\n")[0];
    throw new Error(`Could not build tlock's app gate: ${detail || "the Swift compiler is not available"}`);
  } finally {
    rmSync(srcFile, { force: true });
  }
  for (const name of readdirSync(TLOCK_STORAGE_DIR)) {
    const oldPath = join(TLOCK_STORAGE_DIR, name);
    if (/^gate-[0-9a-f]{12}$/.test(name) && oldPath !== GATE_DIR) rmSync(oldPath, { recursive: true, force: true });
  }
}

function agentPlist() {
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(GATE_BINARY)}</string>
    <string>${escape(APP_LIST)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
}

function agentLoaded() {
  try {
    execFileSync(BIN.launchctl, ["print", SERVICE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

/** Unload the gate and wait until launchd has let go of it; bootstrap fails while it is still tearing down. */
function stopAgent() {
  try {
    execFileSync(BIN.launchctl, ["bootout", SERVICE], { stdio: "ignore" });
  } catch {
    // Not loaded.
  }
  for (let waited = 0; waited < 5_000 && agentLoaded(); waited += 100) sleepMs(100);
}

function readText(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function lockedBundleIds() {
  return getLockRegistry()
    .filter((entry) => entry.type === "app" && entry.bundleId)
    .map((entry) => entry.bundleId);
}

/**
 * Make the gate match the registry: running with the current list while any app is locked,
 * uninstalled when none is. Rebuilds the gate after a tlock update.
 */
export function syncAppGate() {
  gateRunning = undefined;
  const bundleIds = lockedBundleIds();
  if (bundleIds.length === 0) {
    stopAgent();
    rmSync(AGENT_PLIST, { force: true });
    rmSync(APP_LIST, { force: true });
    rmSync(`${APP_LIST}.held`, { force: true });
    return;
  }

  ensureStorageDir();
  const list = `${bundleIds.join("\n")}\n`;
  if (readText(APP_LIST) !== list) writeFileSync(APP_LIST, list, { mode: 0o600 });

  if (!existsSync(GATE_BINARY)) buildGate();
  const plist = agentPlist();
  if (readText(AGENT_PLIST) === plist && agentLoaded()) return;

  stopAgent();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(AGENT_PLIST, plist);
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(BIN.launchctl, ["bootstrap", `gui/${process.getuid()}`, AGENT_PLIST], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      return;
    } catch (error) {
      if (attempt < 3) {
        sleepMs(500);
        continue;
      }
      const detail = String(error.stderr || error.message || "").trim().split("\n")[0];
      throw new Error(`Could not start tlock's app gate: ${detail}`);
    }
  }
}

/** Cheap check for every tlock run: repair the gate if apps are locked but it is missing or stale. */
export function healAppGate() {
  try {
    if (lockedBundleIds().length === 0) return;
    // A failed start leaves the new plist in place, so also check that launchd actually has the gate.
    if (readText(AGENT_PLIST) === agentPlist() && existsSync(GATE_BINARY) && appGateRunning()) return;
    syncAppGate();
  } catch {
    // Reported by the command itself (e.g. an unreadable config), or when the user next locks or removes an app.
  }
}

let gateRunning;

/** True while the gate is installed and running. Checked once per run; syncAppGate refreshes it. */
export function appGateRunning() {
  gateRunning ??= existsSync(AGENT_PLIST) && agentLoaded();
  return gateRunning;
}
