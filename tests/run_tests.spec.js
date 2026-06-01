const { test, expect } = require('@playwright/test');
const path = require('path');

test('MM2C pure + fixture tests', async ({ page }) => {
  const fixturePath = `file://${path.resolve(__dirname, 'fixture.html')}`;
  await page.goto(fixturePath);

  // Wait for the test suite to be available
  await page.waitForFunction(() => typeof window.MM2C_TESTS !== 'undefined');

  // Run the suite and collect results
  const { passed, total, results } = await page.evaluate(async () => {
    return await MM2C_TESTS.run();
  });

  // Report any failures
  const failures = results.filter(r => !r.ok);
  if (failures.length > 0) {
    console.error('\nFailed tests:');
    failures.forEach(f => console.error(`  ❌ ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
  }

  console.log(`\n${passed}/${total} tests passed`);
  expect(failures).toHaveLength(0);
});
