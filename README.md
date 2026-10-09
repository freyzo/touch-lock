<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@freyzo/tlock@latest/assets/tlock-logo.webp" alt="tlock logo" width="140" />
</p>

<h1 align="center">tlock</h1>

<p align="center">
  <em>Lock folders and apps with Touch ID on macOS</em><br />
  <em>Encrypted disk images for folders, a launch gate for apps</em>
</p>

<p align="center">
  <a href="https://github.com/freyzo/touch-lock"><img src="https://img.shields.io/badge/tlock-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.npmjs.com/package/@freyzo/tlock"><img src="https://img.shields.io/badge/npm-@freyzo/tlock-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" /></a>
</p>

```bash
npm i -g @freyzo/tlock
```

---

## Problem

- Some folders (taxes, contracts, private notes) and some apps (a browser with your sessions, a chat app) should not be one click away for anyone who sits down at your unlocked Mac.
- macOS has the pieces (encrypted disk images, Touch ID) but no simple loop: **lock → unlock with your finger when needed → lock again when done**.
- And when you step away for ten minutes while agents, builds or terminals are running, you want everything locked **without stopping the work**.

## Why tlock

| Instead of | tlock gives you |
| --- | --- |
| Disk Utility images and passwords typed by hand | One command per step; Touch ID or your Mac password, with a recovery passphrase as backup |
| App lockers that patch or wrap the app | Apps are **never modified**: signatures, extensions and keychain items stay intact |
| A yes/no Touch ID check in front of a plain file | Real keys: a folder cannot be decrypted without the Secure Enclave (your finger or Mac password) or the recovery passphrase |
| Remembering to lock things again | Auto-lock on screen lock, sleep, idle, or a timer; `tlock brb` when you step away |

