import { test, expect } from './fixtures.mjs';

async function openReader(page) {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toHaveText('codex-session-demo.md');
}

async function dragSidebar(page, delta) {
  const box = await page.getByRole('separator', { name: '调整侧栏宽度' }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('dragged sidebar width survives reload and temporary narrow or mobile layouts', async ({ page }) => {
  await openReader(page);
  await dragSidebar(page, 140);
  await expect(page.locator('#sidebar')).toHaveCSS('width', '420px');
  await expect(page.locator('body')).not.toHaveClass(/is-resizing-sidebar/);
  expect(await page.evaluate(() => localStorage.getItem('codex-reader:sidebar-width'))).toBe('420');
  await page.reload();
  await expect(page.locator('#sidebar')).toHaveCSS('width', '420px');
  await page.setViewportSize({ width: 780, height: 844 });
  await expect(page.locator('#sidebar')).toHaveCSS('width', '294px');
  expect(await page.locator('.workspace').evaluate((element) => element.clientWidth)).toBeGreaterThanOrEqual(480);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator', { name: '调整侧栏宽度' })).toBeHidden();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.locator('#sidebar')).toHaveCSS('width', '280px');
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('#sidebar')).toHaveCSS('width', '420px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});

test('splitter clamps dragging, supports keyboard controls and resets on double click', async ({ page }) => {
  await openReader(page);
  const splitter = page.getByRole('separator', { name: '调整侧栏宽度' });
  await dragSidebar(page, -270);
  await expect(page.locator('#sidebar')).toHaveCSS('width', '220px');
  await dragSidebar(page, 1100);
  await expect(page.locator('#sidebar')).toHaveCSS('width', '864px');
  await expect(splitter).toHaveAttribute('aria-valuenow', '864');
  expect(await page.locator('.workspace').evaluate((element) => element.clientWidth)).toBeGreaterThanOrEqual(480);
  await splitter.press('Home');
  await expect(page.locator('#sidebar')).toHaveCSS('width', '220px');
  await splitter.press('ArrowRight');
  await expect(page.locator('#sidebar')).toHaveCSS('width', '236px');
  await splitter.press('ArrowLeft');
  await expect(page.locator('#sidebar')).toHaveCSS('width', '220px');
  await splitter.press('End');
  await expect(page.locator('#sidebar')).toHaveCSS('width', '864px');
  await splitter.dblclick();
  await expect(page.locator('#sidebar')).toHaveCSS('width', '280px');
  expect(await page.evaluate(() => localStorage.getItem('codex-reader:sidebar-width'))).toBeNull();
  await page.reload();
  await expect(page.locator('#sidebar')).toHaveCSS('width', '280px');
});
