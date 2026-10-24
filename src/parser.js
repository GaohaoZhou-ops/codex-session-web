/** Codex /export uses exact level-two role headings as record boundaries. */
const ROLE_HEADING = /^##[ \t]+(User|Assistant|Activity|System|Developer|Tool)[ \t]*(?:##[ \t]*)?$/i;
const ROLES = { user: 'user', assistant: 'assistant', activity: 'activity', tool: 'activity', system: 'system', developer: 'system' };
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class ConversationParseError extends Error {
  constructor(message) { super(message); this.name = 'ConversationParseError'; }
}

export function isConversationExport(text) {
  // The export title must start the document, not be an example inside a README.
  return /^\uFEFF?\s*#[ \t]+Codex conversation[ \t]*(?:\r?\n|$)/i.test(text);
}

export function activityText(content) {
  const lines = content.split('\n');
  const nonempty = lines.filter((line) => line.trim());
  if (nonempty.length && nonempty.every((line) => /^( {4}|\t)/.test(line))) {
    return lines.map((line) => line.replace(/^( {4}|\t)/, '')).join('\n');
  }
  return content;
}

export function activitySummary(content) {
  const body = activityText(content);
  const lines = body.split('\n');
  const command = lines.find((line) => /^\s*\$\s/.test(line));
  const first = command?.replace(/^\s*\$\s*/, '') || lines.find((line) => line.trim()) || '工具执行记录';
  const statusLine = [...lines].reverse().find((line) => /^\s*[✓✗].*•/.test(line));
  return {
    title: first.slice(0, 200),
    status: statusLine?.trim().startsWith('✗') ? 'error' : statusLine ? 'success' : 'unknown',
    result: statusLine?.trim() || '',
    lineCount: lines.length,
  };
}

export function parseConversation(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ConversationParseError('文件为空，请选择 Codex /export 导出的 Markdown 文件。');
  }
  if (input.includes('\0')) throw new ConversationParseError('这不是文本文件，请选择 .md 或 .txt 格式的导出文件。');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const messages = [];
  let current = null;
  let fence = null;
  let turn = 0;

  const finish = (endLine) => {
    if (!current) return;
    // Preserve leading whitespace: tool output and Markdown indented code depend on it.
    const content = current.lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (!content.trim()) return;
    const message = { id: `message-${messages.length + 1}`, role: current.role, content, startLine: current.startLine, endLine, turn };
    if (message.role === 'activity') message.activity = activitySummary(content);
    messages.push(message);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      current?.lines.push(line);
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = { char: opening[1][0], length: opening[1].length };
      current?.lines.push(line);
      continue;
    }
    const heading = line.match(ROLE_HEADING);
    if (heading) {
      finish(index);
      const role = ROLES[heading[1].toLowerCase()];
      if (role === 'user') turn++;
      current = { role, startLine: index + 1, lines: [] };
    } else {
      current?.lines.push(line);
    }
  }
  finish(lines.length);
  if (!messages.some((message) => message.role === 'user' || message.role === 'assistant')) {
    throw new ConversationParseError('未找到对话。文件需要包含 “## User” 或 “## Assistant” 标题，请使用 Codex CLI 的 /export 导出。');
  }
  // The export does not include channel metadata. Only infer the last reply per turn.
  const finalReplies = new Map();
  for (const message of messages) if (message.role === 'assistant') finalReplies.set(message.turn, message.id);
  for (const message of messages) message.isFinal = finalReplies.get(message.turn) === message.id;
  const counts = { user: 0, assistant: 0, activity: 0, system: 0 };
  for (const message of messages) counts[message.role]++;
  return { messages, counts, turns: turn, lineCount: lines.length, title: text.match(/^#[ \t]+(.+)$/m)?.[1]?.trim() || 'Codex conversation' };
}

export function groupMessages(messages) {
  const groups = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.role === 'activity' && previous?.type === 'activities') {
      previous.messages.push(message);
    } else if (message.role === 'activity') {
      groups.push({ type: 'activities', id: `group-${message.id}`, messages: [message] });
    } else {
      groups.push({ type: 'message', id: message.id, messages: [message] });
    }
  }
  return groups;
}

export function findMatches(messages, query) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? messages.filter((message) => message.content.toLocaleLowerCase().includes(needle)).map((message) => message.id) : [];
}

export function messagePreview(content, limit = 64) {
  const plain = content.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}
