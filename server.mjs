import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MAX_FILE_BYTES } from './src/parser.js';
import { listSessionFiles, readSessionFile, saveSessionFile, validateFilename } from './src/session-files.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.map': 'application/json' };
const fingerprint = (directory) => createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);

async function readUpload(request) {
  const tooLarge = () => Object.assign(new Error('文件超过 20 MB，请分段导出后读取。'), { status: 413 });
  if (Number(request.headers['content-length']) > MAX_FILE_BYTES) { request.resume(); throw tooLarge(); }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) { request.resume(); throw tooLarge(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function createReaderServer({ directory = ROOT, host = '127.0.0.1', now = () => new Date() } = {}) {
  const project = fingerprint(directory);
  return http.createServer(async (request, response) => {
    const uploadedAt = now();
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const reply = (code, value, type = 'application/json; charset=utf-8') => {
      response.writeHead(code, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      // Keep local exports inaccessible to arbitrary websites through DNS rebinding.
      const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]', host]);
      if (!allowedHosts.has(url.hostname)) return reply(403, { error: '不允许的主机名。' });
      if (request.headers.origin && request.headers.origin !== url.origin) return reply(403, { error: '不允许跨站读取本地会话。' });
      if (url.pathname === '/api/session' && request.method === 'POST') {
        // A non-simple content type prevents cross-site HTML forms from writing
        // local files; cross-origin fetches also fail the existing Origin check.
        if (request.headers['content-type'] !== 'application/octet-stream') return reply(415, { error: '请上传原始文件内容。' });
        const name = url.searchParams.get('name');
        validateFilename(name);
        const session = await saveSessionFile(directory, name, await readUpload(request), uploadedAt);
        return reply(200, { session });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', url.pathname === '/api/session' ? 'GET, HEAD, POST' : 'GET, HEAD');
        return reply(405, { error: '只支持读取。' });
      }
      if (url.pathname === '/api/health') return reply(200, { app: 'codex-session-reader', project, pid: process.pid });
      if (url.pathname === '/api/sessions') {
        return reply(200, { sessions: await listSessionFiles(directory) });
      }
      if (url.pathname === '/api/session') {
        return reply(200, await readSessionFile(directory, url.searchParams.get('name')), 'text/plain; charset=utf-8');
      }
      const pathname = decodeURIComponent(url.pathname);
      const file = pathname === '/' ? path.join(PUBLIC, 'index.html') : path.resolve(PUBLIC, `.${pathname}`);
      if (!file.startsWith(`${PUBLIC}${path.sep}`) || pathname.split('/').some((part) => part.startsWith('.'))) {
        return reply(404, { error: '文件不存在。' });
      }
      if (!MIME[path.extname(file)]) return reply(404, { error: '文件不存在。' });
      const info = await stat(file);
      if (!info.isFile()) return reply(404, { error: '文件不存在。' });
      return reply(200, await readFile(file), MIME[path.extname(file)]);
    } catch (error) {
      const status = error.status || (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code) ? 404 : error instanceof URIError || error instanceof TypeError ? 400 : 500);
      reply(status, { error: error.status ? error.message : status === 404 ? '文件不存在。' : status === 400 ? '请求格式不正确。' : request.method === 'POST' ? '保存失败，请检查目录权限和磁盘空间后重试。' : '读取失败，请检查文件权限后重试。' });
    }
  });
}

export async function startServer({ port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1', directory = ROOT } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  const address = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const server = createReaderServer({ directory, host });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log(`\n  Codex Session Reader\n  本地地址：${address}\n  Ctrl+C 停止服务。\n`);
    return server;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    try {
      const response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(2000) });
      const existing = await response.json();
      if (existing.app === 'codex-session-reader' && existing.project === fingerprint(directory)) {
        console.log(`阅读器已在运行，请打开 ${address} （未创建重复实例）。`);
        return null;
      }
    } catch { /* The port belongs to an unrelated service. */ }
    throw new Error(`端口 ${port} 已被其他程序占用。请关闭该程序，或设置 PORT 后重新启动。`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
