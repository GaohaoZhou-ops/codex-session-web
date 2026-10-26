import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toHaveText('codex-session-demo.md');
  await expect(page.locator('#refresh-files')).toBeEnabled();
}

function exportName(timestamp) {
  const hex = new Date(timestamp).getTime().toString(16).padStart(12, '0');
  return `codex-session-${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000.md`;
}

async function archive(directory, day, names) {
  const folder = path.join(directory, 'sessions', day);
  await mkdir(folder, { recursive: true });
  await Promise.all(names.map((name) => writeFile(path.join(folder, name), `## User\n${day} ${name}\n## Assistant\n回答 ${day} ${name}`)));
  return folder;
}

async function refresh(page) {
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('#refresh-files')).toBeEnabled();
}

test('groups by archive folder, sorts within each day, and filters without changing the reader', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const older = exportName('2026-01-10T01:00:00Z');
  const newer = exportName('2026-10-25T01:00:00Z');
  const latest = exportName('2026-10-26T01:00:00Z');
  await archive(sessionDirectory, '2026-10-26', [older, newer]);
  await archive(sessionDirectory, '2026-10-25', [latest]);
  await refresh(page);
  expect(await page.locator('.session-group').evaluateAll((groups) => groups.map((group) => group.dataset.group))).toEqual(['2026-10-26', '2026-10-25', 'root']);
  expect(await page.locator('.session-group[data-group="2026-10-26"] .session-item').evaluateAll((items) => items.map((item) => item.title))).toEqual([newer, older]);
  const filter = page.getByLabel('归档日期');
  await expect(filter.locator('option')).toHaveText(['全部日期（4）', '2026-10-26（2）', '2026-10-25（1）', '根目录（1）']);

  const reads = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session') reads.push(request.url()); });
  await filter.selectOption('2026-10-25');
  await expect(page.locator('.session-item')).toHaveCount(1);
  await expect(page.locator('.session-item')).toHaveAttribute('title', latest);
  await expect(page.locator('#session-count')).toHaveText('1/4');
  await expect(page.locator('.conversation-filename')).toHaveText('codex-session-demo.md');
  await expect(page.locator('#library-current-note')).toBeVisible();
  expect(reads).toEqual([]);

  await page.locator('.session-item').click();
  await expect(page.locator('.conversation-filename')).toHaveText(latest);
  await expect(page.locator('.message-assistant')).toContainText(`回答 2026-10-25 ${latest}`);
  await expect(page.locator('#library-current-note')).toBeHidden();
  await page.reload();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(filter).toHaveValue('2026-10-25');
  await expect(page.locator('.session-item.active')).toHaveAttribute('title', latest);
  await expect(page.locator('.session-item')).toHaveCount(1);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(filter).toHaveValue('all');
  await expect(page.locator('.session-item')).toHaveCount(4);
  await expect(page.locator('#session-count')).toHaveText('4');
});

