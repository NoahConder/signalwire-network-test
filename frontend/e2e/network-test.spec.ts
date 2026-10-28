import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { drainLog, openPage, runStatus, startRun, stepRows, stubSteps } from './helpers';

const STEP_IDS = ['signaling', 'turn-udp', 'turn-tcp', 'turn-tls', 'voice-opus', 'voice-pcmu', 'video-turn', 'video-direct'];

test('loads idle: the eight steps pending, Start enabled, the region from the query', async ({ page }) => {
  await openPage(page, '/?region=eu');
  await expect(page.getByRole('heading', { level: 1, name: 'Network test' })).toBeVisible();
  const rows = stepRows(page);
  await expect(rows).toHaveCount(8);
  for (let i = 0; i < STEP_IDS.length; i++) {
    await expect(rows.nth(i)).toHaveAttribute('data-step', STEP_IDS[i]);
    await expect(rows.nth(i)).toHaveAttribute('data-status', 'pending');
  }
  await expect(page.getByRole('button', { name: 'Start test' })).toBeEnabled();
  await expect(runStatus(page)).toHaveText('Ready. Nothing has run yet.');
  // The badge and the select agree on the preselected region.
  await expect(page.locator('header').getByText('eu', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Region')).toHaveValue('eu');
  await expect(page.getByRole('button', { name: 'Download report' })).toHaveCount(0);
});

test('an unknown ?region falls back to the default', async ({ page }) => {
  await openPage(page, '/?region=mars');
  await expect(page.getByLabel('Region')).toHaveValue('global');
  await expect(page.locator('header').getByText('global', { exact: true })).toBeVisible();
});

test('a passing run: every row passes in order, details expand, the report downloads', async ({ page }) => {
  await openPage(page);
  await stubSteps(page);
  await startRun(page);
  await expect(runStatus(page)).toHaveText('Finished: 8 passed.');
  const rows = stepRows(page);
  for (let i = 0; i < STEP_IDS.length; i++) await expect(rows.nth(i)).toHaveAttribute('data-status', 'passed');
  expect(await drainLog(page)).toEqual(STEP_IDS.map((id) => ['step', id]));
  await expect(rows.nth(4)).toContainText('opus 48k · ↑ 62 kbps ↓ 61 kbps');

  // The details are hidden until the row is opened.
  const udp = rows.nth(1);
  const toggle = udp.getByRole('button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(udp.locator('dl')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(udp.locator('dl')).toContainText('Ping rtt ms');
  await expect(udp.locator('dl')).toContainText('38.5');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download report' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^signalwire-network-test-.*\.json$/);
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(Object.keys(report).sort()).toEqual([
    'browser', 'diagnostics', 'events', 'format', 'generatedAt', 'page', 'rtcstats', 'rtcstatsDump', 'run',
  ]);
  expect(report.rtcstatsDump.startsWith('RTCStatsDump\n')).toBe(true);
  expect(report.rtcstats.truncated).toBe(false);
  expect(report.format).toBe('signalwire-network-test/1');
  expect(report.run.status).toBe('passed');
  expect(report.run.region).toBe('global');
  expect(report.run.steps.map((step: { id: string; status: string }) => [step.id, step.status])).toEqual(STEP_IDS.map((id) => [id, 'passed']));
  expect(report.run.steps[1].details.pingRttMs).toBe(38.5);
  expect(report.page.sdkVersion).toMatch(/^4\./);
  expect(report.browser.userAgent).toContain('Chrome');
  expect(report.events.some((line: string) => /\[test\] Test finished: passed/.test(line))).toBe(true);
  // No SDK session in e2e mode, so no SDK diagnostics; the key is still there.
  expect(report.diagnostics).toBeNull();
});

test('a signaling failure stops the run: the other steps are skipped, nothing else runs', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, { signaling: { status: 'failed', result: 'Backend unreachable — is the Flask server running on :5001?' } });
  await startRun(page);
  await expect(runStatus(page)).toHaveText('Finished with failures: 1 failed, 7 skipped.');
  const rows = stepRows(page);
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'failed');
  await expect(rows.nth(0)).toContainText('Backend unreachable');
  for (let i = 1; i < 8; i++) {
    await expect(rows.nth(i)).toHaveAttribute('data-status', 'skipped');
    await expect(rows.nth(i)).toContainText('Skipped: signaling failed');
  }
  expect(await drainLog(page)).toEqual([['step', 'signaling']]);
  // The report is still offered, for the failure.
  await expect(page.getByRole('button', { name: 'Download report' })).toBeVisible();
});

