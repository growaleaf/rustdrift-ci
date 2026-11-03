'use strict';
// Standalone-package test suite for rustdrift-ci. Exercises the exact exported functions the
// shipped cli.js ships against real fixture trees on disk (rust-toolchain.toml, the legacy
// rust-toolchain file, Cargo.toml, Dockerfile, .github/workflows/*.yml) — never a mocked tree.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  buildReport, verifyLicenseWith, parseVersionKey, bareVersionKey, readRustToolchain,
  readCargoTomlFloor, keySatisfiesRange, findDockerfilePins, findWorkflowToolchainPins,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  await check('parseVersionKey extracts major.minor as a comparable integer from surrounding text, null when ambiguous', () => {
    assert.equal(parseVersionKey('1.75.2'), 175);
    assert.equal(parseVersionKey('1.78'), 178);
    assert.equal(parseVersionKey('rust:1.75-slim-bookworm'), 175);
    assert.equal(parseVersionKey('1'), null);
    assert.equal(parseVersionKey('latest'), null);
  });

  await check('bareVersionKey accepts only a plain major[.minor[.patch]] number, rejects channel names and operators', () => {
    assert.equal(bareVersionKey('1.75'), 175);
    assert.equal(bareVersionKey('1.75.2'), 175);
    assert.equal(bareVersionKey('1'), 100);
    assert.equal(bareVersionKey('stable'), null);
    assert.equal(bareVersionKey('nightly-2026-01-10'), null);
    assert.equal(bareVersionKey('>=1.75'), null);
  });

  await check('readRustToolchain prefers rust-toolchain.toml over the legacy file when both exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-both-'));
    fs.writeFileSync(path.join(dir, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.75.0"\n');
    fs.writeFileSync(path.join(dir, 'rust-toolchain'), '1.60.0\n');
    assert.deepEqual(readRustToolchain(dir), { raw: '1.75.0', key: 175, channel: false });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('readRustToolchain reads the legacy extension-less file when no .toml exists', () => {
    const result = readRustToolchain(path.join(FIXTURES, 'legacy'));
    assert.deepEqual(result, { raw: '1.74.0', key: 174, channel: false });
  });

  await check('readRustToolchain marks a channel name as non-comparable, not an error', () => {
    const result = readRustToolchain(path.join(FIXTURES, 'channel-name'));
    assert.deepEqual(result, { raw: 'stable', key: null, channel: true });
  });

  await check('readRustToolchain returns null when neither file exists', () => {
    assert.equal(readRustToolchain(os.tmpdir() + '/does-not-exist-rustdrift'), null);
  });

  await check('readCargoTomlFloor reads rust-version as a floor-only range (no upper bound exists in real Cargo.toml syntax)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-cargo-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\nrust-version = "1.70"\n');
    assert.deepEqual(readCargoTomlFloor(dir), { raw: '1.70', range: { min: 170, max: null, exact: null } });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(readCargoTomlFloor(os.tmpdir() + '/does-not-exist-rustdrift'), null);
  });

  await check('readCargoTomlFloor returns null when Cargo.toml exists but has no rust-version field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-cargo-missing-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    assert.equal(readCargoTomlFloor(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('keySatisfiesRange: a floor-only range never flags a HIGHER minor, flags anything below it', () => {
    const range = { min: 175, max: null, exact: null };
    assert.equal(keySatisfiesRange(175, range), true);
    assert.equal(keySatisfiesRange(178, range), true);
    assert.equal(keySatisfiesRange(170, range), false);
  });

  await check('findDockerfilePins finds every "FROM rust:X.Y" across any Dockerfile*, skips unversioned tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-docker-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM rust:1.75-slim\nRUN echo hi\n');
    fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services', 'api', 'Dockerfile.prod'), 'FROM rust:latest\nFROM rust:1.78-alpine\n');
    const pins = findDockerfilePins(dir);
    assert.equal(pins.length, 2); // the unversioned "rust:latest" FROM is skipped
    assert.deepEqual(pins.map((p) => p.key).sort(), [175, 178]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowToolchainPins reads a scoped "toolchain:" input under a dtolnay/rust-toolchain step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-wf-scoped-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - uses: dtolnay/rust-toolchain@master',
      '        with:', '          toolchain: "1.75"', '      - run: cargo test', '',
    ].join('\n'));
    const pins = findWorkflowToolchainPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].key, 175);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowToolchainPins ignores an unrelated step that happens to use the word "toolchain:"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rustdrift-wf-unrelated-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - name: Pick a toolchain',
      '        run: echo "toolchain: 1.75" # not a real input, just text',
      '      - uses: actions/checkout@v4', '',
    ].join('\n'));
    const pins = findWorkflowToolchainPins(dir);
    assert.equal(pins.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowToolchainPins treats a matrix-interpolated toolchain as non-comparable, not drift', () => {
    const pins = findWorkflowToolchainPins(path.join(FIXTURES, 'channel-name'));
    assert.equal(pins.length, 1);
    assert.equal(pins[0].key, null);
    assert.equal(pins[0].raw, '${{ matrix.rust }}');
  });

  await check('buildReport free mode (no Pro): consistent fixture has zero findings', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.pro, false);
    // Dockerfile/CI pins are not even collected in free mode.
    assert.equal(result.sources.pins.length, 1);
  });

  await check('buildReport Pro mode: consistent fixture (floor 1.70, toolchain/Dockerfile/CI all 1.75) is clean', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 3);
  });

  await check('buildReport Pro mode: drift fixture flags both pinMismatch and rustVersionMismatch', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: true });
    assert.equal(result.breach, true);
    assert.ok(result.findings.some((f) => f.rule === 'pinMismatch'));
    assert.ok(result.findings.some((f) => f.rule === 'rustVersionMismatch'));
  });

  await check('buildReport free mode on the drift fixture: rust-toolchain alone already falls below the Cargo.toml floor', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: false });
    assert.equal(result.breach, true);
    assert.equal(result.findings.every((f) => f.rule === 'rustVersionMismatch'), true);
    assert.equal(result.sources.pins.length, 1); // rust-toolchain only — no Dockerfile/CI pin collected
  });

  await check('buildReport on a channel name ("stable"): free mode is clean, not an error, with no comparable pin collected', () => {
    const result = buildReport(path.join(FIXTURES, 'channel-name'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.sources.rustToolchainIsChannelName, true);
    assert.equal(result.sources.pins.length, 0);
  });

  await check('buildReport Pro mode on the channel-name fixture: the matrix-driven CI toolchain is also excluded, still clean', () => {
    const result = buildReport(path.join(FIXTURES, 'channel-name'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 0);
  });

  await check('buildReport reads the legacy rust-toolchain file correctly and satisfies the floor', () => {
    const result = buildReport(path.join(FIXTURES, 'legacy'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.sources.rustToolchain, '1.74.0');
  });

  await check('buildReport on a tree with only rust-toolchain.toml (no Cargo.toml, no Docker, no CI) is clean, not an error', () => {
    const result = buildReport(path.join(FIXTURES, 'minimal'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.cargoFloor, null);
  });

  await check('buildReport throws ConfigError when --dir does not exist', () => {
    assert.throws(() => buildReport(path.join(FIXTURES, 'does-not-exist'), {}), /is not a directory/);
  });

  await check('CLI end-to-end via real subprocess: free mode runs with no key, Pro mode engages with a real minted key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');

    const runCli = (args, env) => {
      try {
        const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
      }
    };

    // Free mode, no key at all: consistent fixture is still clean (exit 0), and the CLI runs
    // successfully rather than refusing outright — license absence narrows scope, it is not a
    // hard gate on the whole tool.
    const freeRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { RUSTDRIFT_KEY: '' });
    assert.equal(freeRun.code, 0);
    assert.ok(freeRun.out.includes('free'));

    // Pro mode with a real minted key: the drift fixture now fails (Dockerfile/CI pins disagree
    // with each other and with the Cargo.toml floor, which free mode alone could not fully see).
    const devVarsPath = path.join(os.homedir(), '.hive_devtools_license_keys', 'rustdrift.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `RS1.${payload}.${sig}`;

    const proRun = runCli(['check', '--dir', path.join(FIXTURES, 'drift')], { RUSTDRIFT_KEY: realKey });
    assert.equal(proRun.code, 1);
    assert.ok(proRun.out.includes('Pro'));

    const proCleanRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { RUSTDRIFT_KEY: realKey });
    assert.equal(proCleanRun.code, 0);
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`RS1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered key is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privateKey).toString('base64url');
    const tamperedPayload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`RS1.${tamperedPayload}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`RS1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'rustdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`RS1.${payload}.${sig}`, pubPemA), false);
  });

  await check('license: wrong product in the payload is rejected even with a valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'some-other-product', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`RS1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`RS1.${payload}.${sig}`, pubPem), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All rustdrift-ci standalone test groups passed.');
}

main();
