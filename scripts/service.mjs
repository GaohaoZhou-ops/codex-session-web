import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity as identifyProcess } from './process-identity.mjs';

// Entry scripts hold an exclusive OS file lock for the whole operation. The detached
// server inherits only stdin/stdout/stderr, so it cannot keep that lock alive.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = path.join(ROOT, 'server.mjs');
const STATE = path.join(ROOT, '.run/service.json');
const LOG = path.join(ROOT, '.run/service.log');
const PROJECT = createHash('sha256').update(path.resolve(ROOT)).digest('hex').slice(0, 16);

function configuration() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  return { host, port };
}

function address({ host, port }) {
  const reachable = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`;
}

async function health(config) {
  try {
    const response = await fetch(`${address(config)}/api/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    if (!response.ok) return null;
    const result = await response.json();
    return result.app === 'codex-session-reader' && result.project === PROJECT ? result : null;
  } catch { return null; }
}

const processIdentity = (pid) => identifyProcess(pid, SERVER);

async function matchesProcess(record) {
  const identity = await processIdentity(record.pid);
  // Continue managing records written by the original WSL version.
  const startId = record.startId ?? (/^\d+$/.test(record.startTicks || '') ? `linux:${record.startTicks}` : null);
  return Boolean(identity && identity.startId === startId);
}

async function save(record) {
  const temporary = `${STATE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, STATE);
}

async function readRecord() {
  try {
    const record = JSON.parse(await readFile(STATE, 'utf8'));
    if (record?.project === PROJECT && Number.isSafeInteger(record.pid) && record.pid > 1 && typeof record.host === 'string' && Number.isInteger(record.port) && record.port > 0 && record.port < 65536 && await matchesProcess(record)) return record;
    console.log('已清理过期的进程记录。');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (!(error instanceof SyntaxError)) throw error;
    console.log('已清理无效的进程记录。');
  }
  await rm(STATE, { force: true });
  return null;
}

async function discover() {
  const recorded = await readRecord();
  if (recorded) return recorded;
  // Also recognize a foreground `npm start` of this exact project. Validate the
  // executable, entry point and start time before recording or signalling it.
  const config = configuration();
  const result = await health(config);
  if (!result) return null;
  const identity = await processIdentity(result.pid);
  if (!identity) throw new Error(`阅读器已在 ${address(config)} 运行，但不是可由这些脚本管理的 server.mjs 进程。请在原启动终端管理它。`);
  return { ...config, ...identity, project: PROJECT, managed: false };
}

function report(record, label = '运行中') {
  console.log(`${label}\nPID：${record.pid}\n地址：${address(record)}`);
  if (record.managed) console.log(`日志：${LOG}`);
  else console.log('该进程由前台命令或其他方式启动。');
}

async function waitUntilStopped(record, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    if (!await matchesProcess(record)) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return !await matchesProcess(record);
}

async function terminate(record) {
  if (!await matchesProcess(record)) return;
  try { process.kill(record.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (await waitUntilStopped(record, 5000)) return;
  // Revalidate before escalation; never kill a different process reusing a PID.
  if (await matchesProcess(record)) {
    console.log('进程未及时退出，正在终止该服务进程。');
    try { process.kill(record.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (!await waitUntilStopped(record, 2000)) throw new Error(`停止失败，请检查 PID ${record.pid}。`);
}

async function start() {
  const running = await discover();
  if (running) {
    const ready = await health(running);
    if (ready?.pid !== running.pid) throw new Error(`服务进程 ${running.pid} 仍在运行，但健康检查失败。请先执行 scripts/stop.sh 后重试。`);
    await save(running);
    report(running, '服务已在运行，未创建重复实例。');
    return;
  }
  const config = configuration();
  if (!existsSync(path.join(ROOT, 'node_modules'))) throw new Error('缺少依赖，请先在项目目录执行 npm ci。');
  console.log('正在构建前端…');
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error('前端构建失败，服务未启动。可执行 npm ci 检查依赖。');

  appendFileSync(LOG, `\n[${new Date().toISOString()}] 启动服务\n`, { mode: 0o600 });
  const logFd = openSync(LOG, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: { ...process.env, HOST: config.host, PORT: String(config.port) },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { closeSync(logFd); }
  child.unref();
  let identity;
  try {
    identity = await processIdentity(child.pid);
    if (!identity) throw new Error(`服务启动失败，无法确认进程身份，请查看 ${LOG}。`);
  } catch (error) {
    // This is our freshly spawned child, with no saved identity yet. Do not
    // leave an unmanaged server behind when inspection fails.
    child.kill('SIGTERM');
    throw error;
  }
  const record = { ...config, ...identity, project: PROJECT, managed: true };
  try {
    await save(record);
    const deadline = Date.now() + 10000;
    do {
      const ready = await health(record);
      if (ready?.pid === record.pid && await matchesProcess(record)) {
        report(record, '服务已在后台启动。');
        return;
      }
      if (!await matchesProcess(record)) break;
      await delay(150);
    } while (Date.now() < deadline);
    throw new Error(`服务启动失败或未通过健康检查，请查看 ${LOG}。`);
  } catch (error) {
    await terminate(record);
    await rm(STATE, { force: true });
    throw error;
  }
}

async function stop() {
  const running = await discover();
  if (!running) { console.log('服务未运行，无需停止。'); return; }
  await terminate(running);
  await rm(STATE, { force: true });
  console.log(`服务已停止（PID ${running.pid}）。`);
}

async function status() {
  const running = await discover();
  if (!running) { console.log('服务未运行。'); process.exitCode = 3; return; }
  const ready = await health(running);
  if (ready?.pid === running.pid) report(running);
  else { report(running, '进程存在，但健康检查失败。'); process.exitCode = 1; }
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log('用法：scripts/start.sh | scripts/stop.sh | scripts/status.sh\nstart：构建并后台启动；stop：停止当前项目服务；status：查询进程与健康状态。\n启动时可设置 PORT（默认 4173）、HOST（默认 127.0.0.1）；停止和查询会读取已记录的地址。\n状态退出码：0=正常运行，3=未运行，1=异常。');
    return;
  }
  if (args.length || !['start', 'stop', 'status'].includes(action)) throw new Error('用法：scripts/start.sh | scripts/stop.sh | scripts/status.sh，可添加 --help 查看说明。');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本。');
  await { start, stop, status }[action]();
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
