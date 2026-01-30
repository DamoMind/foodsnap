import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: process.env.TEST_URL || 'https://foodsnap.duku.app',
    extraHTTPHeaders: {
      'X-User-Id': 'e2e-test-user',
    },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
