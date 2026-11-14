// Local deploy (the CI workflow does the same): writes a gitignored wrangler.deploy.jsonc with the real D1 id,
// applies migrations, deploys, then removes the file. Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID
// in the environment (e.g. from vaultkey). Refuses to run without --yes.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--yes')) {
  console.error('This deploys to production. Re-run with --yes.');
  process.exit(1);
}
const id = process.env.D1_DATABASE_ID;
if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
  console.error('D1_DATABASE_ID is missing or malformed');
  process.exit(1);
}
const dir = fileURLToPath(new URL('..', import.meta.url));
const config = `${dir}wrangler.deploy.jsonc`;
writeFileSync(config, readFileSync(`${dir}wrangler.jsonc`, 'utf8').replace('00000000-0000-0000-0000-000000000000', id));
try {
  const run = (args) =>
    execFileSync('pnpm', ['exec', 'wrangler', ...args, '-c', config], { cwd: dir, stdio: 'inherit' });
  run(['d1', 'migrations', 'apply', 'catcher', '--remote']);
  run(['deploy']);
} finally {
  rmSync(config, { force: true });
}
