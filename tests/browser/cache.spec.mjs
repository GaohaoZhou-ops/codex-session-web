import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const original = '\uFEFF# Codex conversation\r\n\r\n## User\r\n缓存恢复问题\r\n## Assistant\r\n缓存恢复回答\r\n';

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#reader')).toHaveAttribute('aria-busy', 'false');
}

async function upload(page, text, name = 'cached.md') {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) });
}

async function cacheSummary(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('codex-reader-sessions');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['sessions', 'contents', 'directories'], 'readonly');
      const sessions = transaction.objectStore('sessions').getAll();
      const contents = transaction.objectStore('contents').count();
      const directories = transaction.objectStore('directories').getAll();
      transaction.oncomplete = () => {
        database.close();
        resolve({ sessions: sessions.result, contents: contents.result, directories: directories.result });
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
}

async function trackBodyAccess(page) {
  await page.addInitScript(() => {
    window.bodyAccess = [];
    for (const operation of ['get', 'getAll', 'openCursor', 'add', 'put']) {
      const method = IDBObjectStore.prototype[operation];
      IDBObjectStore.prototype[operation] = function (...args) {
        if (this.name === 'contents') window.bodyAccess.push({ operation, id: typeof args[0] === 'string' ? args[0] : args[0]?.id });
        return method.apply(this, args);
      };
    }
  });
}

test('brand navigation, reload and a new tab preserve the imported conversation and original bytes', async ({ page, context }) => {
  const writes = [];
  page.on('request', (request) => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await page.getByRole('searchbox').fill('恢复');
  await expect(page.locator('#search-count')).toHaveText('1 / 2 条');
  await page.evaluate(() => { window.readerPageMarker = 'same-page'; });
  await page.getByRole('link', { name: 'Codex 会话阅读器首页' }).click();
  expect(await page.evaluate(() => window.readerPageMarker)).toBe('same-page');
  await expect(page.getByRole('searchbox')).toHaveValue('恢复');
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载当前原始文件' }).click();
  expect(await readFile(await (await downloadEvent).path())).toEqual(Buffer.from(original));
  expect((await cacheSummary(page)).contents).toBe(2);
  expect(writes).toEqual([]);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.locator('.conversation-filename')).toContainText('cached.md');
  await expect(reopened.locator('.session-item')).toHaveCount(2);
});

test('deduplicates renamed imports and updates one filename without losing its differently named copy', async ({ page }) => {
  await trackBodyAccess(page);
  await openReader(page);
  const importFixedFile = (name, text) => page.evaluate(({ name, text }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], name, { type: 'text/markdown', lastModified: 42 }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, { name, text });
  const text = '## User\nQuestion A\n## Assistant\nAnswer A';
  await importFixedFile('same.md', text);
  await expect(page.locator('.conversation-filename')).toContainText('same.md');
  const before = await cacheSummary(page);
  await page.evaluate(() => { window.bodyAccess = []; });
  await importFixedFile('renamed.txt', text);
  await expect(page.locator('#toast')).toHaveText('已复用本机已有会话');
  const renamed = await cacheSummary(page);
  expect(renamed.contents).toBe(before.contents);
  expect(renamed.sessions.find((session) => session.name === 'same.md').names).toEqual(['same.md', 'renamed.txt']);
  expect(await page.evaluate(() => window.bodyAccess)).toEqual([]);
  await page.locator('.session-item[title="codex-session-demo.md"]').click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await page.evaluate(() => { window.bodyAccess = []; });
  await importFixedFile('same.md', text);
  await expect(page.locator('.conversation-filename')).toContainText('same.md');
  expect(await page.evaluate(() => window.bodyAccess.map((entry) => entry.operation))).toEqual(['get']);
  expect(await cacheSummary(page)).toEqual(renamed);
  await importFixedFile('same.md', text.replace('Question A', 'Question B').replace('Answer A', 'Answer B'));
  await expect(page.locator('.message-assistant')).toContainText('Answer B');
  const after = await cacheSummary(page);
  expect(after.contents).toBe(3);
  expect(new Set(after.sessions.map((session) => session.id)).size).toBe(3);
  await expect(page.locator('.session-item')).toHaveCount(3);
  await expect(page.locator('.session-item[title="same.md"]')).toHaveCount(1);
  await page.locator('.session-item[title="renamed.txt"]').click();
  await expect(page.locator('.message-assistant')).toContainText('Answer A');
  await upload(page, '# invalid', 'invalid.md');
  await expect(page.getByRole('alert')).toContainText('未找到对话');
  expect(await cacheSummary(page)).toEqual(after);
});

