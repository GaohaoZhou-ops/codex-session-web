import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

export const options = {
  absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outdir: 'public/assets',
  minify: true,
  logLevel: 'info',
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await build(options);
