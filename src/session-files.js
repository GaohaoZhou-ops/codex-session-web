import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isConversationExport, MAX_FILE_BYTES, parseConversation } from './parser.js';

const EXPORT_EXTENSION = /\.(md|markdown|txt)$/i;
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;
const fileError = (message, status) => Object.assign(new Error(message), { status });

export function dayName(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validateFilename(name) {
  if (!name || name !== path.basename(name) || /[\\\x00-\x1f\x7f]/.test(name) || !EXPORT_EXTENSION.test(name)) {
    throw fileError('文件不存在。', 404);
  }
}

async function isDirectory(directory) {
  try { return (await lstat(directory)).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function metadata(root, directory, name, info) {
  return {
    name, size: info.size, modifiedAt: info.mtime.toISOString(),
    path: path.relative(root, path.join(directory, name)).split(path.sep).join('/'),
    version: `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`,
  };
}

async function readExport(root, directory, name, previewOnly = false) {
  let handle;
  try {
    handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw fileError('文件不存在。', 404);
    if (info.size > MAX_FILE_BYTES) throw fileError('文件超过 20 MB，请分段导出后读取。', 413);
    // The legacy project root also contains README.md. The dedicated archive
    // accepts the same headerless exports as the Web file picker.
    if (directory === root) {
      const header = Buffer.alloc(Math.min(4096, info.size));
      await handle.read(header, 0, header.length, 0);
      if (!isConversationExport(header.toString('utf8'))) {
        throw fileError('这不是 Codex 导出文件，请通过页面的“打开文件”手动载入。', 422);
      }
    }
    const session = metadata(root, directory, name, info);
    if (previewOnly) return session;
    const content = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { session, content: content.subarray(0, offset) };
  } finally { await handle?.close(); }
}

async function exportDirectories(root) {
  const directories = [root];
  const archive = path.join(root, 'sessions');
  if (!await isDirectory(archive)) return directories;
  for (const entry of await readdir(archive, { withFileTypes: true })) {
    if (entry.isDirectory() && DAY_DIRECTORY.test(entry.name)) directories.push(path.join(archive, entry.name));
  }
  return directories;
}

async function scan(root, name) {
  const sessions = new Map();
  for (const directory of await exportDirectories(root)) {
    // Recheck parents before opening files, including when a date directory
    // has been replaced with a symlink since readdir.
    if (!await isDirectory(directory)) continue;
    const files = name ? [{ name, isFile: () => true }] : await readdir(directory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !EXPORT_EXTENSION.test(file.name)) continue;
      try {
        const session = await readExport(root, directory, file.name, true);
        const previous = sessions.get(file.name);
        if (!previous || session.modifiedAt > previous.modifiedAt || session.modifiedAt === previous.modifiedAt && session.path > previous.path) {
          sessions.set(file.name, session);
        }
      } catch (error) {
        if (!['ENOENT', 'ELOOP', 'EACCES', 'ENOTDIR'].includes(error.code) && !error.status) throw error;
      }
    }
  }
  return [...sessions.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}

export async function listSessionFiles(root) {
  return scan(path.resolve(root));
}

export async function listArchiveDays(root) {
  root = path.resolve(root);
  const days = [];
  for (const directory of await exportDirectories(root)) {
    if (directory === root || !await isDirectory(directory)) continue;
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !EXPORT_EXTENSION.test(entry.name)) continue;
      try {
        validateFilename(entry.name);
        const info = await lstat(path.join(directory, entry.name));
        if (info.isFile()) files.push(metadata(root, directory, entry.name, info));
      } catch (error) { if (error.code !== 'ENOENT' && !error.status) throw error; }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    days.push({ day: path.basename(directory), path: `sessions/${path.basename(directory)}`, files });
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

export async function deleteArchivePath(root, archivePath) {
  const match = /^sessions\/(\d{4}-\d{2}-\d{2})(?:\/([^/]+))?$/.exec(archivePath || '');
  if (!match) throw fileError('只能删除归档日期目录或其中的会话文件。', 400);
  const [, day, name] = match;
  if (name) validateFilename(name);
  root = path.resolve(root);
  const archive = path.join(root, 'sessions');
  const directory = path.join(archive, day);
  if (!await isDirectory(archive) || !await isDirectory(directory)) throw fileError('归档目录不存在或不是普通目录。', 404);
  const target = name ? path.join(directory, name) : directory;
  if (name && !(await lstat(target)).isFile()) throw fileError('只能删除普通会话文件。', 409);
  await rm(target, { recursive: !name });
  return { deleted: archivePath };
}

export async function readSessionFile(root, name) {
  validateFilename(name);
  root = path.resolve(root);
  const [session] = await scan(root, name);
  const directory = session ? path.dirname(path.join(root, session.path)) : root;
  if (!await isDirectory(directory) || directory !== root && !await isDirectory(path.join(root, 'sessions'))) {
    throw fileError('文件不存在。', 404);
  }
  return (await readExport(root, directory, name)).content;
}

async function ensureDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!await isDirectory(directory)) throw fileError('会话保存目录不可用，请检查目录是否为真实文件夹。', 409);
}

export async function saveSessionFile(root, name, content, uploadedAt = new Date()) {
  validateFilename(name);
  if (content.length > MAX_FILE_BYTES) throw fileError('文件超过 20 MB，请分段导出后读取。', 413);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
  catch { throw fileError('文件不是 UTF-8 文本，请转换编码后重试。', 422); }
  try { parseConversation(text); }
  catch (error) { throw fileError(error.message, 422); }

  root = path.resolve(root);
  const archive = path.join(root, 'sessions');
  const directory = path.join(archive, dayName(uploadedAt));
  await ensureDirectory(archive);
  await ensureDirectory(directory);
  const target = path.join(directory, name);
  // Reimporting identical bytes on the same day should not change the observed
  // file version or invalidate the browser's cache/deletion bookkeeping.
  try {
    if (!(await lstat(target)).isFile()) throw fileError('同名路径不是普通文件，无法保存。', 409);
    const existing = await readExport(root, directory, name);
    if (existing.content.equals(content)) return existing.session;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    const session = metadata(root, directory, name, await handle.stat());
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    return session;
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
