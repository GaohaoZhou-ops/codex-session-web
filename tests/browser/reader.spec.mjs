import { test, expect } from './fixtures.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#reader')).toHaveAttribute('aria-busy', 'false');
}

async function upload(page, content, name = 'uploaded.md') {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(content) });
}

async function selectView(page, value) {
  const labels = { conversation: '对话视图', compact: '精简视图', full: '完整记录' };
  await page.getByRole('combobox', { name: '阅读视图' }).click();
  await page.getByRole('option', { name: labels[value], exact: true }).click();
}

test('opens the directory export as a complete conversation and lazily renders activities', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openReader(page);
  await expect(page.locator('.message-user')).toHaveCount(2);
  await expect(page.locator('.message-assistant')).toHaveCount(3);
  await expect(page.locator('.activity-item')).toHaveCount(2);
  await expect(page.locator('.activity-output')).toHaveCount(0);
  await expect(page.locator('.activity-group')).not.toHaveAttribute('open', '');
  await page.locator('.activity-group-summary').click();
  await page.locator('.activity-item > summary').first().click();
  await expect(page.locator('.activity-output pre')).toContainText('hidden-needle');
  await page.getByRole('button', { name: '跳到最后回复' }).click();
  await expect(page.locator('.message-final').last()).toBeInViewport();
  expect(errors).toEqual([]);
});

test('search finds hidden activity output, highlights text, navigates and clears', async ({ page }) => {
  await openReader(page);
  await selectView(page, 'compact');
  await expect(page.locator('.activity-group')).toBeHidden();
  await page.getByRole('searchbox').fill('hidden-needle');
  await expect(page.locator('#search-count')).toHaveText('1 / 1 条');
  await expect(page.locator('.activity-group')).toBeVisible();
  await expect(page.locator('.activity-output mark')).toHaveText('hidden-needle');
  await expect(page.locator('.activity-output mark')).toBeInViewport();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.locator('.activity-group')).toBeHidden();
  await selectView(page, 'conversation');
  await page.getByRole('searchbox').fill('日志');
  await expect(page.locator('#search-count')).toHaveText('1 / 4 条');
  await page.getByRole('button', { name: '下一条匹配', exact: true }).click();
  await expect(page.locator('#search-count')).toHaveText('2 / 4 条');
  await page.getByRole('searchbox').press('Shift+Enter');
  await expect(page.locator('#search-count')).toHaveText('1 / 4 条');
  await page.getByRole('searchbox').fill('does-not-exist');
  await expect(page.locator('#search-count')).toHaveText('无匹配');
  await expect(page.getByRole('button', { name: '下一条匹配', exact: true })).toBeDisabled();
});

test('reading modes preserve full content and final replies in each turn', async ({ page }) => {
  await openReader(page);
  await selectView(page, 'compact');
  await expect(page.locator('.message:visible')).toHaveCount(4);
  await expect(page.locator('.message-final:visible')).toHaveCount(2);
  await selectView(page, 'full');
  await expect(page.locator('.message:visible')).toHaveCount(5);
  await expect(page.locator('.activity-item[open]')).toHaveCount(2);
  await expect(page.locator('.activity-output')).toHaveCount(2);
  await selectView(page, 'conversation');
  await expect(page.locator('.activity-group[open]')).toHaveCount(0);
});

test('footer navigation moves through visible blocks and returns to the reader top', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReader(page);
  const navigation = page.getByRole('group', { name: '阅读导航' });
  const previous = navigation.getByRole('button', { name: '上一块' });
  const next = navigation.getByRole('button', { name: '下一块' });
  const top = navigation.getByRole('button', { name: '回到顶部' });
  const bottom = navigation.getByRole('button', { name: '到底部' });
  const expectAnchor = async (element) => {
    await expect.poll(() => element.evaluate((node) => Math.round(node.getBoundingClientRect().top - document.querySelector('#reader').getBoundingClientRect().top))).toBe(24);
  };
  await expect(top).toBeDisabled();
  await expect(previous).toBeDisabled();
  await next.click();
  await expectAnchor(page.locator('.message-user').first());
  await expect(previous).toBeDisabled();
  await next.click();
  await expectAnchor(page.locator('.message-assistant').first());
  await next.click();
  await expectAnchor(page.locator('.activity-group'));
  await expect(page.locator('.activity-group')).not.toHaveAttribute('open', '');
  await expect(page.locator('.activity-output')).toHaveCount(0);
  await previous.click();
  await expectAnchor(page.locator('.message-assistant').first());
  // Consecutive clicks advance one block each, without waiting for animation.
  await next.click();
  await next.click();
  await expectAnchor(page.locator('.message-final').first());
  await page.locator('#reader').evaluate((reader) => { reader.scrollTop += 80; });
  await previous.click();
  await expectAnchor(page.locator('.message-final').first());
  await previous.click();
  await expectAnchor(page.locator('.activity-group'));

  await selectView(page, 'compact');
  await top.click();
  await next.click();
  await expectAnchor(page.locator('.message-user').first());
  await next.click();
  await expectAnchor(page.locator('.message-final').first());
  await expect(page.locator('.activity-group')).toBeHidden();
  await expect(page.locator('.message-assistant').first()).toBeHidden();
  await previous.click();
  await expectAnchor(page.locator('.message-user').first());
  await bottom.click();
  await expect(page.locator('#messages > :visible').last()).toBeInViewport();
  await expect(next).toBeDisabled();
  await expect(bottom).toBeDisabled();
  const endPosition = await page.locator('#reader').evaluate((reader) => reader.scrollTop);
  await previous.click();
  expect(await page.locator('#reader').evaluate((reader) => reader.scrollTop)).toBeLessThan(endPosition);
  await top.click();
  await expect(page.locator('#reading-progress')).toHaveText('0%');
  await expect(top).toBeDisabled();
  await expect(previous).toBeDisabled();
});

