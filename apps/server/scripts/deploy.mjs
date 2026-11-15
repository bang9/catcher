// Local deploy (the CI workflow does the same): writes a gitignored wrangler.deploy.jsonc with the real D1 id,
// applies migrations, deploys, then removes the file. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID
// in the environment (e.g. from vaultkey), plus the optional values in config.mjs. Refuses to run without --yes.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deployConfig } from './config.mjs';

if (!process.argv.includes('--yes')) {
  console.error('This deploys to production. Re-run with --yes.');
  process.exit(1);
}
const dir = fileURLToPath(new URL('..', import.meta.url));
const config = `${dir}wrangler.deploy.jsonc`;
try {
  writeFileSync(config, deployConfig(readFileSync(`${dir}wrangler.jsonc`, 'utf8'), process.env));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
try {
  const run = (args) =>
    execFileSync('pnpm', ['exec', 'wrangler', ...args, '-c', config], { cwd: dir, stdio: 'inherit' });
  run(['d1', 'migrations', 'apply', 'catcher', '--remote']);
  run(['deploy']);
} finally {
  rmSync(config, { force: true });
}
