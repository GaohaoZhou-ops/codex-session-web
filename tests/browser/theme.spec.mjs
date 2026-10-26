import { test, expect } from './fixtures.mjs';

const themes = [
  { value: 'light', label: '浅色模式' },
  { value: 'dark', label: '深色模式' },
  { value: 'dusk', label: '暮色模式' },
];

async function previewPalette(preview) {
  return preview.evaluate((element) => {
    const background = (selector) => getComputedStyle(selector ? element.querySelector(selector) : element).backgroundColor;
    return {
      background: background(), sidebar: background('.theme-preview-sidebar'),
      topbar: background('.theme-preview-topbar'), toolbar: background('.theme-preview-toolbar'),
      user: background('.theme-preview-user'), reply: background('.theme-preview-reply'),
      logo: background('.theme-preview-logo'),
    };
  });
}

test('theme thumbnails retain their own palette and each choice matches the page and survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.conversation-filename')).toContainText('codex-session-demo.md');
  const control = page.getByRole('combobox', { name: '界面主题' });
  const menu = page.getByRole('listbox', { name: '主题选项' });
  await control.click();
  await expect(menu.getByRole('option')).toHaveCount(themes.length);
  const previews = {};
  for (const theme of themes) {
    const preview = menu.locator(`[data-preview-theme="${theme.value}"]`);
    await expect(preview).toBeVisible();
    previews[theme.value] = await previewPalette(preview);
  }
  expect(new Set(Object.values(previews).map((palette) => palette.background)).size).toBe(themes.length);
  expect(previews.dusk.logo).toBe(previews.dark.logo);

  for (const theme of [themes[1], themes[2], themes[0]]) {
    await menu.getByRole('option', { name: theme.label, exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(control).toContainText(theme.label);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.value);
    const palette = await page.evaluate(() => {
      const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return {
        background: background('body'), sidebar: background('.sidebar'),
        topbar: background('.topbar'), toolbar: background('.reader-toolbar'),
        user: background('.message-user'), reply: background('.message-final'), logo: background('.brand-mark'),
      };
    });
    expect(palette).toEqual(previews[theme.value]);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.value);
    await expect(control).toContainText(theme.label);
    await control.click();
    await expect(menu.getByRole('option', { name: theme.label, exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const previewTheme of themes) {
      expect(await previewPalette(menu.locator(`[data-preview-theme="${previewTheme.value}"]`))).toEqual(previews[previewTheme.value]);
    }
  }
});

test('theme menu supports keyboard selection, cancellation, outside clicks and focus dismissal', async ({ page }) => {
  await page.goto('/');
  const control = page.getByRole('combobox', { name: '界面主题' });
  const menu = page.getByRole('listbox', { name: '主题选项' });
  await control.focus();
  await control.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(control).toHaveAttribute('aria-activedescendant', 'theme-option-light');
  await control.press('End');
  await expect(control).toHaveAttribute('aria-activedescendant', 'theme-option-dusk');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await control.press('Escape');
  await expect(menu).toBeHidden();
  await expect(control).toBeFocused();
  await expect(control).not.toHaveAttribute('aria-activedescendant');

  await control.press('Space');
  await control.press('ArrowUp');
  await control.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');
  await expect(menu).toBeHidden();
  await control.press('Home');
  await control.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await control.click();
  await page.locator('.breadcrumb strong').click();
  await expect(menu).toBeHidden();
  await control.click();
  await control.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await control.click();
  await page.getByRole('combobox', { name: '阅读视图' }).focus();
  await expect(menu).toBeHidden();
});

test.describe('theme menu on touch screens', () => {
  test.use({ hasTouch: true });

  test('fits narrow screens and scrolls to keyboard choices in a short viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    const control = page.getByRole('combobox', { name: '界面主题' });
    const menu = page.getByRole('listbox', { name: '主题选项' });
    await control.tap();
    const bounds = await menu.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await menu.getByRole('option', { name: '暮色模式', exact: true }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dusk');

    await page.setViewportSize({ width: 568, height: 260 });
    await control.press('Home');
    expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await control.press('End');
    await expect(menu.getByRole('option', { name: '暮色模式', exact: true })).toBeInViewport({ ratio: 1 });
    const shortBounds = await menu.boundingBox();
    expect(shortBounds.y + shortBounds.height).toBeLessThanOrEqual(260);
    await control.press('Enter');
    await expect(menu).toBeHidden();
  });
});
