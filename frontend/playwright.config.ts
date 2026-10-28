import { defineConfig, devices } from '@playwright/test';

// Runs against the Vite dev server through the dev-only `?e2e=1` seam (see
// components/NetworkTest.tsx): no SignalWire credentials or backend are
// needed. Tests answer the configuration request with a route and replace
// the runner's step functions (e2e/helpers.ts).
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    permissions: ['clipboard-read', 'clipboard-write'],
    // No spinner animation: under software rendering (CI, GPU-less
    // containers) every animated frame recomposites the blurred header,
    // which starved the page's timers and made stubbed steps take seconds.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // A phone: the steps and the event log stack.
      name: 'phone',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
    {
      // A desktop window: the event log sits beside the steps.
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
