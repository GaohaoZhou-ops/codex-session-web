import { execFile } from 'node:child_process';
import { readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const isNode = (executable) => /^node(?:js)?$/.test(path.basename(executable));

async function linuxProcess(pid) {
  const [stat, command, cwd, executable] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/cmdline`, 'utf8'),
    readlink(`/proc/${pid}/cwd`),
    readlink(`/proc/${pid}/exe`),
  ]);
  // Field 2 can contain spaces and parentheses; field 22 identifies the start.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  if (['Z', 'X'].includes(fields[0]) || !/^\d+$/.test(fields[19])) return null;
  return { executable, cwd, entry: command.split('\0')[1], startId: `linux:${fields[19]}` };
}

async function macProcess(pid) {
  // C makes macOS ps escape non-ASCII filenames. Use a fixed UTF-8 locale for
  // readable paths, English dates, and a timezone-independent start identity.
  const options = { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'en_US.UTF-8', TZ: 'UTC' } };
  const [details, commandName, files] = await Promise.all([
    exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'command='], options),
    exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm='], options),
    exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Ffn0'], options),
  ]);
  const match = /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+([^\r\n]+)\n?$/.exec(details.stdout);
  if (!match || /^[ZX]/.test(match[2])) return null;
  const executable = commandName.stdout.trim();
  if (!isNode(executable) || !match[3].startsWith(`${executable} `)) return null;

  let descriptor;
  let cwd;
  const textFiles = [];
  // NUL fields preserve spaces in paths; lsof adds a newline between records.
  for (const field of files.stdout.split('\0')) {
    const value = field.replace(/^\n/, '');
    if (value.startsWith('f')) descriptor = value.slice(1);
    if (value.startsWith('n') && descriptor === 'cwd') cwd = value.slice(1);
    if (value.startsWith('n') && descriptor === 'txt') textFiles.push(value.slice(1));
  }
  if (!cwd) return null;
  // Verify the executable independently of the displayed command line.
  const binary = path.isAbsolute(executable) ? await realpath(executable) : textFiles.find(isNode);
  if (!binary || !textFiles.includes(binary)) return null;
  // ps does not delimit argv with NULs. Match the complete remaining entry path
  // instead of splitting on spaces (the project directory may contain spaces).
  return { executable: binary, cwd, entry: match[3].slice(executable.length + 1), startId: `darwin:${match[1]}` };
}

export async function processIdentity(pid, server) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const info = process.platform === 'darwin' ? await macProcess(pid)
      : process.platform === 'linux' ? await linuxProcess(pid) : null;
    if (!info || !isNode(info.executable) || !info.entry || info.entry.startsWith('-')) return null;
    if (await realpath(path.resolve(info.cwd, info.entry)) !== await realpath(server)) return null;
    return { pid, startId: info.startId };
  } catch (error) {
    // ps/lsof exit 1 when the process disappears during inspection.
    if (error.code === 1 || ['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ENOTDIR', 'ENAMETOOLONG'].includes(error.code)) return null;
    throw error;
  }
}
