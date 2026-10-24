import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { activitySummary, activityText, findMatches, groupMessages, isConversationExport, parseConversation } from '../src/parser.js';

test('parses Codex roles, keeps Markdown, and marks the last assistant reply per turn', () => {
  const result = parseConversation('# Codex conversation\n\n## User\n\n问题一\n\n## Assistant\n\n正在分析\n\n## Activity\n\n    $ echo ok\n    ok\n    ✓ • 1ms\n\n## Assistant\n\n**答案一**\n\n## User\n\n问题二\n\n## Assistant\n\n答案二\n');
  assert.deepEqual(result.counts, { user: 2, assistant: 3, activity: 1, system: 0 });
  assert.equal(result.turns, 2);
  assert.equal(result.messages[3].content, '**答案一**');
  assert.deepEqual(result.messages.filter((message) => message.isFinal).map((message) => message.content), ['**答案一**', '答案二']);
  assert.equal(result.messages[0].startLine, 3);
});

test('role headings in fenced, nested-fence, indented, and quoted code remain message content', () => {
  const content = ['# Codex conversation', '', '## User', '', '看下面的例子', '', '````md', '## Assistant', '```', '## Activity', '```', '````', '', '~~~text', '## User', '~~~', '', '    ## Assistant', '', '> ## User', '', '## Assistant', '', '真正的回复'].join('\n');
  const result = parseConversation(content);
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content, /## Activity/);
  assert.equal(result.messages[1].content, '真正的回复');
});

test('handles BOM, CRLF, lowercase headings, and absent document title', () => {
  const result = parseConversation('\uFEFF## user\r\n\r\n你好\r\n\r\n## assistant\r\n\r\n你好！');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, '你好');
  assert.equal(isConversationExport('\uFEFF# Codex conversation\r\n'), true);
  assert.equal(isConversationExport('# README\n\n```md\n# Codex conversation\n## User\nExample\n```'), false);
});

test('only exact role headings split messages', () => {
  const result = parseConversation('## User\n问题\n## Assistant\n回复\n## User guide\n正文\n### User\n普通标题');
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[1].content, /## User guide/);
});

test('unclosed code blocks are preserved without inventing further messages', () => {
  const result = parseConversation('## User\n问题\n## Assistant\n```md\n## User\n未关闭');
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[1].content, /## User/);
});

test('does not remove indentation from tool output or mixed Markdown content', () => {
  const result = parseConversation('## User\n问题\n## Activity\n\n    $ run\n        nested\n    ✓ • 2ms\n\n## Assistant\n完成');
  assert.equal(result.messages[1].content, '    $ run\n        nested\n    ✓ • 2ms');
  assert.equal(activityText(result.messages[1].content), '$ run\n    nested\n✓ • 2ms');
  assert.equal(activityText('plain\n    indented'), 'plain\n    indented');
  assert.equal(activitySummary('    $ check\n    failed\n    ✗ (1) • 0ms').status, 'error');
});

test('consecutive activities group without reordering the conversation', () => {
  const result = parseConversation('## User\nhi\n## Activity\n    $ one\n## Activity\n    $ two\n## Assistant\nanswer\n## Activity\n    $ three');
  const groups = groupMessages(result.messages);
  assert.deepEqual(groups.map((group) => [group.type, group.messages.length]), [['message', 1], ['activities', 2], ['message', 1], ['activities', 1]]);
  assert.deepEqual(groups.flatMap((group) => group.messages), result.messages);
});

test('search includes collapsed activities, handles Chinese and literal special characters', () => {
  const result = parseConversation('## User\n用户问题\n## Activity\n    $ SELECT [file].中文\n## Assistant\n中文结果');
  assert.deepEqual(findMatches(result.messages, 'select [file]'), ['message-2']);
  assert.deepEqual(findMatches(result.messages, '中文'), ['message-2', 'message-3']);
  assert.deepEqual(findMatches(result.messages, '   '), []);
});

test('rejects empty, binary, and unrelated files with a useful message', () => {
  for (const text of ['', '  ', '# Readme\nNot a conversation', '## User\n\0binary']) assert.throws(() => parseConversation(text), { name: 'ConversationParseError' });
});

test('reads the user-provided export without losing any of its 40 records', async (context) => {
  const root = new URL('..', import.meta.url);
  const sample = (await readdir(root)).find((name) => name === 'codex-session-01a13dbb-ed7c-79f0-8e93-c701ed81abb8.md');
  if (!sample) { context.skip('The private example is not checked into the project.'); return; }
  const text = await readFile(new URL(sample, root), 'utf8');
  const result = parseConversation(text);
  assert.deepEqual(result.counts, { user: 1, assistant: 5, activity: 34, system: 0 });
  assert.equal(result.messages.length, 40);
  for (const message of result.messages) {
    const expected = text.split('\n').slice(message.startLine, message.endLine).join('\n').replace(/^\n+|\n+$/g, '');
    assert.equal(message.content, expected);
  }
});
