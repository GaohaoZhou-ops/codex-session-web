import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from './fixtures.mjs';

const exec = promisify(execFile);
const original = Buffer.from('\uFEFF# Codex conversation\r\n## User\r\n归档问题\r\n## Assistant\r\n归档回答\r\n');

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#reader')).toHaveAttribute('aria-busy', 'false');
}

test('existing batch import saves raw bytes and is readable from a browser with no cache', async ({ page, browser, baseURL, sessionDirectory }) => {
  await openReader(page);
  const headerless = Buffer.from(`${'导出说明\n'.repeat(900)}\n## User\n没有总标题\n## Assistant\n从磁盘恢复`);
  await page.locator('#file-input').setInputFiles([
    { name: 'archived.md', mimeType: 'text/markdown', buffer: original },
    { name: 'headerless.txt', mimeType: 'text/plain', buffer: headerless },
  ]);
  await expect(page.locator('.conversation-filename')).toContainText('archived.md');
  await expect(page.locator('#session-count')).toHaveText('3');
  await expect(page.getByRole('alert')).toBeHidden();
  const days = await readdir(path.join(sessionDirectory, 'sessions'));
  expect(days).toHaveLength(1);
  expect(days[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const day = path.join(sessionDirectory, 'sessions', days[0]);
  expect(await readFile(path.join(day, 'archived.md'))).toEqual(original);
  expect(await readFile(path.join(day, 'headerless.txt'))).toEqual(headerless);
  const fresh = await browser.newContext({ baseURL });
  try {
    const other = await fresh.newPage();
    await other.goto('/');
    await expect(other.locator('#session-count')).toHaveText('3');
    await other.locator('.session-item[title="archived.md"]').click();
    await expect(other.locator('.message-assistant')).toContainText('归档回答');
    await other.locator('.session-item[title="headerless.txt"]').click();
    await expect(other.locator('.message-assistant')).toContainText('从磁盘恢复');
    await expect(other.locator('.conversation-filename')).toHaveText('headerless.txt');
  } finally { await fresh.close(); }
});

test('files copied into the script-created directory appear through the existing refresh button', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const archive = path.join(sessionDirectory, 'sessions');
  await mkdir(archive);
  const script = path.join(archive, 'today.sh');
  await copyFile(new URL('../../sessions/today.sh', import.meta.url), script);
  const { stdout } = await exec('bash', [script], { cwd: '/' });
  await writeFile(path.join(archive, stdout.trim(), 'cli-copy.md'), original);
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('.session-item[title="cli-copy.md"]')).toHaveCount(1);
  await page.locator('.session-item[title="cli-copy.md"]').click();
  await expect(page.locator('.message-assistant')).toContainText('归档回答');
  const updated = Buffer.from('## User\n命令行覆盖\n## Assistant\n复制后的新内容');
  await writeFile(path.join(archive, stdout.trim(), 'cli-copy.md'), updated);
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('.message-assistant')).toContainText('复制后的新内容');
  await expect(page.locator('.session-item[title="cli-copy.md"]')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.message-assistant')).toContainText('复制后的新内容');
});

test('disk-save failure keeps the import readable and can be retried with the same file picker', async ({ page, sessionDirectory }) => {
  await openReader(page);
  const archive = path.join(sessionDirectory, 'sessions');
  await writeFile(archive, 'blocks directory creation');
  const upload = () => page.locator('#file-input').setInputFiles({ name: 'retry.md', mimeType: 'text/markdown', buffer: original });
  await upload();
  await expect(page.locator('.conversation-filename')).toContainText('retry.md');
  await expect(page.locator('.message-assistant')).toContainText('归档回答');
  await expect(page.getByRole('alert')).toContainText('保存到会话目录失败');
  await rm(archive);
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/session?'));
  await upload();
  expect((await saved).ok()).toBe(true);
  await expect(page.locator('#reader')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('alert')).toBeHidden();
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('.session-item[title="retry.md"]')).toHaveCount(1);
  const [day] = await readdir(archive);
  expect(await readFile(path.join(archive, day, 'retry.md'))).toEqual(original);
});