test('large cached libraries read only the active body and render file rows in batches', async ({ page }) => {
  await trackBodyAccess(page);
  await openReader(page);
  const ids = await page.evaluate(async () => {
    const files = await Promise.all(Array.from({ length: 125 }, async (_, index) => {
      const text = `## User\nQuestion ${index}\n## Assistant\nAnswer ${index}`;
      const buffer = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const id = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      return { id, text, name: `cached-${index}.md`, names: [`cached-${index}.md`], size: buffer.length, savedAt: Date.now() + index };
    }));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('codex-reader-sessions');
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['sessions', 'contents'], 'readwrite');
        for (const { text, ...metadata } of files) {
          transaction.objectStore('sessions').add(metadata);
          transaction.objectStore('contents').add({ id: metadata.id, text });
        }
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
      request.onerror = () => reject(request.error);
    });
    localStorage.setItem('codex-reader:last-session-id', files[0].id);
    localStorage.setItem('codex-reader:last-session-name', files[0].name);
    localStorage.removeItem('codex-reader:last-directory');
    return files.map((file) => file.id);
  });
  const requests = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session') requests.push(request.url()); });
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('cached-0.md');
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('#session-count')).toHaveText('126');
  await expect(page.locator('.session-item')).toHaveCount(51);
  await expect(page.locator('.session-item.active')).toHaveAttribute('title', 'cached-0.md');
  expect(await page.evaluate(() => window.bodyAccess)).toEqual([{ operation: 'get', id: ids[0] }]);
  await page.locator('#load-more-sessions').click();
  await expect(page.locator('.session-item')).toHaveCount(101);
  expect(await page.evaluate(() => window.bodyAccess)).toEqual([{ operation: 'get', id: ids[0] }]);
  await page.locator('.session-item[title="cached-124.md"]').click();
  await expect(page.locator('.message-assistant')).toContainText('Answer 124');
  expect(await page.evaluate(() => window.bodyAccess)).toEqual([{ operation: 'get', id: ids[0] }, { operation: 'get', id: ids[124] }]);
  expect(requests).toEqual([]);
});

test('directory files share the cache, update on refresh and remain readable when removed', async ({ page }) => {
  const fixture = await readFile(new URL('../fixtures/codex-session-demo.md', import.meta.url), 'utf8');
  await openReader(page);
  await upload(page, fixture, 'a-copy.md');
  await expect(page.locator('#toast')).toHaveText('已复用本机已有会话');
  await expect(page.locator('#session-count')).toHaveText('1');
  expect((await cacheSummary(page)).contents).toBe(1);
  const requests = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session') requests.push(request.url()); });
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#refresh-files')).toBeEnabled();
  expect(requests).toEqual([]);
  const updated = '# Codex conversation\n## User\nChanged question\n## Assistant\nChanged answer';
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [{ name: 'codex-session-demo.md', size: Buffer.byteLength(updated), modifiedAt: '2026-10-24T08:00:00.000Z' }] } }));
  await page.route('**/api/session?*', (route) => route.fulfill({ contentType: 'text/plain; charset=utf-8', body: updated }));
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('.message-assistant').last()).toContainText('Changed answer');
  expect(requests).toHaveLength(1);
  expect((await cacheSummary(page)).contents).toBe(2);
  // A later directory version also replaces the restored snapshot on startup.
  const latest = updated.replaceAll('Changed', 'Latest');
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [{ name: 'codex-session-demo.md', size: Buffer.byteLength(latest), modifiedAt: '2026-10-24T09:00:00.000Z' }] } }));
  await page.route('**/api/session?*', (route) => route.fulfill({ contentType: 'text/plain; charset=utf-8', body: latest }));
  await page.reload();
  await expect(page.locator('.message-assistant').last()).toContainText('Latest answer');
  expect((await cacheSummary(page)).contents).toBe(2);
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.reload();
  await expect(page.locator('.message-assistant')).toContainText('Latest answer');
  await expect(page.locator('#session-count')).toHaveText('2');
  expect(requests).toHaveLength(2);
});

