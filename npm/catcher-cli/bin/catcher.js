#!/usr/bin/env node
// catcher-cli: a thin launcher for the native catcher binary (crates/catcher-cli).
// On first run it downloads the binary for this platform from the GitHub release that matches this package's version,
// checks its SHA-256 against checksums.json (written into the package at release time), caches it under
// ~/.catcher/bin/<version>/ and from then on just runs it. No install scripts, no dependencies.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = 'bang9/catcher';
const MAX_BYTES = 64 * 1024 * 1024;

// process.platform-process.arch → release target. Linux builds are static (musl) and run on any distribution.
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'x86_64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
};

const fail = (message) => {
  process.stderr.write(`catcher-cli: ${message}\n`);
  process.exit(1);
};

const readJson = (name) => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function assetName() {
  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    fail(`no catcher build for ${process.platform}/${process.arch}. See https://github.com/${REPO}/releases`);
  }
  if (process.platform === 'win32') return `catcher-${target}.exe`;
  return `catcher-${target}`;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`download failed (${res.status}): ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) fail(`download is unexpectedly large: ${url}`);
  return bytes;
}

async function ensureBinary(version, asset) {
  const home = process.env.CATCHER_HOME || join(homedir(), '.catcher');
  const dir = join(home, 'bin', version);
  let file = join(dir, 'catcher');
  if (process.platform === 'win32') file = join(dir, 'catcher.exe');
  if (existsSync(file)) return file;

  let checksums;
  try {
    checksums = readJson('checksums.json');
  } catch {
    fail('this package has no checksums.json; install a released version: npm i -g catcher-cli');
  }
  const expected = checksums[asset];
  if (!/^[0-9a-f]{64}$/.test(expected || '')) fail(`no checksum for ${asset} in this release`);

  const url = `https://github.com/${REPO}/releases/download/cli-v${version}/${asset}`;
  process.stderr.write(`catcher-cli: downloading catcher ${version} (${asset}), first run only\n`);
  const bytes = await download(url);
  const actual = sha256(bytes);
  if (actual !== expected)
    fail(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was saved.`);

  // write to a private temp name, then rename: two first runs at once never see a half-written binary
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    if (!existsSync(file)) throw e;
  }
  return file;
}

function run(file) {
  const child = spawn(file, process.argv.slice(2), { stdio: 'inherit' });
  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const s of signals) process.on(s, forward);
  child.on('error', (e) => fail(`could not run ${file}: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (signal) {
      // die the same way the binary did, so callers see the real signal
      for (const s of signals) process.removeListener(s, forward);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

const { version } = readJson('package.json');
let binary = '';
try {
  binary = await ensureBinary(version, assetName());
} catch (e) {
  fail(`could not get the catcher binary: ${e.message}`);
}
run(binary);
