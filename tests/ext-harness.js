const { chromium } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_DIR = path.resolve(__dirname, '..', 'extension');

const SERVICE_WORKER_TIMEOUT_MS = 15_000;

// Shared launch core. Boots a persistent Chromium context pointed at `extDir`
// (the real extension, or a patched copy) and waits for its MV3 service worker.
// Uses Chromium's new headless (the only headless mode that supports MV3
// extensions), so this runs on CI without a display. Returns the common shape;
// callers add their own cleanup metadata.
async function _launchWithExtDir(extDir, userDataDir) {
  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`,
        '--no-sandbox',
      ],
    });
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS });
    const extensionId = new URL(sw.url()).host;
    return { context, serviceWorker: sw, extensionId, userDataDir };
  } catch (err) {
    if (context) {
      try { await context.close(); } catch (_) {}
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

// Launch a persistent Chromium context with the real unpacked extension loaded.
async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gememo-e2e-'));
  return _launchWithExtDir(EXT_DIR, userDataDir);
}

// Launch a copy of the extension whose manifest also matches localhost / 127.0.0.1
// so the content script injects on a fake Meet page served over plain HTTP.
//
// The extension CODE is byte-identical to EXT_DIR — only the manifest's
// content_scripts[0].matches and host_permissions are widened. This keeps the
// e2e test honest: the same content_meet.js runs, just on a localhost origin.
//
// Returns the same shape as launchExtension PLUS `extDir` (the temp copy) and
// `userDataDir` so closeExtension can remove both.
async function launchExtensionLocalhost() {
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gememo-ext-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gememo-e2e-'));
  try {
    fs.cpSync(EXT_DIR, extDir, { recursive: true });
    const manifestPath = path.join(extDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const localhostMatches = ['http://localhost/*', 'http://127.0.0.1/*'];
    manifest.content_scripts[0].matches.push(...localhostMatches);
    manifest.host_permissions.push(...localhostMatches);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const launched = await _launchWithExtDir(extDir, userDataDir);
    return { ...launched, extDir };
  } catch (err) {
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    throw err;
  }
}

async function closeExtension({ context, userDataDir, extDir }) {
  await context.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  if (extDir) { try { fs.rmSync(extDir, { recursive: true, force: true }); } catch (_) {} }
}

// Stub chrome.runtime.sendNativeMessage in the SW. `responder` maps msg.type ->
// a response object; `responder.__default` is the fallback. Records every call
// in globalThis.__nativeSent (also resets it). Re-call this per test.
async function stubNativeMessage(sw, responder) {
  await sw.evaluate((responderMap) => {
    globalThis.__nativeSent = [];
    chrome.runtime.sendNativeMessage = (host, msg, cb) => {
      globalThis.__nativeSent.push({ host, msg });
      const resp = responderMap[msg.type] || responderMap.__default || { status: 'ok' };
      if (cb) setTimeout(() => cb(resp), 0);
    };
  }, responder);
}

async function getSent(sw) {
  return sw.evaluate(() => globalThis.__nativeSent || []);
}

async function seedStorage(sw, obj) {
  await sw.evaluate((o) => new Promise((res) => chrome.storage.local.set(o, res)), obj);
}

async function getStorage(sw, keys) {
  return sw.evaluate((k) => new Promise((res) => chrome.storage.local.get(k, res)), keys);
}

async function clearStorage(sw) {
  await sw.evaluate(() => Promise.all([
    new Promise((res) => chrome.storage.local.clear(res)),
    new Promise((res) => (chrome.storage.session ? chrome.storage.session.clear(res) : res())),
  ]));
}

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

// Send a runtime message from an extension page so background.onMessage fires
// with a non-service-worker sender (sender.tab is undefined). Returns the response.
async function sendFromPage(page, message) {
  return page.evaluate((m) => new Promise((res) => chrome.runtime.sendMessage(m, res)), message);
}

module.exports = {
  launchExtension, launchExtensionLocalhost, closeExtension, EXT_DIR,
  stubNativeMessage, getSent, seedStorage, getStorage, clearStorage, openPopup, sendFromPage,
};
