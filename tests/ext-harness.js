const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_DIR = path.resolve(__dirname, '..', 'extension');

// Launch a persistent Chromium context with the real unpacked extension loaded.
// Uses Chromium's new headless (the only headless mode that supports MV3
// extensions), so this runs on CI without a display.
async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gememo-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-sandbox',
    ],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  return { context, serviceWorker: sw, extensionId, userDataDir };
}

async function closeExtension({ context, userDataDir }) {
  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { launchExtension, closeExtension, EXT_DIR };
