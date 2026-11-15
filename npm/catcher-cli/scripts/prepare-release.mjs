// Release step (CI): stamp the package with the release version and embed the SHA-256 of each platform binary, taken
// from the release's SHA256SUMS. Usage: node scripts/prepare-release.mjs <version> <path/to/SHA256SUMS>
import { readFileSync, writeFileSync } from 'node:fs';

const [version, sumsPath] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '') || !sumsPath) {
  console.error('usage: node scripts/prepare-release.mjs <version> <SHA256SUMS>');
  process.exit(2);
}

const TARGETS = [
  'catcher-aarch64-apple-darwin',
  'catcher-x86_64-apple-darwin',
  'catcher-aarch64-unknown-linux-musl',
  'catcher-x86_64-unknown-linux-musl',
  'catcher-x86_64-pc-windows-msvc.exe',
];

const sums = {};
for (const line of readFileSync(sumsPath, 'utf8').split('\n')) {
  const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
  if (m) sums[m[2]] = m[1];
}
const checksums = {};
for (const name of TARGETS) {
  if (!sums[name]) {
    console.error(`SHA256SUMS has no entry for ${name}`);
    process.exit(1);
  }
  checksums[name] = sums[name];
}

const dir = new URL('../', import.meta.url);
writeFileSync(new URL('checksums.json', dir), `${JSON.stringify(checksums, null, 2)}\n`);
const pkgUrl = new URL('package.json', dir);
const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8'));
pkg.version = version;
writeFileSync(pkgUrl, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`catcher-cli ${version}: embedded ${TARGETS.length} checksums`);
