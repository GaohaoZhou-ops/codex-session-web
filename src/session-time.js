// Default Codex export filenames contain the session's UUIDv7. Its first
// 48 bits encode Unix milliseconds: https://www.rfc-editor.org/rfc/rfc9562#section-5.7
// Never substitute the export's modification time or the cache's creation time.
export function sessionStartTime(name) {
  const match = /^codex-session-([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?: \(\d+\))?\.(?:md|markdown|txt)$/i.exec(name);
  return match ? new Date(Number.parseInt(match[1] + match[2], 16)) : null;
}

export function formatSessionTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
