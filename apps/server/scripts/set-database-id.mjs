// CI: fill this deployment's values into wrangler.jsonc right before a deploy (see config.mjs), so the public repo only
// ever holds placeholders. Never prints the values.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deployConfig } from './config.mjs';

const path = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
try {
  writeFileSync(path, deployConfig(readFileSync(path, 'utf8'), process.env));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log('deploy values set');