test('batch imports cache each distinct file and reopen unselected files on demand', async ({ page }) => {
  await trackBodyAccess(page);
  await openReader(page);
  const second = '## User\nBatch question\n## Assistant\nBatch answer';
  await page.locator('#file-input').setInputFiles([
    { name: 'first.md', mimeType: 'text/markdown', buffer: Buffer.from(original) },
    { name: 'duplicate.txt', mimeType: 'text/plain', buffer: Buffer.from(original) },
    { name: 'second.md', mimeType: 'text/markdown', buffer: Buffer.from(second) },
  ]);
  await expect(page.locator('.conversation-filename')).toContainText('first.md');
  await expect(page.locator('#session-count')).toHaveText('3');
  expect((await cacheSummary(page)).contents).toBe(3);
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('first.md');
  await expect(page.locator('#refresh-files')).toBeEnabled();
  expect(await page.evaluate(() => window.bodyAccess.map((entry) => entry.operation))).toEqual(['get']);
  await page.locator('.session-item[title="second.md"]').click();
  await expect(page.locator('.message-assistant')).toContainText('Batch answer');
  expect(await page.evaluate(() => window.bodyAccess.map((entry) => entry.operation))).toEqual(['get', 'get']);
});

test('simultaneous imports from two tabs store one copy of the same content', async ({ page, context }) => {
  await openReader(page);
  const other = await context.newPage();
  await openReader(other);
  await Promise.all([upload(page, original, 'one.md'), upload(other, original, 'two.md')]);
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
  await expect(other.locator('.message-assistant')).toContainText('缓存恢复回答');
  const summary = await cacheSummary(page);
  expect(summary.contents).toBe(2);
  expect(summary.sessions).toHaveLength(2);
  await page.reload();
  await expect(page.locator('#session-count')).toHaveText('2');
});

test('cached restoration does not wait for a slow directory scan or require the directory API', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sessions', async (route) => { await gate; await route.fulfill({ status: 503, json: { error: 'unavailable' } }); });
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await expect(page.locator('#refresh-files')).toBeDisabled();
  release();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('已缓存的会话仍可打开');
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
});

test('a late startup scan cannot replace a newly imported file', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/sessions', async (route) => { await gate; await route.continue(); });
  await page.goto('/');
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  release();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('#session-count')).toHaveText('2');
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
});

test('disabled storage still allows importing, switching and brand navigation with a visible warning', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
  });
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await expect(page.locator('#cache-warning')).toContainText('浏览器缓存不可用');
  await page.locator('.brand').click();
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await page.locator('.session-item[title="codex-session-demo.md"]').click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await page.locator('.session-item[title="cached.md"]').click();
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
});

test('failed cache writes leave no partial records and do not lose the imported file', async ({ page }) => {
  await openReader(page);
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (args[1] === 'readwrite') queueMicrotask(() => result.abort());
      return result;
    };
  });
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await expect(page.locator('#cache-warning')).toBeVisible();
  const summary = await cacheSummary(page);
  expect(summary.contents).toBe(1);
  expect(summary.sessions).toHaveLength(1);
  await page.locator('.session-item[title="codex-session-demo.md"]').click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await page.locator('.session-item[title="cached.md"]').click();
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
});

async function deleteCurrent(page) {
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除此会话？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#reader')).toHaveAttribute('aria-busy', 'false');
}

test('delete confirmation names the selected file and cancelling preserves its cache and reading state', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await page.locator('.session-item[title="codex-session-demo.md"]').click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await page.locator('.session-item[title="cached.md"]').click();
  await page.getByRole('searchbox').fill('恢复');
  await expect(page.locator('#search-count')).toHaveText('1 / 2 条');
  const before = await cacheSummary(page);
  const button = page.getByRole('button', { name: '删除会话', exact: true });
  const removeBox = await button.boundingBox();
  const jumpBox = await page.getByRole('button', { name: '跳到最后回复' }).boundingBox();
  expect(removeBox.x + removeBox.width).toBeLessThan(jumpBox.x);
  await button.click();
  const dialog = page.getByRole('dialog', { name: '删除此会话？' });
  await expect(dialog).toContainText('cached.md');
  await expect(dialog).toContainText('此操作无法撤销');
  await expect(dialog).toContainText('原始导出文件保留');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('searchbox')).toHaveValue('恢复');
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  expect(await cacheSummary(page)).toEqual(before);
});

