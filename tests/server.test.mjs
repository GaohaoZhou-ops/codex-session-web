import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createReaderServer, startServer } from '../server.mjs';

const fixture = '# Codex conversation\n\n## User\n\n你好\n\n## Assistant\n\n你好！\n';

async function setup(context) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-reader-test-'));
  await writeFile(path.join(directory, 'codex-session-test.md'), fixture);
  const server = createReaderServer({ directory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, server, url: `http://127.0.0.1:${server.address().port}` };
}

test('lists only regular Codex export files and serves their original bytes', async (context) => {
  const { directory, url } = await setup(context);
  await writeFile(path.join(directory, 'README.md'), '# Internal notes\n\n```md\n# Codex conversation\n## User\nExample\n```');
  await symlink(path.join(directory, 'codex-session-test.md'), path.join(directory, 'codex-session-link.md'));
  const response = await fetch(`${url}/api/sessions`);
  const { sessions } = await response.json();
  assert.deepEqual(sessions.map((session) => session.name), ['codex-session-test.md']);
  assert.equal(await (await fetch(`${url}/api/session?name=codex-session-test.md`)).text(), fixture);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('blocks traversal, symlinks, non-export files, and access to project source', async (context) => {
  const { directory, url } = await setup(context);
  await writeFile(path.join(directory, 'private.md'), '# Private notes');
  await symlink(path.join(directory, 'codex-session-test.md'), path.join(directory, 'linked.md'));
  for (const suffix of ['/api/session?name=../README.md', '/api/session?name=linked.md', '/server.mjs', '/package.json', '/src/app.js', '/%2e%2e%2fserver.mjs']) {
    assert.equal((await fetch(`${url}${suffix}`)).status, 404, suffix);
  }
  assert.equal((await fetch(`${url}/api/session?name=private.md`)).status, 422);
  assert.equal((await fetch(`${url}/api/session`)).status, 404);
});

test('blocks cross-origin reads, unknown hosts, and unsupported writes', async (context) => {
  const { url } = await setup(context);
  assert.equal((await fetch(`${url}/api/sessions`, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${url}/api/sessions`, { headers: { host: 'unrelated.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${url}/api/sessions`, { method: 'POST' })).status, 405);
});

test('repeated start reuses the same instance and does not switch ports', async (context) => {
  const { server, directory } = await setup(context);
  assert.equal(await startServer({ port: server.address().port, directory }), null);
  await assert.rejects(() => startServer({ port: server.address().port, directory: '/another/project' }), /已被其他程序占用/);
});
