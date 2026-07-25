import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  fullyParallel: false, // Electron tests share state; run serially
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github']]
    : // 'never' locally too: many concurrent agents run this suite, and
      // 'on-failure' auto-opens a report browser page (localhost:9323) at the
      // user on every failing run. View reports on demand with
      // `npx playwright show-report`.
      [['html', { open: 'never' }]],
  timeout: 120_000, // Electron startup can be slow
  expect: {
    timeout: 15_000,
  },
  use: {
    trace: 'on',
    screenshot: 'on',
    video: 'on',
  },
})