test('deleting an import removes its body, selects a remaining session, and permits explicit reimport', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  const id = (await cacheSummary(page)).sessions.find((session) => session.name === 'cached.md').id;
  await deleteCurrent(page);
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('.session-item[title="cached.md"]')).toHaveCount(0);
  const summary = await cacheSummary(page);
  expect(summary.contents).toBe(1);
  expect(summary.sessions.find((session) => session.id === id)).toEqual({ id, deleted: true });
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#session-count')).toHaveText('1');
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  await expect(page.locator('#session-count')).toHaveText('2');
  expect((await cacheSummary(page)).contents).toBe(2);
  expect((await cacheSummary(page)).sessions.find((session) => session.id === id).deleted).toBeUndefined();
});

test('deleting the last directory session clears the reader and does not return on refresh or reload', async ({ page }) => {
  await openReader(page);
  await page.getByRole('searchbox').fill('日志');
  await expect(page.locator('#search-count')).toHaveText('1 / 4 条');
  await deleteCurrent(page);
  await expect(page.locator('#session-count')).toHaveText('0');
  await expect(page.getByRole('heading', { name: '让每一段对话，清晰可读。' })).toBeVisible();
  await expect(page.locator('.outline-item, .message, .activity-item')).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await expect(page.locator('#search-controls')).toBeHidden();
  await expect(page.getByRole('button', { name: '下载当前原始文件' })).toBeDisabled();
  await expect(page.locator('#reading-progress')).toHaveText('0%');
  expect((await cacheSummary(page)).contents).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('codex-reader:last-session-id'))).toBeNull();
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('#session-count')).toHaveText('0');
  await page.reload();
  await expect(page.getByRole('heading', { name: '让每一段对话，清晰可读。' })).toBeVisible();
  await expect(page.locator('#session-count')).toHaveText('0');
  // The read-only server and original export remain intact.
  const response = await page.request.get('/api/session?name=codex-session-demo.md');
  expect(response.ok()).toBe(true);
  const fixture = await readFile(new URL('../fixtures/codex-session-demo.md', import.meta.url), 'utf8');
  expect(await response.text()).toBe(fixture);
  await upload(page, fixture, 'codex-session-demo.md');
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await expect(page.locator('#session-count')).toHaveText('1');
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
});

test('failed deletion rolls back all cache changes and allows retrying the confirmation', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  const before = await cacheSummary(page);
  await page.evaluate(() => {
    window.rejectDeletion = true;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (window.rejectDeletion && args[1] === 'readwrite') queueMicrotask(() => result.abort());
      return result;
    };
  });
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除此会话？' });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('删除失败，会话仍保留');
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  expect(await cacheSummary(page)).toEqual(before);
  await page.evaluate(() => { window.rejectDeletion = false; });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  expect((await cacheSummary(page)).contents).toBe(1);
});

test('another tab respects deletions when refreshing and can reimport a removed file', async ({ page, context }) => {
  await openReader(page);
  const other = await context.newPage();
  await openReader(other);
  await deleteCurrent(page);
  await other.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(other.locator('#refresh-files')).toBeEnabled();
  await expect(other.locator('#session-count')).toHaveText('0');
  await expect(other.getByRole('heading', { name: '让每一段对话，清晰可读。' })).toBeVisible();
  expect((await cacheSummary(other)).contents).toBe(0);
  const fixture = await readFile(new URL('../fixtures/codex-session-demo.md', import.meta.url), 'utf8');
  await upload(other, fixture, 'codex-session-demo.md');
  await expect(other.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  expect((await cacheSummary(page)).contents).toBe(1);
});

test('same-name updates replace the cached body and survive reload without duplicate rows', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  const oldId = (await cacheSummary(page)).sessions.find((session) => session.name === 'cached.md').id;
  const updated = `${original}\r\n## User\r\n继续处理\r\n## Assistant\r\n这是追加的新回复\r\n`;
  await upload(page, updated);
  await expect(page.locator('.message-assistant').last()).toContainText('这是追加的新回复');
  await expect(page.locator('#toast')).toHaveText('同名会话缓存已更新');
  await expect(page.locator('.session-item[title="cached.md"]')).toHaveCount(1);
  await expect(page.locator('#session-count')).toHaveText('2');
  const summary = await cacheSummary(page);
  expect(summary.contents).toBe(2);
  expect(summary.sessions.some((session) => session.id === oldId)).toBe(false);
  expect(summary.sessions.find((session) => session.name === 'cached.md').size).toBe(Buffer.byteLength(updated));
  await upload(page, '# invalid replacement');
  await expect(page.getByRole('alert')).toContainText('未找到对话');
  expect(await cacheSummary(page)).toEqual(summary);
  await page.reload();
  await expect(page.locator('.message-assistant').last()).toContainText('这是追加的新回复');
  await expect(page.locator('.session-item[title="cached.md"]')).toHaveCount(1);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载当前原始文件' }).click();
  expect(await readFile(await (await downloaded).path())).toEqual(Buffer.from(updated));
});