test('footer navigation handles empty and short sessions, layout changes and narrow screens', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让每一段对话，清晰可读。' })).toBeVisible();
  await expect(page.locator('.footer-navigation button:enabled')).toHaveCount(0);
  await upload(page, '## User\n短会话');
  await expect(page.locator('.conversation-filename')).toContainText('uploaded.md');
  await expect(page.locator('.footer-navigation button:enabled')).toHaveCount(0);
  await upload(page, `## User\n${'这是一段可以展开的长提问。\n\n'.repeat(40)}`, 'long.md');
  await expect(page.locator('.conversation-filename')).toContainText('long.md');
  await expect(page.locator('.footer-navigation button:enabled')).toHaveCount(0);
  await page.getByRole('button', { name: '展开完整提问' }).click();
  await expect(page.getByRole('button', { name: '到底部' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '下一块' })).toBeEnabled();
  await page.getByRole('button', { name: '到底部' }).click();
  const lastBlockOffset = () => page.locator('.message-user').evaluate((block) => Math.round(block.getBoundingClientRect().top - document.querySelector('#reader').getBoundingClientRect().top));
  await expect.poll(lastBlockOffset).toBe(24);
  await expect(page.locator('#reading-progress')).not.toHaveText('100%');
  await expect(page.getByRole('button', { name: '到底部' })).toBeDisabled();
  await page.locator('#reader').evaluate((reader) => { reader.scrollTop = reader.scrollHeight; });
  await expect(page.getByRole('button', { name: '到底部' })).toBeEnabled();
  await page.getByRole('button', { name: '到底部' }).click();
  await expect.poll(lastBlockOffset).toBe(24);
  await page.getByRole('button', { name: '收起提问' }).click();
  await expect(page.locator('.footer-navigation button:enabled')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const name of ['回到顶部', '上一块', '下一块', '到底部']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
  }
  expect(await page.locator('.reader-footer').evaluate((footer) => footer.scrollWidth)).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test('imports files, keeps code headings intact, and reports invalid files without losing the current conversation', async ({ page }) => {
  await openReader(page);
  await upload(page, '## User\n新问题\n## Assistant\n新的回答\n\n```md\n## User\n代码中的标题\n```', '新的会话.txt');
  await expect(page.locator('.conversation-filename')).toContainText('新的会话.txt');
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.message-assistant pre')).toContainText('## User');
  await upload(page, '# This is not a conversation', 'invalid.md');
  await expect(page.getByRole('alert')).toContainText('未找到对话');
  await expect(page.locator('.conversation-filename')).toContainText('新的会话.txt');
  await page.locator('.session-item[title="codex-session-demo.md"]').click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.getByRole('alert')).toBeHidden();
});

test('renders Markdown, copies code and source paths, and downloads the original file', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openReader(page);
  await expect(page.locator('.table-scroll table')).toHaveCount(1);
  await expect(page.locator('.hljs-string')).toContainText('你好，Codex');
  await page.getByRole('button', { name: '复制代码', exact: true }).first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('print("你好，Codex")');
  await page.getByRole('button', { name: '日志配置', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/workspace/config.json:12');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载当前原始文件' }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('codex-session-demo.md');
  const original = '\uFEFF# Codex conversation\r\n\r\n## User\r\n你好\r\n## Assistant\r\n原文测试\r\n';
  await upload(page, original, 'bom-crlf.md');
  await expect(page.locator('.conversation-filename')).toContainText('bom-crlf.md');
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载当前原始文件' }).click();
  expect(await readFile(await (await saved).path())).toEqual(Buffer.from(original));
});

test('untrusted export HTML cannot run scripts or automatically load remote images', async ({ page, baseURL }) => {
  const remote = [];
  page.on('request', (request) => { if (new URL(request.url()).origin !== baseURL) remote.push(request.url()); });
  await openReader(page);
  await upload(page, '## User\n测试安全渲染\n## Assistant\n<script>window.exportExecuted = true</script>\n<img src="https://example.com/track.png" onerror="window.exportExecuted = true">\n<iframe src="https://example.com"></iframe>\n\n[恶意链接](javascript:window.exportExecuted=true)\n\n![远程图片](https://example.com/private.png)\n\n**正常内容**', 'untrusted.md');
  await expect(page.locator('.conversation-filename')).toContainText('untrusted.md');
  await expect(page.locator('.message-assistant strong')).toContainText(['Codex', '正常内容']);
  expect(await page.evaluate(() => window.exportExecuted)).toBeUndefined();
  await expect(page.locator('.message-body script, .message-body iframe, .message-body img, .message-body a[href^="javascript:"]')).toHaveCount(0);
  expect(remote).toEqual([]);
});

