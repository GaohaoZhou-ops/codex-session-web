import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { processIdentity } from '../scripts/process-identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('service control scripts', { timeout: 60000 }, async (suite) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex reader 控制 (test) '));
  const port = await freePort();
  await Promise.all([
    cp(path.join(ROOT, 'scripts'), path.join(directory, 'scripts'), { recursive: true }),
    cp(path.join(ROOT, 'src'), path.join(directory, 'src'), { recursive: true }),
    cp(path.join(ROOT, 'server.mjs'), path.join(directory, 'server.mjs')),
    cp(path.join(ROOT, 'package.json'), path.join(directory, 'package.json')),
    symlink(path.join(ROOT, 'node_modules'), path.join(directory, 'node_modules')),
    mkdir(path.join(directory, 'public')),
  ]);

  async function run(action, env = {}, scriptDirectory = directory) {
    // Invoke from outside the project to verify root resolution and shell quoting.
    const child = spawn(path.join(scriptDirectory, 'scripts', `${action}.sh`), {
      cwd: tmpdir(),
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const [code] = await once(child, 'close');
    return { code, output };
  }
  const recordPath = path.join(directory, '.run/service.json');
  const record = async () => JSON.parse(await readFile(recordPath, 'utf8'));
  suite.after(async () => {
    await run('stop');
    await rm(directory, { recursive: true, force: true });
  });

  await suite.test('reports stopped and permits repeated stop', async () => {
    assert.equal((await run('status')).code, 3);
    assert.equal((await run('stop')).code, 0);
    assert.equal((await run('stop')).code, 0);
  });

  let first;
  await suite.test('builds, detaches, records its port and passes health checks', async () => {
    const result = await run('start');
    assert.equal(result.code, 0, result.output);
    first = await record();
    assert.equal(first.port, port);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.pid, first.pid);
    assert.equal((await run('status', { PORT: '' })).code, 0);
    assert.match(first.startId, new RegExp(`^${process.platform}:`));
    assert.match(await readFile(path.join(directory, '.run/service.log'), 'utf8'), /Codex Session Reader/);
  });

  await suite.test('project aliases and locale/timezone changes reuse the same service', async () => {
    const alias = path.join(directory, 'project alias');
    await symlink(directory, alias);
    const result = await run('start', { LC_ALL: 'C', TZ: 'Pacific/Honolulu' }, alias);
    assert.equal(result.code, 0, result.output);
    assert.equal((await record()).pid, first.pid);
  });

  await suite.test('concurrent starts reuse the existing PID even with a different PORT', async () => {
    const results = await Promise.all([run('start'), run('start', { PORT: String(await freePort()) })]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    assert.equal((await record()).pid, first.pid);
    assert.equal((await record()).port, port);
  });

  await suite.test('stop uses the recorded custom port and removes the running process', async () => {
    const stopped = await run('stop', { PORT: '' });
    assert.equal(stopped.code, 0, stopped.output);
    assert.equal((await run('status')).code, 3);
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/health`));
    await assert.rejects(() => readFile(recordPath), { code: 'ENOENT' });
  });

  await suite.test('a forged or stale PID cannot stop an unrelated process', async () => {
    const otherEntry = path.join(directory, 'other.mjs');
    await writeFile(otherEntry, 'setInterval(() => {}, 1000);');
    const other = spawn(process.execPath, [otherEntry], { stdio: 'ignore' });
    const exited = once(other, 'exit');
    try {
      await once(other, 'spawn');
      const identity = await processIdentity(other.pid, otherEntry);
      assert.ok(identity, 'identify the unrelated process using its actual entry point');
      await writeFile(recordPath, JSON.stringify({ ...first, ...identity }));
      const result = await run('stop');
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /过期/);
      assert.doesNotThrow(() => process.kill(other.pid, 0));
    } finally {
      other.kill();
      await exited;
    }
  });

  await suite.test('a mismatched start identity cannot stop a live server', async () => {
    assert.equal((await run('start')).code, 0);
    const current = await record();
    try {
      await writeFile(recordPath, JSON.stringify({ ...current, startId: `${current.startId}-stale` }));
      const result = await run('stop', { PORT: String(await freePort()) });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /过期/);
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).pid, current.pid);
    } finally {
      await writeFile(recordPath, JSON.stringify(current));
      await run('stop');
    }
  });

  await suite.test('legacy WSL records remain manageable', { skip: process.platform !== 'linux' }, async () => {
    assert.equal((await run('start')).code, 0);
    const current = await record();
    const { startId, ...legacy } = current;
    await writeFile(recordPath, JSON.stringify({ ...legacy, startTicks: startId.slice('linux:'.length) }));
    assert.equal((await run('status', { PORT: '' })).code, 0);
    assert.equal((await run('stop', { PORT: '' })).code, 0);
  });

  await suite.test('concurrent cold starts on different ports produce only one server', async () => {
    const otherPort = await freePort();
    const results = await Promise.all([run('start'), run('start', { PORT: String(otherPort) })]);
    for (const result of results) assert.equal(result.code, 0, result.output);
    const current = await record();
    for (const result of results) assert.match(result.output, new RegExp(`PID：${current.pid}`));
    const unusedPort = current.port === port ? otherPort : port;
    await assert.rejects(() => fetch(`http://127.0.0.1:${unusedPort}/api/health`));
    assert.equal((await run('stop')).code, 0);
  });

  await suite.test('port conflicts leave the unrelated server running and no stale record', async () => {
    const unrelated = http.createServer((request, response) => response.end('unrelated'));
    await new Promise((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
    try {
      const result = await run('start');
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /启动失败/);
      assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated');
      await assert.rejects(() => readFile(recordPath), { code: 'ENOENT' });
    } finally {
      unrelated.closeAllConnections();
      await new Promise((resolve) => unrelated.close(resolve));
    }
  });

  await suite.test('recognizes and stops a foreground server from the same project', async () => {
    const foreground = spawn('node', ['server.mjs'], {
      cwd: directory,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
      stdio: 'ignore',
    });
    const exited = once(foreground, 'exit');
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* Wait for listen. */ }
        if (ready) break;
        await delay(100);
      }
      assert.equal(ready, true);
      assert.equal((await run('status')).code, 0);
      const started = await run('start');
      assert.equal(started.code, 0, started.output);
      assert.equal((await record()).pid, foreground.pid);
      assert.equal((await run('stop')).code, 0);
      await exited;
    } finally {
      if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill();
      await exited;
    }
  });
});
