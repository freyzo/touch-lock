<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@freyzo/tlock@latest/assets/tlock-logo.webp" alt="tlock logo" width="140" />
</p>

<h1 align="center">tlock</h1>

<p align="center">
  <em>Lock folders and apps with Touch ID on macOS</em><br />
  <em>Encrypted disk images for folders, a launch gate for apps</em>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/macos.png" alt="macOS" height="28" />
  <a href="https://github.com/freyzo/touch-lock"><img src="https://img.shields.io/badge/tlock-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" /></a>
  <a href="https://www.npmjs.com/package/@freyzo/tlock"><img src="https://img.shields.io/badge/npm-@freyzo/tlock-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npm" /></a>
</p>

```bash
npm i -g @freyzo/tlock
```

Needs macOS, Node.js 18+ and the Xcode Command Line Tools (`xcode-select --install`).

---

## Problem

Anyone who sits down at your unlocked Mac can open your private folders and apps. And when you step away while agents or builds are running, you want everything locked without stopping the work.

## Why tlock

- **Real encryption, not just a prompt.** A locked folder becomes an AES-256 disk image whose key only the Secure Enclave releases, after Touch ID or your Mac password.
- **Apps are never modified.** A small gate pauses a locked app at launch until you pass Touch ID.
- **It locks itself again** on screen lock, sleep or idle, and `tlock brb` locks everything when you step away.

## How it works

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/tlock-system-design.svg" alt="tlock system design: the CLI hands folders to the Swift helper (Touch ID, Secure Enclave, vault key, then the per-image key opens the AES-256 sparse bundle), apps to the app gate (pause, Touch ID, then resume or close), and brb to the Swift helper (lock the screen, keep the Mac awake)" width="760" />
</p>

## Demo

<p align="center">
  <img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/demo.gif" alt="tlock CLI demo — lock, unlock, and list" width="640" />
</p>

## Usage

| You want | Command |
| --- | --- |
| Lock a folder or an app | `tlock ~/Taxes` · `tlock "Brave Browser"` |
| Open it | `tlock -u ~/Taxes` |
| Open it for 30 minutes | `tlock -u ~/Taxes --for 30m` |
| Lock it again, or every open folder | `tlock ~/Taxes` · `tlock -a` |
| Step away, keep agents running | `tlock brb` |
| Auto-lock and app grace settings | `tlock autolock` |
| Remove the lock (restores the folder) | `tlock -r ~/Taxes` |
| Destroy a locked folder for good | `tlock -s ~/Taxes` |
| See what is locked | `tlock list` |
| Forgot the recovery passphrase | `tlock reset` |

`tlock -h` lists everything.

**Before you start**

- Your first lock asks for a **recovery passphrase**. Touch ID unlocks day to day; the passphrase is your way back in on a new Mac. Forget it and lose this Mac, and locked folders cannot be recovered.
- Locking a folder inside iCloud Drive or Dropbox deletes it from the cloud too.
- Backups made before locking (Time Machine, snapshots) still hold the plain files. Turn on FileVault.
- The app gate is a deterrent: someone with a terminal on your unlocked Mac can stop it. Folders are truly encrypted.

---

## Contact

<p align="center">
  <a href="https://www.linkedin.com/in/freya-zou-068615252/" title="LinkedIn Freya Zou"><img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/social/linkedin.svg" alt="LinkedIn Freya Zou" width="44" height="44" /></a>&nbsp;&nbsp;
  <a href="https://www.youtube.com/channel/UC9pdMpmZ6ZNAakfcZSxaJXQ" title="YouTube"><img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/social/youtube.svg" alt="YouTube" width="44" height="44" /></a>&nbsp;&nbsp;
  <a href="https://freyazou.com" title="freyazou.com"><img src="https://raw.githubusercontent.com/freyzo/touch-lock/main/assets/social/site.svg" alt="freyazou.com" width="44" height="44" /></a>
</p>
