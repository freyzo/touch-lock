# tlock

Lock folders and apps with Touch ID on macOS.

- **Folders** → encrypted into AES-256 DMG volumes, invisible until unlocked
- **Apps** → biometric gate required before every launch
- **Auth** → Touch ID first, password fallback, credentials in macOS Keychain

## Install

```bash
npm install -g @freyzo/tlock
```

Or use directly with npx:

```bash
npx @freyzo/tlock ~/Documents/secret
```

> Requires **macOS** and **Node.js ≥ 18**.

## Usage

### Lock a folder

```bash
tlock ~/Documents/private-notes
```

Creates an AES-256 encrypted DMG and removes the original folder. On first run you'll set a master password stored in macOS Keychain.
Lock now also prompts Touch ID/password before it proceeds.

### Lock an app

```bash
tlock Slack
# or
tlock /Applications/Slack.app
```

Intercepts the app binary so Touch ID is required before every launch.

### Unlock

```bash
tlock unlock ~/Documents/private-notes
tlock unlock Slack
# shorthand
tlock -u ~/Documents/private-notes
```

Folders are mounted at their original path. Apps launch after authentication.

### Permanently remove a lock

```bash
tlock remove ~/Documents/private-notes
tlock remove Slack
# shorthand
tlock -r ~/Documents/private-notes
```

Restores the original folder/app and removes all tlock metadata.

### List locked targets

```bash
tlock list
```

### Check status

```bash
tlock status                        # summary
tlock status ~/Documents/private-notes  # detail
```

## Canonical Pen Test

Run the security behavior test case:

```bash
npm run test:pen
```

This verifies a real lock/unlock round-trip:
- lock command reports success
- direct access to the original folder path fails while locked
- unlock restores access and original file contents

During the test you may see Touch ID/password prompts.

## How It Works

### Folders

1. `hdiutil create -encryption AES-256` packages the folder into an encrypted DMG
2. The original folder is deleted
3. On unlock, `hdiutil attach` mounts the DMG at the original path
4. When finished using the files, **eject** the volume in Finder — the data stays in the encrypted DMG; use `tlock unlock` again next time. Running `tlock <path>` again will error (already registered); use `tlock remove` only if you want a normal folder and to delete the DMG flow

### Apps

1. The app's main binary (from `CFBundleExecutable`) is renamed
2. A wrapper script is installed that calls `tlock auth-gate` before launching
3. `auth-gate` triggers Touch ID (or password fallback)
4. On success, the original binary is `exec`'d with all arguments

### Authentication

1. **Touch ID** via Apple's `LocalAuthentication` framework (`LAContext`)
2. **Password fallback** if Touch ID is unavailable or fails
3. Master password stored in **macOS Keychain** via the `security` CLI

## Config

Lock registry is stored at `~/.tlock/config.json`. DMG volumes are stored in `~/.tlock/`.

## Limitations

- **macOS only** — relies on `hdiutil`, `security`, and `LocalAuthentication`
- **SIP** — cannot lock system apps in `/System/Applications`
- **Code signing** — app binary rename may invalidate signatures; some apps may need re-allow in Gatekeeper
- **macOS updates** — app updates may overwrite the wrapper script; re-run `tlock` after updating
- **Finder visibility** — unlocked DMG volumes appear in Finder sidebar; **eject** when done (you do not run `tlock` on that path again until `tlock remove`)
- **Global install recommended** — `auth-gate` subcommand must resolve from the wrapper script; `npx` temp installs may not persist

## Security Notes

- Master password never leaves the local Keychain
- DMG encryption uses macOS-native AES-256 (UDZO format)
- Touch ID authentication uses the Secure Enclave — biometric data never leaves the chip
- The wrapper script is a plain shell script; a determined user with admin access can bypass it
- Folder locking (encrypted DMG) is significantly stronger than app locking (binary rename)

