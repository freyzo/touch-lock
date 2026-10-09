import { execFileSync } from "child_process";
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { TLOCK_STORAGE_DIR, ensureStorageDir } from "./config.js";
import { BIN } from "./bins.js";

// VMK = scrypt(recovery passphrase), also sealed to a Secure Enclave key; each image key is sealed by the VMK.

const VAULT_FILE = join(TLOCK_STORAGE_DIR, "vault.json");
const KEY_SUFFIX = ".key";
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const VAULT_CHECK = Buffer.from("tlock-vault-check");
const SE_HKDF_INFO = Buffer.from("tlock-se-v1");

// ─── Sealing (AES-256-GCM) ──────────────────────────────────────────

function sealBox(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ciphertext.toString("base64"),
  };
}

/** Returns the plaintext, or null if the key is wrong or the box was tampered with. */
function openBox(key, box) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
  } catch {
    return null;
  }
}

function deriveFromPassphrase(passphrase, kdf) {
  return scryptSync(passphrase.normalize("NFC"), Buffer.from(kdf.salt, "base64"), 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function writeJsonAtomic(filePath, data) {
  ensureStorageDir();
  const tempFile = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempFile, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tempFile, filePath);
}

// ─── Secure Enclave helper (Swift) ──────────────────────────────────

const SE_HELPER_SOURCE = `
import CryptoKit
import Foundation
import IOKit.pwr_mgt
import LocalAuthentication
import Security

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(code)
}

func accessControl() -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error
    ) else {
        fail("access control: \\(String(describing: error))", 3)
    }
    return access
}

// tlock brb: lock the screen exactly like Control-Command-Q and keep the Mac from idle-sleeping until it is
// unlocked, so running work carries on. No app is touched. Prints "<seconds away> <seconds asleep>".
func brb() -> Never {
    typealias LockScreen = @convention(c) () -> Int32
    guard let login = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
          let lockSymbol = dlsym(login, "SACLockScreenImmediate") else {
        fail("the screen lock function is not available on this macOS", 3)
    }
    // Released automatically when this process exits, however it exits.
    var assertion = IOPMAssertionID(0)
    IOPMAssertionCreateWithName(
        "PreventUserIdleSystemSleep" as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "tlock brb: keeping work running while the screen is locked" as CFString, &assertion
    )

    let started = Date()
    let awakeAtStart = ProcessInfo.processInfo.systemUptime  // does not advance while the Mac sleeps
    var locked = false
    let center = DistributedNotificationCenter.default()
    center.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
        locked = true
    }
    center.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in
        let away = Date().timeIntervalSince(started)
        let asleep = max(0, away - (ProcessInfo.processInfo.systemUptime - awakeAtStart))
        print("\\(Int(away)) \\(Int(asleep))")
        exit(0)
    }
    _ = unsafeBitCast(lockSymbol, to: LockScreen.self)()
    // Never hold the Mac awake for a lock that did not happen, or for longer than a working day.
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
        if !locked { fail("the screen did not lock", 4) }
    }
    DispatchQueue.main.asyncAfter(wallDeadline: .now() + 12 * 3600) {
        fail("still locked after 12 hours; the Mac may sleep again", 5)
    }
    RunLoop.main.run()
    fail("stopped waiting for unlock", 3)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: create | derive <reason> | brb", 64) }
if args[1] == "brb" { brb() }
guard SecureEnclave.isAvailable else { fail("unavailable", 2) }

switch args[1] {
case "create":
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: accessControl())
        print(key.dataRepresentation.base64EncodedString())
        print(key.publicKey.x963Representation.base64EncodedString())
    } catch {
        fail("create: \\(error)", 3)
    }
case "derive":
    let lines = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
        .split(separator: "\\n").map(String.init)
    guard lines.count == 2,
          let blob = Data(base64Encoded: lines[0]),
          let peerData = Data(base64Encoded: lines[1]) else {
        fail("bad input", 64)
    }
    let context = LAContext()
    let semaphore = DispatchSemaphore(value: 0)
    var allowed = false
    context.evaluateAccessControl(
        accessControl(),
        operation: .useKeyKeyExchange,
        localizedReason: args.count > 2 ? args[2] : "unlock"
    ) { ok, _ in
        allowed = ok
        semaphore.signal()
    }
    semaphore.wait()
    guard allowed else { fail("denied", 1) }
    do {
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        let peer = try P256.KeyAgreement.PublicKey(x963Representation: peerData)
        let secret = try key.sharedSecretFromKeyAgreement(with: peer)
        print(secret.withUnsafeBytes { Data($0) }.base64EncodedString())
    } catch {
        fail("derive: \\(error)", 3)
    }
default:
    fail("unknown command", 64)
}
`;

// Bundled as tlock.app so the macOS Touch ID sheet says "tlock" and badges the fingerprint with the tlock logo.
const HELPER_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>tlock</string>
  <key>CFBundleIdentifier</key><string>com.freyzo.tlock</string>
  <key>CFBundleName</key><string>tlock</string>
  <key>CFBundleDisplayName</key><string>tlock</string>
  <key>CFBundleIconFile</key><string>tlock</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
// Shipped with the package, so the password dialog has the logo even before any helper app is built.
export const TLOCK_ICON = fileURLToPath(new URL("../assets/tlock.icns", import.meta.url));

const HELPER_DIR = join(
  TLOCK_STORAGE_DIR,
  `helper-${createHash("sha256").update(SE_HELPER_SOURCE).update(HELPER_INFO_PLIST).digest("hex").slice(0, 12)}`
);
const HELPER_APP = join(HELPER_DIR, "tlock.app");
const HELPER_BINARY = join(HELPER_APP, "Contents", "MacOS", "tlock");
const OLD_HELPER_PATTERN = /^(touchid-helper(-[0-9a-f]{12})?|helper-[0-9a-f]{12})$/;

let helperPath;
let helperFailure = null;

// The selected Xcode first; if it cannot build (e.g. its license was never accepted after an
// update), the Command Line Tools, which need no separate license step.
const SWIFT_DEVELOPER_DIRS = [null, "/Library/Developer/CommandLineTools"];

export function runSwiftc(args) {
  let lastError;
  for (const developerDir of SWIFT_DEVELOPER_DIRS) {
    if (developerDir && !existsSync(developerDir)) continue;
    try {
      execFileSync(BIN.swiftc, args, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 300_000,
        env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Why the Touch ID helper could not be built in this run, or null. */
export function secureEnclaveHelperFailure() {
  return helperFailure;
}

/** Path to tlock's Swift helper (Touch ID, brb), built on first use; null if it cannot be built. */
export function helperBinary() {
  if (helperPath === undefined) {
    helperPath = existsSync(HELPER_BINARY) ? HELPER_BINARY : compileHelper();
  }
  return helperPath;
}

export function buildIcon(icnsPath) {
  try {
    copyFileSync(TLOCK_ICON, icnsPath);
  } catch {
    // macOS falls back to a generic icon.
  }
}

function compileHelper() {
  ensureStorageDir();
  mkdirSync(HELPER_DIR, { recursive: true, mode: 0o700 });
  const tempApp = join(HELPER_DIR, `tlock.${process.pid}.app`);
  const contents = join(tempApp, "Contents");
  const srcFile = join(HELPER_DIR, `helper.${process.pid}.swift`);
  try {
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(join(contents, "Info.plist"), HELPER_INFO_PLIST);
    writeFileSync(srcFile, SE_HELPER_SOURCE, { mode: 0o600 });
    runSwiftc(["-o", join(contents, "MacOS", "tlock"), srcFile]);
    buildIcon(join(contents, "Resources", "tlock.icns"));
    try {
      execFileSync(BIN.codesign, ["--force", "--sign", "-", tempApp], { stdio: "ignore" });
    } catch {
      // The linker's ad-hoc signature on the binary still applies.
    }
    renameSync(tempApp, HELPER_APP);
  } catch (error) {
    rmSync(tempApp, { recursive: true, force: true });
    if (existsSync(HELPER_BINARY)) return HELPER_BINARY;
    const detail = String(error.stderr || error.message || "").trim().split("\n")[0];
    helperFailure = detail || "the Swift compiler is not available";
    return null;
  } finally {
    rmSync(srcFile, { force: true });
  }
  for (const name of readdirSync(TLOCK_STORAGE_DIR)) {
    const oldPath = join(TLOCK_STORAGE_DIR, name);
    if (OLD_HELPER_PATTERN.test(name) && oldPath !== HELPER_DIR) {
      rmSync(oldPath, { recursive: true, force: true });
    }
  }
  return HELPER_BINARY;
}

function secureEnclaveWrapKey(sharedSecret, ephemeralPublicKey) {
  return Buffer.from(hkdfSync("sha256", sharedSecret, ephemeralPublicKey, SE_HKDF_INFO, 32));
}

/**
 * Create a Secure Enclave key and seal the VMK to it. Sealing needs only the public key, so no prompt.
 * Returns null when the Secure Enclave or the Swift compiler is unavailable.
 */
function enrollSecureEnclave(vmk) {
  const helper = helperBinary();
  if (!helper) return null;
  let key, publicKey;
  try {
    [key, publicKey] = execFileSync(helper, ["create"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    }).trim().split("\n");
  } catch {
    return null;
  }
  const ephemeral = createECDH("prime256v1");
  const ephemeralPublicKey = ephemeral.generateKeys();
  const sharedSecret = ephemeral.computeSecret(Buffer.from(publicKey, "base64"));
  return {
    key,
    eph: ephemeralPublicKey.toString("base64"),
    ...sealBox(secureEnclaveWrapKey(sharedSecret, ephemeralPublicKey), vmk),
  };
}

// ─── Vault ──────────────────────────────────────────────────────────

export function vaultExists() {
  return existsSync(VAULT_FILE);
}

function readVault() {
  let vault;
  try {
    vault = readJson(VAULT_FILE);
  } catch (error) {
    throw new Error(`Cannot read ${VAULT_FILE} (${error.message}).`);
  }
  if (vault?.v !== 1 || !vault.kdf || !vault.check) {
    throw new Error(`${VAULT_FILE} is not a tlock vault.`);
  }
  return vault;
}

/**
 * Create the vault from a recovery passphrase. Pass kdf to rebuild it for existing key files.
 */
export function createVault(passphrase, kdf = { salt: randomBytes(16).toString("base64"), ...SCRYPT_PARAMS }) {
  const vmk = deriveFromPassphrase(passphrase, kdf);
  const vault = { v: 1, kdf, check: sealBox(vmk, VAULT_CHECK), se: enrollSecureEnclave(vmk) };
  writeJsonAtomic(VAULT_FILE, vault);
  return { vmk, secureEnclave: vault.se !== null };
}

function keyFiles() {
  if (!existsSync(TLOCK_STORAGE_DIR)) return [];
  return readdirSync(TLOCK_STORAGE_DIR)
    .filter((name) => name.endsWith(KEY_SUFFIX))
    .map((name) => join(TLOCK_STORAGE_DIR, name));
}

export function hasOrphanedKeys() {
  return keyFiles().length > 0;
}

/**
 * Move vault.json and every image key file into archiveDir, leaving no vault behind.
 * Returns the moved file names.
 */
export function archiveVault(archiveDir) {
  const files = [...(vaultExists() ? [VAULT_FILE] : []), ...keyFiles()];
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  for (const file of files) renameSync(file, join(archiveDir, file.slice(TLOCK_STORAGE_DIR.length + 1)));
  return files;
}

/**
 * Rebuild a lost vault.json from the passphrase and the kdf stored in each key file. Null if no key file opens.
 */
export function restoreVault(passphrase) {
  const triedSalts = new Set();
  for (const keyPath of keyFiles()) {
    let box;
    try { box = readJson(keyPath); } catch { continue; }
    if (!box?.kdf || triedSalts.has(box.kdf.salt)) continue;
    triedSalts.add(box.kdf.salt);
    if (openBox(deriveFromPassphrase(passphrase, box.kdf), box)) {
      return createVault(passphrase, box.kdf);
    }
  }
  return null;
}

/**
 * Open the vault with Touch ID or the Mac login password (Secure Enclave enforced).
 * Returns { vmk } or { status: "not-enrolled" | "unavailable" | "denied" | "broken" }.
 */
export function openVaultWithSecureEnclave(reason) {
  const vault = readVault();
  if (!vault.se) return { status: "not-enrolled" };
  const helper = helperBinary();
  if (!helper) return { status: "unavailable" };

  let sharedSecret;
  try {
    sharedSecret = execFileSync(helper, ["derive", reason], {
      input: `${vault.se.key}\n${vault.se.eph}\n`,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 120_000,
    }).trim();
  } catch (error) {
    if (error.signal || error.status === 1) return { status: "denied" };
    if (error.status === 2) return { status: "unavailable" };
    return { status: "broken" };
  }
  const wrapKey = secureEnclaveWrapKey(Buffer.from(sharedSecret, "base64"), Buffer.from(vault.se.eph, "base64"));
  const vmk = openBox(wrapKey, vault.se);
  return vmk ? { vmk } : { status: "broken" };
}

/**
 * Open the vault with the recovery passphrase. Returns the VMK, or null if the passphrase is wrong.
 */
export function openVaultWithPassphrase(passphrase) {
  const vault = readVault();
  const vmk = deriveFromPassphrase(passphrase, vault.kdf);
  return openBox(vmk, vault.check) ? vmk : null;
}

/**
 * Seal the VMK to a fresh Secure Enclave key (new Mac, reinstall, or first enrollment failed).
 */
export function refreshSecureEnclave(vmk) {
  const se = enrollSecureEnclave(vmk);
  if (!se) return false;
  writeJsonAtomic(VAULT_FILE, { ...readVault(), se });
  return true;
}

// ─── Per-image keys ─────────────────────────────────────────────────

export function imageKeyPath(imagePath) {
  return `${imagePath}${KEY_SUFFIX}`;
}

/**
 * Generate a random image passphrase, seal it with the VMK at keyPath, and return it.
 */
export function writeImageKey(keyPath, vmk) {
  const passphrase = randomBytes(32).toString("hex");
  writeJsonAtomic(keyPath, { v: 1, kdf: readVault().kdf, ...sealBox(vmk, Buffer.from(passphrase)) });
  return passphrase;
}

export function readImageKey(keyPath, vmk) {
  const passphrase = openBox(vmk, readJson(keyPath));
  if (!passphrase) {
    throw new Error(`${keyPath} was not sealed by this vault.`);
  }
  return passphrase.toString();
}
