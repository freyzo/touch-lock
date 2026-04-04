<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@freyzo/tlock@latest/assets/tlock-logo.webp" alt="tlock logo" width="140" />
</p>

<h1 align="center">tlock</h1>

<p align="center">
  <em>Lock folders and apps with Touch ID on macOS</em><br />
  <em>Encrypted DMGs for folders, biometric gate for apps</em>
</p>

<p align="center">
  <a href="https://github.com/freyzo/touch-lock"><img src="https://img.shields.io/badge/tlock-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.npmjs.com/package/@freyzo/tlock"><img src="https://img.shields.io/badge/npm-@freyzo/tlock-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" /></a>
</p>

## About

**Problem**

- You want **local** protection for sensitive folders and apps without juggling Disk Utility every time.
- Scripts and agents can touch your filesystem — you want **identity-checked** actions before data is moved into encrypted storage.
- You need a **simple loop**: lock → unlock when needed → eject when done → data stays in an encrypted volume until next unlock.

**Solution**

- **`tlock`** is one CLI:
  - **Folders** → AES-256 encrypted DMG, plain folder removed after successful create.
  - **Apps** → wrapper + renamed binary so **Touch ID / password** runs before launch.
- **Lock, unlock, and remove** all go through **authentication** (Touch ID first, Keychain-backed password fallback).
- Short flags: **`-u`** unlock, **`-r`** remove (same as `unlock` / `remove`).

**Summary**

| You want | Command |
| --- | --- |
| First-time lock folder | `tlock /path/to/folder` |
| First-time lock app | `tlock Slack` or `tlock /Applications/Slack.app` |
| Open locked folder | `tlock unlock /path` or `tlock -u /path` |
| Stop using tlock on folder (restore normal folder) | `tlock remove /path` or `tlock -r /path` |
| List locks | `tlock list` |
| Summary / detail | `tlock status` or `tlock status /path` |

> Requires **macOS** (darwin) and **Node.js ≥ 18**.

---

## Install

```bash
npm i -g @freyzo/tlock
```

Or one-off:

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
| `target` | Folder path or app name / `.app` path to lock. Auto-detects folder vs app. |

**First run:** you create a **master password** (stored in macOS Keychain). Lock still asks for **Touch ID / password** before encrypting.

### Unlock / remove (long or short)

```bash
tlock unlock <target>     # or:  tlock -u <target>
tlock remove <target>     # or:  tlock -r <target>
```

| Command | Description |
| --- | --- |
| `unlock` / `-u` | Authenticate, then mount folder DMG at original path or launch gated app flow. |
| `remove` / `-r` | Authenticate, restore normal folder or app binary, delete DMG / wrapper metadata. |

### Other commands

```bash
tlock list
tlock status              # counts
tlock status <target>     # one entry + DMG path
tlock --help
```

### Examples

```bash
# Folder
tlock ~/Documents/private-notes
tlock unlock ~/Documents/private-notes
tlock -u ~/Documents/private-notes

# App
tlock Slack
tlock /Applications/Slack.app
tlock unlock Slack

# Drop tlock for a folder permanently (restores plain folder)
tlock remove ~/Documents/private-notes
tlock -r ~/Documents/private-notes
```

### Everyday folder loop (no second `tlock` lock)

1. `tlock unlock ~/path` (or `tlock -u ~/path`) — use files.
2. Add/change files while mounted.
3. **Eject** the volume in Finder when finished — path disappears; data stays in `~/.tlock/*.dmg`.
4. Next time: `tlock unlock` again.  
   Do **not** run `tlock ~/path` again for the same registered lock — use **eject**, not a second lock.

---

## Demo

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/demo.gif" alt="tlock CLI demo — lock, unlock, and list" width="640" />
</p>

## Testing

Canonical security round-trip (repo clone):

```bash
npm run test:pen
```

Checks: lock succeeds → **direct path access denied** while locked → unlock → file contents match.

---

## How it works

### Folders

1. `hdiutil create -encryption AES-256` builds encrypted DMG from folder.
2. Original folder is removed after DMG exists.
3. `tlock unlock` attaches DMG at the original path.
4. **Eject** = put away; encrypted blob stays under `~/.tlock/`.

### Apps

1. `CFBundleExecutable` binary renamed; bash wrapper installed in its place.
2. Wrapper calls hidden `tlock auth-gate` → Touch ID / password → `exec` real binary.

### Authentication

- **Touch ID** via `LocalAuthentication` (Swift one-liner).
- **Password** fallback vs Keychain item `service=tlock`, `account=master`.

---

## Config

| Item | Location |
| --- | --- |
| Lock registry | `~/.tlock/config.json` |
| Encrypted DMGs | `~/.tlock/*.dmg` |
| Master password | macOS Keychain (`tlock` / `master`) |

---

## Limitations

- **macOS only** — `hdiutil`, `security`, `LocalAuthentication`.
- **SIP** — cannot lock apps under `/System/Applications`.
- **App lock** — renaming binary can break code signing / Gatekeeper for some apps.
- **App updates** may overwrite wrapper; re-apply lock after update if needed.
- **Global install recommended** for app wrapper (`auth-gate` path).

---

## Security notes

- Master password stays in Keychain; DMG uses native AES-256 (UDZO).
- Touch ID uses Secure Enclave — template data does not leave the chip.
- **App wrapper** is not a kernel barrier; admin or determined local attacker may bypass.
- **Folder DMG** is much stronger than app rename/wrapper.

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
