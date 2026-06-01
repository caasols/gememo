const { test, expect } = require('@playwright/test');
const path = require('path');

test('MM2C Leave send-path smoke test', async ({ page }) => {
  const fixturePath = `file://${path.resolve(__dirname, 'fixture.html')}`;
  await page.goto(fixturePath);

  await page.waitForFunction(() => typeof window.MM2C_TESTS !== 'undefined');

  const { passed, total, results } = await page.evaluate(async () => {
    return await MM2C_TESTS.runSmoke();
  });

  const failures = results.filter(r => !r.ok);
  if (failures.length > 0) {
    console.error('\nFailed smoke tests:');
    failures.forEach(f => console.error(`  ❌ ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
  }

  console.log(`\n${passed}/${total} smoke tests passed`);
  expect(failures).toHaveLength(0);
});