test('same-name replacement reuses an already cached hash and removes the obsolete body', async ({ page }) => {
  await trackBodyAccess(page);
  await openReader(page);
  await upload(page, original, 'first.md');
  await expect(page.locator('.conversation-filename')).toContainText('first.md');
  const second = '## User\n第二个文件\n## Assistant\n已经存在的内容';
  await upload(page, second, 'second.md');
  await expect(page.locator('.conversation-filename')).toContainText('second.md');
  const before = await cacheSummary(page);
  const sharedId = before.sessions.find((session) => session.name === 'second.md').id;
  const oldId = before.sessions.find((session) => session.name === 'first.md').id;
  await page.evaluate(() => { window.bodyAccess = []; });
  await upload(page, second, 'first.md');
  await expect(page.locator('.conversation-filename')).toContainText('first.md');
  await expect(page.locator('#toast')).toHaveText('同名会话缓存已更新');
  const after = await cacheSummary(page);
  expect(after.contents).toBe(2);
  expect(after.sessions.some((session) => session.id === oldId)).toBe(false);
  expect(after.sessions.find((session) => session.id === sharedId).names).toEqual(['second.md', 'first.md']);
  expect(await page.evaluate(() => window.bodyAccess.filter((entry) => ['add', 'put'].includes(entry.operation)))).toEqual([]);
  await expect(page.locator('#session-count')).toHaveText('2');
});

test('a batch selects the last valid version of its first filename', async ({ page }) => {
  await openReader(page);
  const latest = '## User\n最新问题\n## Assistant\n批量更新的最后版本';
  await page.locator('#file-input').setInputFiles([
    { name: 'same.md', mimeType: 'text/markdown', buffer: Buffer.from(original) },
    { name: 'other.md', mimeType: 'text/markdown', buffer: Buffer.from('## User\n另一个会话') },
    { name: 'same.md', mimeType: 'text/markdown', buffer: Buffer.from(latest) },
    { name: 'same.md', mimeType: 'text/markdown', buffer: Buffer.from('# invalid') },
  ]);
  await expect(page.locator('.conversation-filename')).toContainText('same.md');
  await expect(page.locator('.message-assistant')).toContainText('批量更新的最后版本');
  await expect(page.getByRole('alert')).toContainText('未找到对话');
  await expect(page.locator('.session-item[title="same.md"]')).toHaveCount(1);
  expect((await cacheSummary(page)).contents).toBe(3);
  await page.reload();
  await expect(page.locator('.message-assistant')).toContainText('批量更新的最后版本');
});

test('failed same-name updates retain the previous cache and reader until a successful retry', async ({ page }) => {
  await openReader(page);
  await upload(page, original);
  await expect(page.locator('.conversation-filename')).toContainText('cached.md');
  const before = await cacheSummary(page);
  await page.evaluate(() => {
    window.failUpdate = true;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (window.failUpdate && args[1] === 'readwrite') queueMicrotask(() => result.abort());
      return result;
    };
  });
  const updated = '## User\n更新问题\n## Assistant\n更新成功后的回答';
  await upload(page, updated);
  await expect(page.getByRole('alert')).toContainText('缓存更新失败，原会话已保留');
  await expect(page.locator('.message-assistant')).toContainText('缓存恢复回答');
  expect(await cacheSummary(page)).toEqual(before);
  await page.evaluate(() => { window.failUpdate = false; });
  await upload(page, updated);
  await expect(page.locator('.message-assistant')).toContainText('更新成功后的回答');
  await expect(page.getByRole('alert')).toBeHidden();
  expect((await cacheSummary(page)).contents).toBe(2);
});

