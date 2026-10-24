import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { options } from '../../scripts/build.mjs';
import { startServer } from '../../server.mjs';

await build(options);
await startServer({ port: 4175, directory: fileURLToPath(new URL('../fixtures', import.meta.url)) });
