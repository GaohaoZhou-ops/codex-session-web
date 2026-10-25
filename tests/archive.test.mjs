import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createReaderServer } from '../server.mjs';
import { MAX_FILE_BYTES } from '../src/parser.js';

const exec = promisify(execFile);
const content = Buffer.from('\uFEFF# Codex conversation\r\n## User\r\n问题\r\n## Assistant\r\n回答\r\n');

async function setup(context, now) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-archive-'));
  const server = createReaderServer({ directory, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const upload = (name, body = content, options = {}) => fetch(`${url}/api/session?name=${encodeURIComponent(name)}`, {
    method: 'POST', body, ...options, headers: { 'content-type': 'application/octet-stream', ...options.headers },
  });
  return { directory, url, upload };
}

test('uploads create/reuse local daily folders, preserve bytes, and roll over without losing older files', async (context) => {
  let date = new Date(2026, 9, 25, 23, 59, 59);
  const { directory, url, upload } = await setup(context, () => date);
  const first = await upload('中文 会话.md');
  assert.equal(first.status, 200);
  const { session } = await first.json();
  assert.equal(session.path, 'sessions/2026-10-25/中文 会话.md');
  assert.deepEqual(await readFile(path.join(directory, session.path)), content);
  assert.deepEqual((await (await upload('中文 会话.md')).json()).session, session);
  assert.equal((await upload('other.markdown', Buffer.from('## User\n没有总标题\n## Assistant\n仍可阅读'))).status, 200);

  date = new Date(2026, 9, 26, 0, 0, 0);
  const updated = Buffer.from('## User\n追加\n## Assistant\n新回答');
  assert.equal((await upload('中文 会话.md', updated)).status, 200);
  assert.deepEqual(await readFile(path.join(directory, session.path)), content);
  assert.deepEqual(await readFile(path.join(directory, 'sessions/2026-10-26/中文 会话.md')), updated);
  const { sessions } = await (await fetch(`${url}/api/sessions`)).json();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((file) => file.name === '中文 会话.md').path, 'sessions/2026-10-26/中文 会话.md');
  assert.deepEqual(Buffer.from(await (await fetch(`${url}/api/session?name=${encodeURIComponent('中文 会话.md')}`)).arrayBuffer()), updated);
  assert.match(await (await fetch(`${url}/api/session?name=other.markdown`)).text(), /没有总标题/);
});

test('refresh discovers copies in date folders and retains legacy files, using the latest same-name file', async (context) => {
  const { directory, url } = await setup(context);
  await writeFile(path.join(directory, 'legacy.md'), content);
  assert.equal((await (await fetch(`${url}/api/sessions`)).json()).sessions.length, 1);
  const day = path.join(directory, 'sessions/2026-10-24');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, 'copied.md'), content);
  await writeFile(path.join(day, 'legacy.md'), '## User\n最新副本');
  await utimes(path.join(directory, 'legacy.md'), new Date('2025-01-01'), new Date('2025-01-01'));
  await mkdir(path.join(directory, 'sessions/notes'));
  await writeFile(path.join(directory, 'sessions/notes/hidden.md'), content);
  const { sessions } = await (await fetch(`${url}/api/sessions`)).json();
  assert.deepEqual(new Set(sessions.map((file) => file.name)), new Set(['copied.md', 'legacy.md']));
  assert.equal(await (await fetch(`${url}/api/session?name=legacy.md`)).text(), '## User\n最新副本');
  assert.deepEqual(Buffer.from(await (await fetch(`${url}/api/session?name=copied.md`)).arrayBuffer()), content);
});

test('concurrent uploads reuse one daily directory and commit complete files without temporary leftovers', async (context) => {
  const { directory, upload } = await setup(context, () => new Date(2026, 9, 25));
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => upload(`batch-${index}.md`)));
  assert.ok(responses.every((response) => response.status === 200));
  const versions = [content, Buffer.from('## User\n另一个完整版本')];
  assert.ok((await Promise.all(versions.map((body) => upload('shared.md', body)))).every((response) => response.ok));
  const day = path.join(directory, 'sessions/2026-10-25');
  const saved = await readFile(path.join(day, 'shared.md'));
  assert.ok(versions.some((version) => version.equals(saved)));
  assert.equal((await readdir(day)).length, 9);
  assert.deepEqual(await readdir(path.join(directory, 'sessions')), ['2026-10-25']);
});

