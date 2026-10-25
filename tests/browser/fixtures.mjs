import { test as base, expect } from '@playwright/test';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReaderServer } from '../../server.mjs';

// Each browser test gets a real, isolated archive and HTTP server. Uploads must
// never write into repository fixtures or leak between parallel test cases.
export const test = base.extend({
  sessionDirectory: async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-reader-browser-'));
    try {
      await copyFile(new URL('../fixtures/codex-session-demo.md', import.meta.url), path.join(directory, 'codex-session-demo.md'));
      await use(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
  baseURL: async ({ sessionDirectory }, use) => {
    const server = createReaderServer({ directory: sessionDirectory });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
});
export { expect };