test('refresh updates date options, preserves an empty selection, and works in the mobile sidebar', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const folder = await archive(sessionDirectory, '2026-10-25', ['old.md']);
  await refresh(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '打开侧栏' }).click();
  const filter = page.getByLabel('归档日期');
  await expect(filter).toBeInViewport();
  await filter.selectOption('2026-10-25');
  await archive(sessionDirectory, '2026-10-26', ['new.md']);
  await refresh(page);
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(filter).toHaveValue('2026-10-25');
  await expect(filter.locator('option[value="2026-10-26"]')).toHaveText('2026-10-26（1）');
  await expect(page.locator('.session-item')).toHaveAttribute('title', 'old.md');

  await rm(folder, { recursive: true });
  await refresh(page);
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(filter).toHaveValue('2026-10-25');
  await expect(page.locator('#session-count')).toHaveText('0/2');
  await expect(page.locator('.sidebar-empty')).toContainText('此分组暂无会话');
  await expect(page.locator('.session-item')).toHaveCount(0);
  await expect(page.locator('#load-more-sessions')).toBeHidden();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.locator('.session-item')).toHaveCount(2);
  await filter.selectOption('root');
  await expect(page.locator('.session-item')).toHaveAttribute('title', 'codex-session-demo.md');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('pagination stays inside the selected date and resets when the filter changes', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const names = Array.from({ length: 55 }, (_, index) => exportName(Date.UTC(2026, 0, 10, 0, index)));
  await archive(sessionDirectory, '2026-10-25', names);
  await archive(sessionDirectory, '2026-10-26', Array.from({ length: 60 }, (_, index) => `today-${index}.md`));
  await refresh(page);
  await expect(page.locator('.session-item')).toHaveCount(51);
  const filter = page.getByLabel('归档日期');
  await filter.selectOption('2026-10-25');
  await expect(page.locator('.session-item')).toHaveCount(50);
  await expect(page.locator('#session-count')).toHaveText('55/116');
  await expect(page.locator('#load-more-sessions')).toHaveText('显示更多会话（剩余 5 个）');
  await page.locator('#load-more-sessions').click();
  await expect(page.locator('.session-item')).toHaveCount(55);
  await expect(page.locator('#load-more-sessions')).toBeHidden();
  await page.locator('.session-item').last().click();
  await expect(page.locator('.conversation-filename')).toHaveText(names[0]);
  await filter.selectOption('2026-10-26');
  await expect(page.locator('.session-item')).toHaveCount(50);
  await expect(page.locator('.session-item.active')).toHaveCount(0);
  await expect(page.locator('#load-more-sessions')).toHaveText('显示更多会话（剩余 10 个）');
  await filter.selectOption('2026-10-25');
  await expect(page.locator('.session-item')).toHaveCount(51);
  await expect(page.locator('.session-item').first()).toHaveAttribute('title', names[54]);
  await expect(page.locator('.session-item').last()).toHaveAttribute('title', names[0]);
  await expect(page.locator('.session-item').last()).toHaveClass('session-item active');
  await expect(page.locator('#load-more-sessions')).toHaveText('显示更多会话（剩余 4 个）');
});

test('cached date filtering survives a slow or failed startup scan', async ({ page, sessionDirectory }) => {
  await openReader(page);
  await archive(sessionDirectory, '2026-10-25', ['saved.md']);
  await refresh(page);
  await page.getByLabel('归档日期').selectOption('2026-10-25');
  await page.locator('.session-item').click();
  await expect(page.locator('.conversation-filename')).toHaveText('saved.md');
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sessions', async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: 'Offline' } });
  });
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#refresh-files')).toBeDisabled();
    await expect(page.locator('.conversation-filename')).toHaveText('saved.md');
    await expect(page.getByLabel('归档日期')).toHaveValue('2026-10-25');
    await expect(page.locator('.session-item.active')).toHaveAttribute('title', 'saved.md');
  } finally { release(); }
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('.session-group[data-group="2026-10-25"] .session-item.active')).toHaveAttribute('title', 'saved.md');
  await expect(page.getByRole('alert')).toContainText('已缓存的会话仍可打开');
});

test('deleting the last session in a date does not select a file outside the filter', async ({ page, sessionDirectory }) => {
  await openReader(page);
  await archive(sessionDirectory, '2026-10-25', ['delete.md']);
  await refresh(page);
  await page.getByLabel('归档日期').selectOption('2026-10-25');
  await page.locator('.session-item').click();
  await expect(page.locator('.conversation-filename')).toHaveText('delete.md');
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('#session-count')).toHaveText('0/1');
  await expect(page.locator('.session-item')).toHaveCount(0);
  await expect(page.locator('.conversation-filename')).toHaveCount(0);
  await expect(page.locator('.sidebar-empty')).toContainText('此分组暂无会话');
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.locator('.session-item')).toHaveAttribute('title', 'codex-session-demo.md');
});