test('works at mobile width with an off-canvas directory and no horizontal page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReader(page);
  expect(await page.locator('#sidebar').evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.locator('#sidebar')).toHaveClass(/is-open/);
  await page.locator('.outline-item').last().click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/is-open/);
  await expect(page.locator('.message-final').last()).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('remembers appearance and supports keyboard search', async ({ page }) => {
  await openReader(page);
  await page.getByRole('button', { name: '切换深色模式' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('searchbox')).toBeFocused();
});

test('reading view menu supports keyboard selection, dismissal and saved preferences', async ({ page }) => {
  await openReader(page);
  const control = page.getByRole('combobox', { name: '阅读视图' });
  const options = page.getByRole('listbox', { name: '阅读视图选项' });
  await control.focus();
  await control.press('ArrowDown');
  await expect(options).toBeVisible();
  await expect(page.getByRole('option', { name: '对话视图', exact: true })).toHaveAttribute('aria-selected', 'true');
  await control.press('ArrowDown');
  await control.press('Enter');
  await expect(control).toContainText('精简视图');
  await expect(control).toBeFocused();
  await expect(control).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.message:visible')).toHaveCount(4);
  await control.press('Space');
  await control.press('End');
  await control.press('Escape');
  await expect(options).toBeHidden();
  await expect(control).toContainText('精简视图');
  await control.click();
  await page.getByRole('searchbox').click();
  await expect(options).toBeHidden();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await control.click();
  await control.press('Tab');
  await expect(options).toBeHidden();
  await expect(page.getByRole('button', { name: '下载当前原始文件' })).toBeFocused();
  await page.reload();
  await expect(control).toContainText('精简视图');
  await expect(page.locator('.message:visible')).toHaveCount(4);
});

test.describe('session start time', () => {
  test.use({ timezoneId: 'Asia/Shanghai' });

  test('shows the session creation time in local time and preserves it after caching', async ({ page }) => {
    await openReader(page);
    await expect(page.locator('.conversation-start')).toHaveText('开始时间未知');
    const name = 'codex-session-019ba65c-4318-7000-8000-000000000001.md';
    const content = '## User\n这是一份会话导出。\n## Assistant\n工具日志中的日期 2099-12-31 不代表会话开始时间。';
    await upload(page, content, name);
    const time = page.locator('.conversation-start time');
    await expect(time).toHaveText('2026年01月10日 13:23:43');
    await expect(time).toHaveAttribute('datetime', '2026-01-10T05:23:43.000Z');
    await page.reload();
    await expect(time).toHaveText('2026年01月10日 13:23:43');
    await upload(page, content, 'renamed.md');
    await expect(page.locator('#toast')).toHaveText('已复用本机已有会话');
    await expect(time).toHaveText('2026年01月10日 13:23:43');
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(time).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await upload(page, '## User\n旧版会话 ID 没有时间信息。', name.replace('-7000-', '-4000-'));
    await expect(page.locator('.conversation-start')).toHaveText('开始时间未知');
  });
});

test('empty directories show an import entry and files can be dropped onto the page', async ({ page }) => {
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让每一段对话，清晰可读。' })).toBeVisible();
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['## User\n拖拽测试\n## Assistant\n已读取文件'], 'dropped.md', { type: 'text/markdown' }));
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.conversation-filename')).toContainText('dropped.md');
  await expect(page.locator('.message-assistant')).toContainText('已读取文件');
});

test('the real 612 KB export renders all records and can search its large tool logs', async ({ page }) => {
  const root = new URL('../../', import.meta.url);
  const sample = (await readdir(root)).find((name) => name === 'codex-session-01a13dbb-ed7c-79f0-8e93-c701ed81abb8.md');
  test.skip(!sample, 'The private example is not checked into the project.');
  await openReader(page);
  await page.locator('#file-input').setInputFiles(fileURLToPath(new URL(sample, root)));
  await expect(page.locator('.conversation-filename')).toContainText(sample);
  await expect(page.locator('.message')).toHaveCount(6);
  await expect(page.locator('.activity-item')).toHaveCount(34);
  await expect(page.locator('.activity-group')).toHaveCount(4);
  await page.getByRole('button', { name: '展开完整提问' }).click();
  await expect(page.locator('.message-user .message-body')).not.toHaveClass(/is-collapsed/);
  await page.getByRole('searchbox').fill('ABX_BUILD_JOBS');
  await expect(page.locator('.activity-output mark').first()).toHaveText('ABX_BUILD_JOBS');
  await selectView(page, 'full');
  await expect(page.locator('.activity-item[open]')).toHaveCount(34);
});
