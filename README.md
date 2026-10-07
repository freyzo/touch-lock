<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@freyzo/tlock@latest/assets/tlock-logo.webp" alt="tlock logo" width="140" />
</p>

<h1 align="center">tlock</h1>

<p align="center">
  <em>Lock folders and apps with Touch ID on macOS</em><br />
  <em>Encrypted disk images for folders, biometric gate for apps</em>
</p>

<p align="center">
  <a href="https://github.com/freyzo/touch-lock"><img src="https://img.shields.io/badge/tlock-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.npmjs.com/package/@freyzo/tlock"><img src="https://img.shields.io/badge/npm-@freyzo/tlock-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" /></a>
</p>

**Install the CLI globally** so `tlock` is on your PATH:

`npm i -g @freyzo/tlock`

The npm package page sidebar often shows `npm i @freyzo/tlock` (local install). For this tool you want **`-g`**; otherwise the `tlock` command may not be available in your shell.

---

## About

**Problem**

- You want **local** protection for sensitive folders and apps without juggling Disk Utility every time.
- You want a deliberate, **identity-checked** step (Touch ID) before a sensitive folder appears on disk or a sensitive app opens. This is not a defense against malware running as your user; see [Security notes](#security-notes).
- You need a **simple loop**: lock → unlock when needed → lock again when done → data stays in an encrypted volume until next unlock.

**Solution**

- **`tlock`** is one CLI:
  - **Folders** → AES-256 encrypted, writable disk image; plain folder removed after the image is created and registered.
  - **Apps** → wrapper + renamed binary so **Touch ID / password** runs before launch.
- **Lock, unlock, and remove** go through **authentication** (Touch ID first, Keychain-backed password fallback). Putting an unlocked folder away again needs none, since it only removes access.
- Short flags: **`-u`** unlock, **`-r`** remove (same as `unlock` / `remove`).

**Summary**

| You want | Command |
| --- | --- |
| First-time lock folder | `tlock /path/to/folder` |
| First-time lock app | `tlock Slack` or `tlock /Applications/Slack.app` |
| Open locked folder | `tlock unlock /path` or `tlock -u /path` |
| Put an unlocked folder away again | `tlock /path` (or eject it in Finder) |
| Stop using tlock on folder (restore normal folder) | `tlock remove /path` or `tlock -r /path` |
| Forget a lock whose image or app is gone | `tlock remove --force /path` |
| List locks | `tlock list` |
| Summary / detail | `tlock status` or `tlock status /path` |

> Requires **macOS** (darwin) and **Node.js ≥ 18**.

---

## Install

Use **global** install (required for the `tlock` command):

```bash
npm i -g @freyzo/tlock
```

Or one-off (folders only — app locking needs the global install):

```bash
npx @freyzo/tlock --help
```

---

## Usage

### Main command (lock)

```bash
tlock [target]
```

| Arg | Description |
| --- | --- |
| `target` | Folder path or app name / `.app` path to lock. Auto-detects folder vs app. Run it again on an unlocked folder to lock it again. |

**First run:** you create a **master password** (stored in macOS Keychain). Lock still asks for **Touch ID / password** before encrypting.

A folder named like a subcommand (`list`, `status`, `unlock`, `remove`) must be passed as a path, e.g. `tlock ./list`.

### Unlock / remove (long or short)

```bash
tlock unlock <target>     # or:  tlock -u <target>
tlock remove <target>     # or:  tlock -r <target>
```

| Command | Description |
| --- | --- |
| `unlock` / `-u` | Folder: authenticate, then mount its image at the original path. App: open it; its wrapper asks for Touch ID / password. |
| `remove` / `-r` | Authenticate, restore normal folder or app binary, delete the image / wrapper. `--force` forgets a lock whose image or app binary is missing. |

### Other commands

```bash
tlock list
tlock status              # counts
tlock status <target>     # one entry + image path; exit code 1 if not locked
tlock --help
```

### Examples

```bash
# Folder
tlock ~/Documents/private-notes
tlock unlock ~/Documents/private-notes
tlock -u ~/Documents/private-notes
tlock ~/Documents/private-notes          # while unlocked: lock it again

# App
tlock Slack
tlock /Applications/Slack.app
tlock unlock Slack

# Drop tlock for a folder permanently (restores plain folder)
tlock remove ~/Documents/private-notes
tlock -r ~/Documents/private-notes
```

### Everyday folder loop

1. `tlock unlock ~/path` (or `tlock -u ~/path`) — use files.
2. Add/change files while unlocked; the volume is writable and grows as needed.
3. `tlock ~/path` when finished (or eject the volume in Finder) — path disappears; data stays in `~/.tlock/*.sparseimage`.
4. Next time: `tlock unlock` again.

Locks made by older tlock versions (`~/.tlock/*.dmg`) open read-only. To make one writable: `tlock remove ~/path`, then `tlock ~/path`.

---

## Demo

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/demo.gif" alt="tlock CLI demo — lock, unlock, and list" width="640" />
</p>

## Testing

Security round-trip against this checkout (run `npm install` first):

```bash
npm run test:pen
```

Checks: lock succeeds → **path gone** while locked → unlock → file contents match and the volume is writable → lock again → remove restores every file. You'll be asked to authenticate three times.

---

## How it works

### Folders

1. `hdiutil` creates an AES-256 encrypted, writable APFS sparse image (`~/.tlock/<name>-<hash>.sparseimage`, only used space is stored) and `ditto` copies the folder in.
2. The lock is registered, then the original folder is removed.
3. `tlock unlock` attaches the image at the original path.
4. `tlock <path>` (or eject in Finder) puts it away; the encrypted image stays under `~/.tlock/`.

tlock refuses to lock `~/.tlock` or any folder containing it, a mounted volume, and folders inside or containing another locked folder.

### Apps

1. `CFBundleExecutable` binary renamed to `<name>.tlock-original`; bash wrapper installed in its place.
2. Wrapper runs hidden `tlock auth-gate` with the Node.js and tlock paths recorded at lock time → Touch ID, or the master password (terminal prompt, or a macOS dialog when launched from Finder / Dock) → `exec` real binary.
3. `tlock unlock <app>` just opens the app; the wrapper asks.
4. Run `tlock <app>` again to repair the wrapper (e.g. after Node.js moved) or to re-apply the lock after an app update.

### Authentication

- **Touch ID** via `LocalAuthentication`: a small Swift helper compiled once to `~/.tlock/touchid-helper-<hash>` (falls back to `swift -e` if `swiftc` is missing).
- **Password** fallback vs Keychain item `service=tlock`, `account=master`. After 5 wrong passwords, wait up to a minute.

---

## Config

| Item | Location |
| --- | --- |
| Lock registry | `~/.tlock/config.json` |
| Encrypted images | `~/.tlock/*.sparseimage` (older locks: `*.dmg`) |
| Master password | macOS Keychain (`tlock` / `master`) |
| Touch ID helper | `~/.tlock/touchid-helper-<hash>` |
| Failed password attempts | `~/.tlock/.auth-failures` |
| Registry write lock | `~/.tlock/config.lock` (transient) |
| Temporary mount points | `~/.tlock/mount-*` (transient) |

---

## Limitations

- **macOS only** — `hdiutil`, `security`, `LocalAuthentication`.
- **SIP** — cannot lock apps under `/System/Applications`.
- **App lock** — renaming binary can break code signing / Gatekeeper for some apps.
- **App Management** (macOS 13+) — allow your terminal under System Settings → Privacy & Security → App Management, or app locking is denied. Apps owned by root (e.g. some App Store apps) can't be locked.
- **App updates** replace the wrapper; run `tlock <app>` again to re-apply the lock.
- **Global install required** for app locking (the wrapper records tlock's path; the `npx` cache is temporary).
- **Cloud folders** — locking a folder inside iCloud Drive / Dropbox deletes it from the cloud too.

---

## Security notes

- Folder images use native AES-256 encryption (`hdiutil`); the password is the tlock master password.
- Touch ID uses Secure Enclave — template data does not leave the chip.
- **Same-user processes are not kept out.** The master password lives in your login Keychain, and any process running as you can read it with `security find-generic-password` without a prompt, then mount an image directly. Touch ID gates tlock's own commands only. A process running as you could also replace `~/.tlock/touchid-helper-*`.
- **App wrapper** is not a kernel barrier; admin or determined local attacker may bypass.
- **Folder images** are much stronger than app rename/wrapper.

---

## Contact

<!-- Custom CSS “pills” get stripped on github.com — badge images render the same everywhere (GitHub, npm, VS Code preview). -->

<p align="center">
  <a href="https://x.com/freyazou"><img src="https://img.shields.io/badge/X-%40freyazou-1a1a1a?style=plastic&logo=x&logoColor=white" alt="X @freyazou" /></a>
  &nbsp;
  <a href="https://github.com/freyzo/touch-lock"><img src="https://img.shields.io/badge/GitHub-touch--lock-24292f?style=plastic&logo=github&logoColor=white" alt="GitHub" /></a>
  &nbsp;
  <a href="https://www.linkedin.com/in/freya-zou-068615252/"><img src="https://img.shields.io/badge/LinkedIn-Freya_Zou-0A66C2?style=plastic&logo=linkedin&logoColor=white" alt="LinkedIn" /></a>
  <br /><br />
  <a href="https://www.youtube.com/channel/UC9pdMpmZ6ZNAakfcZSxaJXQ"><img src="https://img.shields.io/badge/YouTube-channel-FF0000?style=plastic&logo=youtube&logoColor=white" alt="YouTube" /></a>
  &nbsp;
  <a href="https://freyazou.com"><img src="https://img.shields.io/badge/Site-freyazou.com-0891b2?style=plastic&logo=googlechrome&logoColor=white" alt="Website" /></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@freyzo/tlock"><img src="https://img.shields.io/badge/npm-%40freyzo%2Ftlock-CB3837?style=plastic&logo=npm&logoColor=white" alt="npm" /></a>
</p>
