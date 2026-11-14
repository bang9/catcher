// Bundle the CLI into one file (workspace packages + @noble inlined) so `npm i -g catcher-cli` has no dependencies.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/catcher.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'inline',
  minify: false,
});
