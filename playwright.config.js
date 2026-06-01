const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  use: {
    channel: 'chromium',
  },
  reporter: 'list',
  timeout: 30_000,
});
