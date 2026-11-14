// Put the real D1 database id into wrangler.jsonc right before a deploy (CI or local), so the public repo only ever
// holds the placeholder. Reads D1_DATABASE_ID from the environment; never prints it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const id = process.env.D1_DATABASE_ID;
if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
  console.error('D1_DATABASE_ID is missing or malformed');
  process.exit(1);
}
const path = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
const text = readFileSync(path, 'utf8');
const next = text.replace('00000000-0000-0000-0000-000000000000', id);
if (next === text) {
  console.error('placeholder database id not found in wrangler.jsonc');
  process.exit(1);
}
writeFileSync(path, next);
console.log('database id set');
