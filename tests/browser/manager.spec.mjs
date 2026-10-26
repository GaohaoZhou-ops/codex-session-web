import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures.mjs';

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toHaveText('codex-session-demo.md');
}

async function refresh(page) {
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('#refresh-files')).toBeEnabled();
}

test('archive manager highlights the current file, cancels safely and deletes its file and cache', async ({ page, sessionDirectory }) => {
  await openReader(page);
  await page.locator('#file-input').setInputFiles([
    { name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from('## User\n第一份\n## Assistant\n第一份回答') },
    { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from('## User\n第二份\n## Assistant\n第二份回答') },
  ]);
  await expect(page.locator('.conversation-filename')).toHaveText('first.md');
  const [day] = await readdir(path.join(sessionDirectory, 'sessions'));
  const firstPath = path.join(sessionDirectory, 'sessions', day, 'first.md');
  await page.getByRole('button', { name: '管理对话', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '管理对话', exact: true });
  await expect(manager.locator('.archive-file')).toHaveCount(2);
  await expect(manager.locator('.archive-file.active')).toContainText('first.md');
  await expect(manager.locator('.archive-file.active .archive-current')).toHaveText('当前打开');
  const removeFirst = manager.getByRole('button', { name: `删除文件 first.md（${day}）`, exact: true });
  await removeFirst.click();
  const confirmation = page.getByRole('dialog', { name: '删除归档文件？' });
  await expect(confirmation).toContainText('其中包含当前打开的会话');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect((await stat(firstPath)).isFile()).toBe(true);
  await expect(manager.locator('.archive-file')).toHaveCount(2);
  await removeFirst.click();
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(manager.locator('.archive-file')).toHaveCount(1);
  await expect(manager.locator('.archive-file')).toContainText('second.md');
  await expect(page.locator('.conversation-filename')).toHaveText('second.md');
  await expect(manager.locator('.archive-file.active')).toContainText('second.md');
  await expect(stat(firstPath)).rejects.toMatchObject({ code: 'ENOENT' });
  await manager.getByRole('button', { name: '关闭对话管理' }).click();
  await page.reload();
  await expect(page.locator('.session-item[title="first.md"]')).toHaveCount(0);
  await expect(page.locator('#session-count')).toHaveText('2');
});

test('same-name historical files stay distinct and deleting a day removes only that archive', async ({ page, sessionDirectory }) => {
  await openReader(page);
  for (const day of ['2026-10-25', '2026-10-26']) {
    const folder = path.join(sessionDirectory, 'sessions', day);
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, 'shared.md');
    await writeFile(file, `## User\n${day}\n## Assistant\n回答 ${day}`);
    await utimes(file, new Date(`${day}T00:00:00Z`), new Date(`${day}T00:00:00Z`));
  }
  await refresh(page);
  await page.locator('.session-item[title="shared.md"]').click();
  await expect(page.locator('.conversation-filename')).toHaveText('shared.md');
  await page.getByRole('button', { name: '管理对话', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '管理对话', exact: true });
  await expect(manager.locator('.archive-file')).toHaveCount(2);
  await expect(manager.locator('.archive-file.active')).toHaveAttribute('data-path', 'sessions/2026-10-26/shared.md');
  const old = manager.locator('.archive-day[data-day="2026-10-25"]');
  await old.locator('summary').click();
  await old.getByRole('button', { name: '删除文件 shared.md（2026-10-25）' }).click();
  await page.getByRole('dialog', { name: '删除归档文件？' }).getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(manager.locator('.archive-file')).toHaveCount(1);
  expect(await readFile(path.join(sessionDirectory, 'sessions/2026-10-26/shared.md'), 'utf8')).toContain('回答 2026-10-26');
  await expect(page.locator('.message-assistant')).toContainText('回答 2026-10-26');
  await manager.getByRole('button', { name: '删除 2026-10-26 的全部文件', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除整天归档？' });
  await expect(confirmation).toContainText('整个目录及其中所有文件');
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(manager.locator('.archive-day[data-day="2026-10-26"]')).toHaveCount(0);
  await expect(page.locator('.conversation-filename')).toHaveText('codex-session-demo.md');
  await expect(stat(path.join(sessionDirectory, 'sessions/2026-10-26'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(path.join(sessionDirectory, 'codex-session-demo.md'))).isFile()).toBe(true);
});

test('a failed archive deletion keeps its confirmation open and leaves the file readable', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const folder = path.join(sessionDirectory, 'sessions/2026-10-25');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'keep.md'), '## User\n保留文件');
  await page.route('**/api/archive?*', (route) => route.fulfill({ status: 500, json: { error: '删除失败，文件保留。' } }));
  await page.getByRole('button', { name: '管理对话', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '管理对话', exact: true });
  await manager.getByRole('button', { name: '删除文件 keep.md（2026-10-25）' }).click();
  const confirmation = page.getByRole('dialog', { name: '删除归档文件？' });
  await confirmation.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toHaveText('删除失败，文件保留。');
  expect(await readFile(path.join(folder, 'keep.md'), 'utf8')).toContain('保留文件');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(manager.locator('.archive-file')).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(manager).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
