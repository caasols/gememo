const { test, expect } = require('@playwright/test');
const path = require('path');

// Real JS coverage measurement (Tier 2 of the test-gap audit). Uses Chromium's
// V8 coverage to report what fraction of each extension/*.js file the unit
// suites actually execute — so "tests pass" stops standing in for "tested".
//
// Method: V8 block ranges are nested; applying the largest ranges first and the
// deeper ones last yields per-byte executed/not-executed, which we sum.

function coveredRatio(entry) {
  const len = entry.source ? entry.source.length : 0;
  if (!len) return { ratio: 0, len: 0 };
  const ranges = [];
  for (const fn of entry.functions) for (const r of fn.ranges) ranges.push(r);
  ranges.sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  const covered = new Uint8Array(len);
  for (const r of ranges) {
    const v = r.count > 0 ? 1 : 0;
    for (let i = r.startOffset; i < r.endOffset && i < len; i++) covered[i] = v;
  }
  let c = 0;
  for (let i = 0; i < len; i++) c += covered[i];
  return { ratio: c / len, len };
}

async function collect(page, fileUrl, runner) {
  await page.coverage.startJSCoverage();
  await page.goto(fileUrl);
  await page.waitForFunction(`typeof window.${runner} !== 'undefined'`);
  await page.evaluate(`(async () => { await window.${runner}.run(); })()`);
  const entries = await page.coverage.stopJSCoverage();
  const out = {};
  for (const e of entries) {
    const m = (e.url || '').match(/extension\/([\w.-]+\.js)/);
    if (!m) continue;
    out[m[1]] = coveredRatio(e);
  }
  return out;
}

test('JS coverage — pure layer (constants.js) is guarded', async ({ page }) => {
  const cov = await collect(page,
    `file://${path.resolve(__dirname, 'fixture.html')}`, 'MM2C_TESTS');
  const constants = cov['constants.js'];
  expect(constants, 'constants.js should be exercised by the unit suite').toBeTruthy();
  console.log(`\nconstants.js: ${(constants.ratio * 100).toFixed(1)}% of ${constants.len} bytes executed by MM2C_TESTS`);
  // Guard: the pure helper layer must stay well-covered. Fails on regression.
  expect(constants.ratio).toBeGreaterThan(0.75);
});

test('JS coverage — content_meet.js via DOM fixture (informational)', async ({ page }) => {
  const cov = await collect(page,
    `file://${path.resolve(__dirname, 'fixture-dom.html')}`, 'MM2C_DOM_TESTS');
  const cm = cov['content_meet.js'];
  const pct = cm ? (cm.ratio * 100).toFixed(1) : 'n/a (not loaded)';
  console.log(`\ncontent_meet.js: ${pct}% executed by the DOM fixture suite`);
  console.log('NOTE: popup.js and background.js load in NO unit fixture → 0% unit coverage.');
  console.log('      Their handlers/render/flow are exercised only by the live extension.');
  // Informational — no hard threshold (content_meet is DOM/flow-bound; see ARCH-7).
  expect(true).toBe(true);
});