It is a deliberate, identity-checked step for a Mac you share a desk with. It is not protection against malware running as your user; see [Security model](#security-model).

## How it works

### System design

```
                                tlock CLI (Node.js)
               registry: ~/.tlock/config.json  ·  auto-lock watcher
               │                         │                         │
      folders  │                   apps  │                    brb  │
               ▼                         ▼                         ▼
    ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
    │ Swift helper         │  │ App gate             │  │ Swift helper         │
    │ Touch ID → Secure    │  │ LaunchAgent, watches │  │ locks the screen,    │
    │ Enclave → vault key  │  │ every app launch     │  │ keeps the Mac awake  │
    └──────────┬───────────┘  └──────────┬───────────┘  └──────────────────────┘
               ▼                         ▼
    per-image key → hdiutil   pause → Touch ID → resume or close
    AES-256 sparse bundle
```

### Folders

```
tlock ~/Taxes            copy into a new AES-256 sparse bundle, then wipe the original
tlock unlock ~/Taxes     Touch ID → vault key → image key → mounted again at ~/Taxes
tlock ~/Taxes            ejected (also: tlock --all, or auto-lock)
```

1. `hdiutil` creates an AES-256 encrypted, writable APFS sparse bundle (`~/.tlock/<name>-<hash>.sparsebundle`) with its own random key, and `ditto` copies the folder in. Only used space is stored, in 8 MB pieces, so Time Machine backs up just the pieces that changed.
2. The lock is registered, then every file in the original folder is overwritten with random bytes and the folder is removed.
3. `tlock unlock` attaches the image at the original path, hidden from the Desktop and Finder sidebar (`-nobrowse`); the folder opens normally from its own location.
4. `tlock <path>`, `tlock --all`, or auto-lock puts it away. Auto-lock never force-ejects: if files on the volume are in use, it shows a notification once and retries.

tlock refuses to lock `~/.tlock` or any folder containing it, a mounted volume, and folders inside or containing another locked folder.

### Apps

```
you open Brave → app gate sees the launch → pauses it → Touch ID / Mac password
                                                         ├─ pass   → app continues
                                                         └─ cancel → app is closed
```

1. `tlock "App Name"` records the app's bundle ID and starts tlock's **app gate**, a small background helper (`~/.tlock/gate-<hash>/tlock.app`, run by the LaunchAgent `~/Library/LaunchAgents/com.freyzo.tlock.gate.plist`). No file inside the app changes.
2. When a locked app starts, the gate pauses it at once and shows the prompt. If the gate itself restarts while an app waits, it asks again; if it is stopped, the waiting app is closed.
3. **Grace period:** after you pass the prompt, reopening the same app within 10 minutes of quitting it (or opening a second copy while it runs) does not ask again. It ends as soon as the screen locks, the Mac sleeps, or another user switches in, and it is kept only in the gate's memory.
4. Every decision is logged: `log show --predicate 'subsystem == "com.freyzo.tlock"'`.
5. When no app is locked, the LaunchAgent is removed.

### Stepping away (`tlock brb`)

```
tlock brb → lock open folders → lock the screen (same as Control-Command-Q) + keep the Mac awake
          … agents, builds and terminals keep running behind the lock screen …
unlock    → stop keeping the Mac awake → "Back after 11 min"
```

Nothing is paused, closed or changed. The Mac is kept from idle sleep for at most 12 hours, and only after the screen has really locked.

### Keys and authentication

- **Keys, not a yes/no check.** Each image has a random 256-bit key, sealed (AES-256-GCM) by a vault key. The vault key is derived from your recovery passphrase (scrypt) and also sealed to a **Secure Enclave** key created with `.userPresence`: the chip only releases it after Touch ID (any enrolled finger) or your Mac login password. Editing tlock's code or swapping its helper does not get anyone past that.
- **The prompt** is the standard macOS Touch ID sheet ("tlock is trying to unlock “folder”", or "open “App”"), with the tlock logo. It comes from a small Swift helper built once into `~/.tlock/helper-<hash>/tlock.app` with `swiftc`; if the selected Xcode cannot build (for example its license was not accepted after an update), tlock falls back to the Command Line Tools. If no helper can be built, tlock says why and uses the recovery passphrase.
- **Opening a locked app** is checked by the app gate with the same prompt (macOS LocalAuthentication); it decides whether the app may run, it does not decrypt anything.
- **Recovery passphrase** is asked for when the Secure Enclave is unavailable, or if you cancel the prompt. After 5 wrong passphrases, wait up to a minute. On a new Mac, one correct passphrase sets up Touch ID again.
- System tools are called by absolute path (`/usr/bin/hdiutil`, …), so a look-alike earlier in `PATH` is never run.

### Security model

- **Someone at your unlocked Mac with a terminal** cannot open a locked folder without your finger, your Mac login password, or the recovery passphrase. Nothing usable is stored in Keychain.
- **Not covered:** malware running as you can read a folder *while it is unlocked* (auto-lock keeps that window short), or tamper with tlock and capture a key the next time you authenticate. Only a separate macOS account plus FileVault protects against that.
- **The app gate is a deterrent, not a barrier:** someone at your unlocked Mac with a terminal can stop it (`launchctl bootout`), and the app's data in `~/Library` is not encrypted.
- **Copies made before locking** (Time Machine, APFS local snapshots, iCloud / Dropbox versions) still hold the plain folder. Overwriting files before deletion is best effort on SSDs and APFS. Turn on FileVault.
- **Shred** erases the image's keys and the key file, but copies of `~/.tlock` in backups can still be opened with your recovery passphrase.

### Limitations

- **macOS only** — `hdiutil`, `LocalAuthentication`, the Secure Enclave.
- **Apps the Mac needs** (Finder, Dock, System Settings) cannot be locked.
- **App updates** keep the lock: the gate matches the app's bundle ID, not its files.
- **Apps open at login or when you lock them** keep running; the gate asks the next time they start.
- **App window flash** — the gate pauses an app as soon as macOS reports it starting, so its window may show for a moment before the prompt.
- **Cloud folders** — locking a folder inside iCloud Drive / Dropbox deletes it from the cloud too.
- **Closing the lid on battery** always sleeps the Mac, which pauses running work even with `tlock brb`.

---

## Demo

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/demo.gif" alt="tlock CLI demo — lock, unlock, and list" width="640" />
</p>

---

## Usage

### Install

```bash
npm i -g @freyzo/tlock       # -g is needed for the tlock command
npx @freyzo/tlock --help     # or try it once without installing
```

Requires **macOS**, **Node.js ≥ 18**, and the **Xcode Command Line Tools** (`xcode-select --install`), which tlock uses once to build its small Swift helpers. The npm page sidebar shows `npm i @freyzo/tlock` without `-g`; that installs it locally and the `tlock` command may not be on your PATH.

### First run

The first lock asks you to create a **recovery passphrase** (12+ characters). It is never stored: day to day you unlock with Touch ID or your Mac login password, and the passphrase is the way back in on a new Mac or if the Secure Enclave key is lost. **Forget it and lose this Mac, and locked folders cannot be recovered.**

### Commands

| You want | Command |
| --- | --- |
| Lock a folder | `tlock /path/to/folder` |
| Open a locked folder | `tlock unlock /path` or `tlock -u /path` |
| Open it for a limited time | `tlock unlock /path --for 30m` |
| Put an open folder away again | `tlock /path` |
| Lock every open folder now | `tlock --all` or `tlock -a` |
| Lock an app | `tlock "Brave Browser"` |
| Open a locked app | `tlock -u "Brave Browser"` (or open it as usual) |
| Step away, keep agents running | `tlock brb` |
| Choose when things lock themselves | `tlock autolock` |
| Stop locking a folder (restore it) or an app | `tlock remove /path` or `tlock -r /path` |
| Destroy a locked folder for good | `tlock shred /path` or `tlock -s /path` |
| Forget a lock whose image or app is gone | `tlock remove --force /path` |
| List locks | `tlock list` |
| Summary, or one lock in detail | `tlock status` or `tlock status /path` (exit code 1 if not locked) |
| Forgot the recovery passphrase | `tlock reset` |
| Version / help | `tlock -v` / `tlock -h` (`tlock COMMAND -h` for one command) |

Targets are a folder path or an app name, in any capitalization; quotes around names with spaces are optional when the name matches a real folder or app. A folder named like a subcommand (`list`, `status`, `unlock`, `remove`, `shred`, `autolock`, `brb`, `reset`) must be passed as a path, e.g. `tlock ./list`. Typos get a suggestion (`tlock ~/Docments` → `Did you mean: tlock ~/Documents`).

### Folders, day to day

```bash
tlock ~/Documents/private-notes          # lock: the folder disappears, the data is encrypted
tlock -u ~/Documents/private-notes       # Touch ID, then use and change files as usual
tlock ~/Documents/private-notes          # done: put it away (or let auto-lock do it)
tlock -r ~/Documents/private-notes       # stop using tlock: restores a normal folder
tlock -s ~/Documents/private-notes       # or destroy it for good: nothing is restored
```

`shred` erases the image's keys (`hdiutil erasekeys`), overwrites the key file, deletes the image, and clears Quick Look thumbnails, Recents and the parent's `.DS_Store`.

### Apps

```bash
tlock "Brave Browser"                    # lock: asks for Touch ID from the next launch
tlock -r "Brave Browser"                 # stop locking it
tlock autolock --app-grace 5m            # grace period after quitting (default 10m, or off)
```

### Stepping away

```bash
tlock brb
```

Open folders are locked (one with files in use is left open, with a warning), the screen locks, and the Mac stays awake so agents and builds keep running. Unlock as usual; the terminal prints how long you were away and warns if the Mac slept anyway.

### Auto-lock

```bash
tlock autolock                     # show settings
tlock autolock --screen-lock on    # lock folders when the screen locks or another user switches in (default on)
tlock autolock --sleep on          # lock folders when the Mac sleeps (default on)
tlock autolock --idle 15m          # lock folders after 15 min without keyboard/mouse input (default 15m, or off)
tlock unlock <folder> --for 30m    # lock this folder again after 30 minutes (also 90s, 2h)
```

While a folder is open, a small background process (`tlock autolock-watch`) checks every 5 seconds and exits once nothing is open.

### Forgot the recovery passphrase

`tlock reset` asks you to type `reset`, then sets a new passphrase. Locked folders cannot be opened without the old one, so their images and keys are moved to `~/.tlock/reset-<time>/` (not deleted: moving them back recovers them if the old passphrase turns up) and their locks are forgotten. Locked apps stay locked.

### Upgrading from older versions

- **0.1.x:** after you create the recovery passphrase, existing folder locks are re-keyed automatically and the old master password is deleted from Keychain.
- **Folders locked before sparse bundles** (`~/.tlock/*.dmg`) open read-only; `*.sparseimage` locks keep working. `tlock -r ~/path`, then `tlock ~/path` moves either to the writable, backup-friendly format.
- **Apps locked by 0.2.0 or earlier** had their executable swapped for a wrapper script, which broke the signature (Chromium browsers such as Brave dropped their extensions). `tlock -r "App Name"` puts the original back; lock it again to use the gate.

### Files

| Item | Location |
| --- | --- |
| Lock registry and settings | `~/.tlock/config.json` |
| Encrypted images | `~/.tlock/*.sparsebundle` (older locks: `*.sparseimage`, `*.dmg`) |
| Per-image keys (sealed) | `~/.tlock/*.sparsebundle.key` — keep next to the image |
| Vault (sealed vault key, no passphrase) | `~/.tlock/vault.json` — rebuilt from the recovery passphrase if lost |
| Swift helper (Touch ID, brb) | `~/.tlock/helper-<hash>/tlock.app` |
| App gate (while an app is locked) | `~/.tlock/gate-<hash>/tlock.app`, `~/.tlock/locked-apps`, `~/Library/LaunchAgents/com.freyzo.tlock.gate.plist` |
| Folders set aside by `tlock reset` | `~/.tlock/reset-<time>/` |
| Auto-lock watcher | `~/.tlock/autolock.pid` (while a folder is open) |
| Failed password attempts | `~/.tlock/.auth-failures` |
| Transient | `~/.tlock/config.lock`, `~/.tlock/mount-*` |

### Testing

Manual round-trips against this checkout (run `npm install` first); both ask for Touch ID:

```bash
npm run test:pen     # folders: lock → path gone → unlock, read, write → lock again → remove restores every file → shred leaves nothing
npm run test:gate    # apps (default Brave Browser): approve, cancel, gate crash and stop mid-prompt, grace period
```

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