test('rejects invalid uploads and cross-site writes without creating an archive', async (context) => {
  const { directory, url, upload } = await setup(context);
  for (const name of ['../escape.md', 'nested/file.md', 'nested\\file.md', 'file.md\0', 'file.js']) {
    assert.equal((await upload(name)).status, 404, name);
  }
  assert.equal((await upload('invalid.md', Buffer.from('# Ordinary Markdown'))).status, 422);
  assert.equal((await upload('invalid.md', Buffer.from([0xff, 0xfe]))).status, 422);
  assert.equal((await upload('valid.md', content, { headers: { origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await upload('valid.md', content, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(`${url}/api/session?name=valid.md`, { method: 'OPTIONS' })).status, 405);
  await assert.rejects(() => stat(path.join(directory, 'sessions')), { code: 'ENOENT' });
});

test('enforces the upload size limit for both declared and chunked bodies', async (context) => {
  const { directory, upload } = await setup(context);
  assert.equal((await upload('large.md', Buffer.alloc(MAX_FILE_BYTES + 1, 65))).status, 413);
  async function* chunks() {
    for (let index = 0; index < 21; index++) yield Buffer.alloc(1024 * 1024, 65);
  }
  assert.equal((await upload('chunked.md', chunks(), { duplex: 'half' })).status, 413);
  await assert.rejects(() => stat(path.join(directory, 'sessions')), { code: 'ENOENT' });
});

test('does not read or write through archive, date-directory, or file symlinks', async (context) => {
  const { directory, url, upload } = await setup(context, () => new Date(2026, 9, 25));
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.md'), content);
  const archive = path.join(directory, 'sessions');
  await symlink(outside, archive);
  assert.equal((await upload('private.md')).status, 409);
  assert.deepEqual((await (await fetch(`${url}/api/sessions`)).json()).sessions, []);
  await rm(archive);
  await mkdir(archive);
  const day = path.join(archive, '2026-10-25');
  await symlink(outside, day);
  assert.equal((await upload('private.md')).status, 409);
  assert.equal((await fetch(`${url}/api/session?name=private.md`)).status, 404);
  await rm(day);
  await mkdir(day);
  await symlink(path.join(outside, 'private.md'), path.join(day, 'private.md'));
  assert.equal((await upload('private.md')).status, 409);
  assert.deepEqual((await (await fetch(`${url}/api/sessions`)).json()).sessions, []);
  assert.equal((await fetch(`${url}/api/session?name=private.md`)).status, 404);
  assert.deepEqual(await readFile(path.join(outside, 'private.md')), content);
});

test('today.sh works from any cwd, creates one date directory concurrently, and prints only its name', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex archive script '));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'today.sh');
  await copyFile(new URL('../sessions/today.sh', import.meta.url), script);
  const results = await Promise.all(Array.from({ length: 6 }, () => exec('bash', [script], { cwd: tmpdir() })));
  const day = results[0].stdout.trim();
  for (const result of results) {
    assert.equal(result.stdout, `${day}\n`);
    assert.equal(result.stderr, '');
  }
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok((await stat(path.join(directory, day))).isDirectory());
  await writeFile(path.join(directory, day, 'keep.md'), content);
  assert.equal((await exec('bash', [script], { cwd: tmpdir() })).stdout, `${day}\n`);
  assert.deepEqual(await readFile(path.join(directory, day, 'keep.md')), content);
  await rm(path.join(directory, day), { recursive: true });
  await symlink(tmpdir(), path.join(directory, day));
  await assert.rejects(() => exec('bash', [script]), { code: 1, stdout: '' });
});