test('an uploaded update takes precedence over the unchanged directory file on refresh and reload', async ({ page }) => {
  await openReader(page);
  const requests = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session') requests.push(request.url()); });
  const updated = '## User\n导入新导出\n## Assistant\n优先显示上传的新版本';
  await upload(page, updated, 'codex-session-demo.md');
  await expect(page.locator('.message-assistant').last()).toContainText('优先显示上传的新版本');
  await expect(page.locator('#session-count')).toHaveText('1');
  expect((await cacheSummary(page)).contents).toBe(1);
  await page.getByRole('button', { name: '刷新文件列表' }).click();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('.message-assistant')).toContainText('优先显示上传的新版本');
  await page.reload();
  await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('.message-assistant')).toContainText('优先显示上传的新版本');
  await expect(page.locator('#session-count')).toHaveText('1');
  expect(requests).toEqual([]);
});

test('simultaneous updates of one filename keep one committed version across tabs', async ({ page, context }) => {
  await openReader(page);
  await upload(page, original, 'shared.md');
  await expect(page.locator('.conversation-filename')).toContainText('shared.md');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('.conversation-filename')).toContainText('shared.md');
  await Promise.all([
    upload(page, '## User\n并发更新 A\n## Assistant\n回答 A', 'shared.md'),
    upload(other, '## User\n并发更新 B\n## Assistant\n回答 B', 'shared.md'),
  ]);
  await expect(page.locator('.message-assistant')).toContainText('回答 A');
  await expect(other.locator('.message-assistant')).toContainText('回答 B');
  await expect(page.locator('.session-item[title="shared.md"]')).toHaveCount(1);
  await expect(other.locator('.session-item[title="shared.md"]')).toHaveCount(1);
  const summary = await cacheSummary(page);
  expect(summary.sessions.filter((session) => session.name === 'shared.md')).toHaveLength(1);
  expect(summary.contents).toBe(2);
  await Promise.all([page.reload(), other.reload()]);
  await expect(page.locator('.message-assistant')).toContainText(/回答 [AB]/);
  await expect(other.locator('.message-assistant')).toContainText(await page.locator('.message-assistant .message-body').innerText());
});

test('upgrades existing caches without losing bodies and consolidates legacy same-name versions on import', async ({ page }) => {
  await page.route('**/assets/app.js', (route) => route.abort());
  await page.goto('/');
  const oldIds = await page.evaluate(async () => {
    const files = await Promise.all([
      { name: 'legacy.md', text: '## User\n旧会话一' },
      { name: 'legacy.md', text: '## User\n旧会话二' },
      { name: 'keep.md', text: '## User\n保留的另一个会话' },
    ].map(async (file, index) => {
      const bytes = new TextEncoder().encode(file.text);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const id = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      return { ...file, id, size: bytes.length, savedAt: index + 1 };
    }));
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('codex-reader-sessions', 1);
      request.onupgradeneeded = () => {
        for (const name of ['sessions', 'contents', 'directories']) request.result.createObjectStore(name, { keyPath: name === 'directories' ? 'name' : 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['sessions', 'contents'], 'readwrite');
        for (const { text, ...metadata } of files) {
          transaction.objectStore('sessions').add(metadata);
          transaction.objectStore('contents').add({ id: metadata.id, text });
        }
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = () => { database.close(); reject(transaction.error); };
      };
    });
    localStorage.setItem('codex-reader:last-session-id', files[0].id);
    return files.map((file) => file.id);
  });
  await page.unroute('**/assets/app.js');
  await page.reload();
  await expect(page.locator('.conversation-filename')).toContainText('legacy.md');
  expect((await cacheSummary(page)).contents).toBe(3);
  await upload(page, '## User\n继续会话\n## Assistant\n迁移后的最新回复', 'legacy.md');
  await expect(page.locator('.message-assistant')).toContainText('迁移后的最新回复');
  const summary = await cacheSummary(page);
  expect(summary.contents).toBe(2);
  expect(summary.sessions.some((session) => oldIds.slice(0, 2).includes(session.id))).toBe(false);
  expect(summary.sessions.some((session) => session.id === oldIds[2])).toBe(true);
  await expect(page.locator('.session-item[title="legacy.md"]')).toHaveCount(1);
  await page.locator('.session-item[title="keep.md"]').click();
  await expect(page.locator('.message-user')).toContainText('保留的另一个会话');
});
