#!/usr/bin/env node
'use strict';

// rustdrift-ci — self-contained, dependency-free (Node 18+, no npm install).
// Checks whether the Rust version your team THINKS the project targets agrees across every
// place a Rust project can declare one: rust-toolchain.toml (or the legacy, extension-less
// rust-toolchain file)'s "channel" field, Cargo.toml's "rust-version" field (a required
// MINIMUM version, not an exact pin — doc.rust-lang.org/cargo/reference/rust-version.html),
// any Dockerfile's "FROM rust:X.Y", and any GitHub Actions workflow's "toolchain:" input on a
// dtolnay/rust-toolchain or actions-rs/toolchain step (confirmed from dtolnay/rust-toolchain's
// own action.yml and README — unlike setup-go/setup-python/setup-java there is no single
// "rust-version:" key; the version lives under a scoped "toolchain:" input instead). Each of
// these is edited by a different person at a different time, so they drift silently — the
// same "works in CI, breaks in the Docker image" (or the reverse) bug this lane already
// shipped for Node, Python, Go, Ruby and Java, ported to Rust's own files.
//
// Real nuance this ecosystem has that none of the five prior siblings needed: "channel" (in
// rust-toolchain.toml/rust-toolchain, or in a workflow's "toolchain:" input) is NOT always a
// version — it can legitimately be the channel name "stable"/"beta"/"nightly" (optionally
// dated, e.g. "nightly-2026-01-10"), per rustup's own toolchain-specification grammar. A
// channel name is not comparable to a version number, so it is recorded but excluded from
// every comparison — never flagged as drift, the same way this lane's rubydrift-ci excludes a
// Gemfile's "ruby file: '.ruby-version'" delegation rather than comparing it to itself.
//
// FREE: compares rust-toolchain(.toml)'s channel (only if it is a real version, not a channel
//       name) against Cargo.toml's rust-version floor. No key needed.
// PRO: also scans every Dockerfile and GitHub Actions workflow in the repo and cross-checks
//      every source against every other source. Unlocked by a valid offline license key — no
//      network call, no account, no phone-home.
//
// Usage:
//   node cli.js check [--dir <path>] [--json]
//
// Exit codes:
//   0 - no drift found
//   1 - a drift finding exists (any rule)
//   2 - configuration/usage error (--dir does not exist or is not a directory)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — same chassis as every other D-lane standalone
// CLI, including the canonical-base64url round-trip check from the first line (the tamper-
// bypass coin-flip bug this lane found and fixed 2026-09-07, re-introduced once in
// localbolt-ci before being caught 2026-10-13, ported in from day one on every build since).
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE44FpeKiXl69FBlOxp57xqD+zhOsuaqht2hIp6v+rEhdOypbbTmbPzYpLLkHWR9D9k2Sragedrlcn4eePwPypHw==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'rustdrift-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'RS1') return false;
    const signedData = `RS1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.RUSTDRIFT_KEY) return process.env.RUSTDRIFT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.rustdrift', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function hasPro() {
  const key = readLicenseKey();
  return !!(key && verifyLicense(key));
}

// ---------------------------------------------------------------------------------------
// Version-source parsing — Rust versions are compared at MAJOR.MINOR granularity (1.75 vs
// 1.78 matter — new language features land on minor releases; a patch, e.g. 1.75.0 vs
// 1.75.2, is a bugfix-only release and never changes compatibility, same boundary Go uses).
// Every version is folded into a single comparable integer key: major*100 + minor.
// ---------------------------------------------------------------------------------------

// First "X.Y" (or "X.Y.Z", patch ignored) pair anywhere in a string -> integer key, or null.
// Used for Dockerfile tags, which carry surrounding text ("1.75-slim-bookworm").
function parseVersionKey(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

// Strict bare-version check for rust-toolchain.toml's channel and Cargo.toml's rust-version:
// both reject anything that isn't a plain major[.minor[.patch]] number (no operators, no
// prerelease, no channel words) per their own primary-source grammars. Returns the integer
// key, or null if `s` is not a bare version (e.g. "stable", "nightly-2026-01-10", "beta").
function bareVersionKey(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d+)(?:\.(\d+))?(?:\.\d+)?$/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = m[2] !== undefined ? parseInt(m[2], 10) : 0;
  return major * 100 + minor;
}

function keySatisfiesRange(key, range) {
  if (key == null || !range) return true;
  if (range.exact != null) return key === range.exact;
  if (range.min != null && key < range.min) return false;
  if (range.max != null && key >= range.max) return false;
  return true;
}

// rust-toolchain.toml's [toolchain] "channel" field (rust-lang.github.io/rustup/overrides.html),
// or the legacy, extension-less "rust-toolchain" file that holds only the toolchain spec as its
// first line (the .toml form is preferred when both exist, matching rustup's own precedence).
// "channel" can be a bare version ("1.75", "1.75.2" — comparable) or a channel name
// ("stable"/"beta"/"nightly", optionally dated, e.g. "nightly-2026-01-10" — NOT comparable,
// per the grammar `<channel> = stable|beta|nightly|<versioned>[-<prerelease>]`).
function readRustToolchain(rootDir) {
  const tomlPath = path.join(rootDir, 'rust-toolchain.toml');
  const legacyPath = path.join(rootDir, 'rust-toolchain');
  let raw = null;
  if (fs.existsSync(tomlPath)) {
    const text = fs.readFileSync(tomlPath, 'utf8');
    const m = text.match(/channel\s*=\s*"([^"]+)"/);
    if (m) raw = m[1];
  } else if (fs.existsSync(legacyPath)) {
    const text = fs.readFileSync(legacyPath, 'utf8').trim();
    if (text) raw = text.split('\n')[0].trim();
  }
  if (raw == null) return null;
  const key = bareVersionKey(raw);
  return { raw, key, channel: key == null };
}

// Cargo.toml's "rust-version" field declares a required MINIMUM version (MSRV), never an exact
// pin or an upper bound — confirmed from doc.rust-lang.org/cargo/reference/rust-version.html:
// "The Rust version must be a bare version number ... it cannot include semver operators." So
// unlike rubydrift-ci's Gemfile (an exact pin) this is a floor-only range, the same shape as
// godrift-ci's go.mod "go" directive.
function readCargoTomlFloor(rootDir) {
  const p = path.join(rootDir, 'Cargo.toml');
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  const m = text.match(/^\s*rust-version\s*=\s*"([^"]+)"/m);
  if (!m) return null;
  const raw = m[1].trim();
  const key = bareVersionKey(raw);
  if (key == null) return null; // malformed per cargo's own rule — nothing comparable to report
  return { raw, range: { min: key, max: null, exact: null } };
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build']);
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    if (DEFAULT_EXCLUDE_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Every "FROM rust:<tag>" line in every Dockerfile under rootDir. A tag with no minor
// component ("rust:1", "rust:latest", "rust:1-slim") is ambiguous and skipped — same
// "unversioned alias" skip every prior sibling in this family applies to its own base image.
function findDockerfilePins(rootDir) {
  const pins = [];
  for (const fsPath of walk(rootDir)) {
    const base = path.basename(fsPath);
    if (!/^Dockerfile(\..+)?$/.test(base)) continue;
    const text = fs.readFileSync(fsPath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*FROM\s+rust:([^\s]+)/i);
      if (!m) continue;
      const tag = m[1];
      const key = parseVersionKey(tag);
      if (key == null) continue;
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: tag, key });
    }
  }
  return pins;
}

// Every "toolchain:" input declared under a step that "uses:" dtolnay/rust-toolchain or
// actions-rs/toolchain, in every .github/workflows/*.yml(.yaml) file. Scoped deliberately to
// those two actions' own steps (confirmed from dtolnay/rust-toolchain's action.yml: "toolchain"
// is that action's input key) — unlike "go-version:"/"python-version:"/"java-version:", the
// bare word "toolchain:" is generic enough that matching it anywhere in a workflow would catch
// unrelated steps. A step boundary is any YAML sequence item ("- ") at or below the indent of
// the step that opened the scope; each `uses:` line resets whether the step currently in scope
// is a rust-toolchain step. `toolchain: ${{ matrix.rust }}` (a matrix-driven value) is read as
// raw text, fails the bare-version check, and is naturally excluded as non-comparable — the
// same outcome as a literal channel name, with no separate matrix-detection path needed.
function findWorkflowToolchainPins(rootDir) {
  const pins = [];
  const wfDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return pins;
  for (const e of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(e)) continue;
    const fsPath = path.join(wfDir, e);
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    let stepIndent = null;
    let inRustToolchainStep = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stepMarker = line.match(/^(\s*)-\s/);
      if (stepMarker) {
        const indent = stepMarker[1].length;
        if (stepIndent === null || indent <= stepIndent) inRustToolchainStep = false;
        stepIndent = indent;
      }
      if (/uses:\s*(dtolnay\/rust-toolchain|actions-rs\/toolchain)/.test(line)) {
        inRustToolchainStep = true;
      }
      if (!inRustToolchainStep) continue;
      const tm = line.match(/^\s*toolchain:\s*(.+?)\s*$/);
      if (!tm) continue;
      let raw = tm[1];
      const qm = raw.match(/^(['"])(.*)\1$/);
      if (qm) raw = qm[2];
      const key = bareVersionKey(raw);
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw, key, channel: key == null });
    }
  }
  return pins;
}

// ---------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------
function buildReport(rootDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ConfigError(`${rootDir} is not a directory`);
  }
  const rustToolchain = readRustToolchain(rootDir);
  const rustToolchainSource = fs.existsSync(path.join(rootDir, 'rust-toolchain.toml')) ? 'rust-toolchain.toml' : 'rust-toolchain';
  const cargoFloor = readCargoTomlFloor(rootDir);
  const pins = [];
  if (rustToolchain && rustToolchain.key != null) {
    pins.push({ source: rustToolchainSource, raw: rustToolchain.raw, key: rustToolchain.key });
  }

  const pro = !!opts.pro;
  if (pro) {
    pins.push(...findDockerfilePins(rootDir));
    pins.push(...findWorkflowToolchainPins(rootDir).filter((p) => p.key != null));
  }

  const findings = [];

  const distinctKeys = new Set(pins.map((p) => p.key));
  if (distinctKeys.size > 1) {
    findings.push({
      rule: 'pinMismatch',
      message: `Pinned Rust versions disagree: ${pins.map((p) => `${p.source}=${p.raw}`).join(', ')}`,
      pins,
    });
  }

  if (cargoFloor && cargoFloor.range) {
    for (const p of pins) {
      if (!keySatisfiesRange(p.key, cargoFloor.range)) {
        findings.push({
          rule: 'rustVersionMismatch',
          message: `${p.source} pins Rust ${p.raw}, which is below Cargo.toml's required minimum rust-version "${cargoFloor.raw}"`,
          source: p.source,
          raw: p.raw,
          cargoFloor: cargoFloor.raw,
        });
      }
    }
  }

  return {
    breach: findings.length > 0,
    pro,
    sources: {
      rustToolchain: rustToolchain && rustToolchain.raw,
      rustToolchainIsChannelName: !!(rustToolchain && rustToolchain.channel),
      cargoFloor: cargoFloor && cargoFloor.raw,
      pins,
    },
    findings,
  };
}

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log(`rustdrift-ci — mode: ${result.pro ? 'Pro (rust-toolchain + Cargo.toml + Dockerfile + CI workflows)' : 'free (rust-toolchain + Cargo.toml only)'}`);
  if (result.sources.rustToolchainIsChannelName) {
    console.log(`  (rust-toolchain channel "${result.sources.rustToolchain}" is a channel name, not a version — excluded from comparison)`);
  }
  if (!result.findings.length) {
    console.log('  no drift found.');
  } else {
    for (const f of result.findings) console.log(`  DRIFT  [${f.rule}]  ${f.message}`);
  }
  if (!result.pro) {
    console.log('  (free mode checked rust-toolchain + Cargo.toml only — Pro also checks every Dockerfile and GitHub Actions workflow: https://rustdrift-ci.madeforthisday.com)');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, { pro: hasPro() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`rustdrift-ci config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);

  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildReport, verifyLicense, verifyLicenseWith, parseVersionKey, bareVersionKey,
  readRustToolchain, readCargoTomlFloor, keySatisfiesRange, findDockerfilePins,
  findWorkflowToolchainPins,
};
