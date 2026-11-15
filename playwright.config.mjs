import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8765',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
    launchOptions: process.env.ROPPO_CHROMIUM_PATH
      ? { executablePath: process.env.ROPPO_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'python3 -m http.server 8765 --bind 127.0.0.1 --directory _site',
    url: 'http://127.0.0.1:8765',
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
