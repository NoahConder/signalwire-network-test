import { expect, test } from '@playwright/test';
import { openPage, runStatus, startRun, stepRows, stubSteps } from './helpers';

test('landmarks, labels, one heading, a zoomable viewport and the dark default', async ({ page }) => {
  await openPage(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: 'Events' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Test steps' })).toBeVisible();
  // Every icon-only button carries a name.
  await expect(page.getByRole('button', { name: /Switch to the (light|dark) theme/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy event log' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear event log' })).toBeVisible();
  const viewport = (await page.locator('meta[name="viewport"]').getAttribute('content')) ?? '';
  expect(viewport).not.toContain('user-scalable=no');
  expect(viewport).toContain('viewport-fit=cover');
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('the run status is a live region and every row speaks its state', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, { 'turn-tls': { status: 'skipped', result: 'Not advertised' } });
  const status = runStatus(page);
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await startRun(page);
  await expect(status).toHaveText('Finished: 7 passed, 1 skipped.');
  const rows = stepRows(page);
  // The visually hidden status prefix, read by the accessible name of the toggle.
  await expect(rows.nth(0).getByRole('button')).toHaveAccessibleName(/^Signaling.*Passed: Connected and authenticated/);
  await expect(rows.nth(3).getByRole('button')).toHaveAccessibleName(/Skipped: Not advertised/);
  // Each row is a disclosure that the keyboard can open.
  const toggle = rows.nth(0).getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const detailsId = await toggle.getAttribute('aria-controls');
  await expect(page.locator(`#${detailsId}`)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('focus order runs from the controls through the rows to the report actions', async ({ page }) => {
  // A full run plus eighteen key presses: past the default timeout under
  // software rendering (headless Chromium in a GPU-less container).
  test.slow();
  await openPage(page);
  await stubSteps(page);
  const rows = stepRows(page);
  await page.getByRole('button', { name: 'Start test' }).focus();
  await page.keyboard.press('Tab');
  await expect(rows.nth(0).getByRole('button')).toBeFocused();
  for (let i = 0; i < 7; i++) await page.keyboard.press('Tab');
  await expect(rows.nth(7).getByRole('button')).toBeFocused();
  await startRun(page);
  // Start, the eight rows, then the report actions.
  await page.getByRole('button', { name: 'Start test' }).focus();
  for (let i = 0; i < 9; i++) await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Download report' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Copy summary' })).toBeFocused();
});