test('a later failure does not stop the run; warnings and skips are counted', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, {
    'turn-tcp': { status: 'warning', result: 'TURN allocation OK over TCP (relay candidate in 300 ms), but the relay between the two peers was not confirmed (TURN relay timed out after 12 s)' },
    'turn-tls': { status: 'skipped', result: 'Not advertised: the platform handed this session no turns: URL, so TURN over TLS was not tested' },
    'voice-pcmu': { status: 'failed', result: 'Negotiated opus 48k instead of PCMU' },
  });
  await startRun(page);
  await expect(runStatus(page)).toHaveText('Finished with failures: 5 passed, 1 with warnings, 1 failed, 1 skipped.');
  expect(await drainLog(page)).toEqual(STEP_IDS.map((id) => ['step', id]));
  const rows = stepRows(page);
  await expect(rows.nth(2)).toHaveAttribute('data-status', 'warning');
  await expect(rows.nth(3)).toHaveAttribute('data-status', 'skipped');
  await expect(rows.nth(5)).toHaveAttribute('data-status', 'failed');
});

test('a run with only warnings finishes with warnings', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, { 'turn-udp': { status: 'warning', result: 'TURN allocation OK over UDP, but the relay between the two peers was not confirmed' } });
  await startRun(page);
  await expect(runStatus(page)).toHaveText('Finished with warnings: 7 passed, 1 with warnings.');
});

test('Copy summary puts a plain-text summary on the clipboard', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, { 'turn-tls': { status: 'skipped', result: 'Not advertised' } });
  await startRun(page);
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const lines = text.split('\n');
  expect(lines[0]).toMatch(/^SignalWire network test — \d{4}-.* — region global — result: passed$/);
  expect(lines).toContainEqual(expect.stringMatching(/^PASS Signaling \(\d+\.\d s\): Connected and authenticated in 312 ms/));
  expect(lines).toContainEqual(expect.stringMatching(/^SKIP TURN over TLS .*: Not advertised$/));
});

test('Stop ends a running step and skips the rest', async ({ page }) => {
  await openPage(page);
  await stubSteps(page, { 'turn-udp': null });
  await page.getByRole('button', { name: 'Start test' }).click();
  await expect(runStatus(page)).toHaveText('Running TURN over UDP…');
  await expect(stepRows(page).nth(1)).toHaveAttribute('data-status', 'running');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(runStatus(page)).toHaveText('Stopped.');
  const rows = stepRows(page);
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'passed');
  for (let i = 1; i < 8; i++) {
    await expect(rows.nth(i)).toHaveAttribute('data-status', 'skipped');
    await expect(rows.nth(i)).toContainText('Stopped');
  }
  expect(await drainLog(page)).toEqual([
    ['step', 'signaling'],
    ['step', 'turn-udp'],
  ]);
  // A second run starts clean.
  await stubSteps(page);
  await startRun(page);
  await expect(runStatus(page)).toHaveText('Finished: 8 passed.');
});

test('a failed configuration request shows the reason and retries', async ({ page }) => {
  // The dev server runs React in StrictMode, which mounts the page's effects
  // twice and keeps only the second request, so a stub that fails "the first
  // time" is spent on the discarded one. Fail by a flag the test flips.
  let fail = true;
  await page.route('**/api/network-test/config', (route) =>
    fail
      ? route.fulfill({ status: 503, json: { success: false, error: 'No region configured' } })
      : route.fulfill({ json: { success: true, data: { regions: ['global'], default_region: 'global', captcha_required: false } } }),
  );
  await page.goto('/?e2e=1');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('No region configured — check backend/.env and the backend log.');
  await expect(page.getByRole('button', { name: 'Start test' })).toBeDisabled();
  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start test' })).toBeEnabled();
  // One region: no select, just the badge.
  await expect(page.getByLabel('Region')).toHaveCount(0);
  await expect(page.locator('header').getByText('global', { exact: true })).toBeVisible();
});

test('a backend that requires a captcha the page was built without says so', async ({ page }) => {
  await openPage(page, '/', { success: true, data: { regions: ['global'], default_region: 'global', captcha_required: true } });
  await expect(page.getByRole('alert')).toContainText('built without TURNSTILE_SITE_KEY');
  await expect(page.getByRole('button', { name: 'Start test' })).toBeDisabled();
});
