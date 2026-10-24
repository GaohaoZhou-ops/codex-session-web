import { context } from 'esbuild';
import { options } from './build.mjs';
import { startServer } from '../server.mjs';

const builder = await context({ ...options, minify: false, sourcemap: true });
await builder.watch();
const server = await startServer();
if (!server) {
  await builder.dispose();
} else {
  const stop = async () => {
    server.close();
    await builder.dispose();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
