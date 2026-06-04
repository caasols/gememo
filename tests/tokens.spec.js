// tokens.spec.js — UXC-0 guard. The design-token contract (extension/design_tokens.js)
// is the single source of truth; the popup.html :root block mirrors color.* for
// light mode. This spec fails if the two ever drift apart, or if a surface stops
// loading the token module.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..', 'extension');
const { TOKENS, tokenStatusFill } = require(path.join(EXT, 'design_tokens.js'));

function readFirstRootBlock(css) {
  const start = css.indexOf(':root');
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function parseVars(block) {
  const vars = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1].trim()] = m[2].trim();
  }
  return vars;
}

// CSS custom property → TOKENS.color key it must mirror (light mode).
const MIRROR = {
  '--primary': 'primary',
  '--primary-dark': 'primaryDark',
  '--danger': 'danger',
  '--danger-text': 'dangerText',
  '--success': 'success',
  '--success-text': 'successText',
  '--warn': 'warn',
  '--warn-text': 'warnText',
  '--info': 'info',
  '--surface': 'surface',
  '--text': 'text',
};

test('design_tokens.js exposes the expected shape', () => {
  expect(typeof TOKENS.color.primary).toBe('string');
  expect(TOKENS.color.danger).toBe('#ea4335');
  expect(TOKENS.radius.md).toBe('6px');
  expect(TOKENS.space.xl).toBe('16px');
  expect(TOKENS.font.ui).toContain('-apple-system');
});

test('tokenStatusFill maps every level to a token colour', () => {
  expect(tokenStatusFill('err')).toBe(TOKENS.color.danger);
  expect(tokenStatusFill('warn')).toBe(TOKENS.color.warn);
  expect(tokenStatusFill('ok')).toBe(TOKENS.color.success);
  expect(tokenStatusFill('info')).toBe(TOKENS.color.info);
  expect(tokenStatusFill('unknown')).toBe(TOKENS.color.info); // safe default
});

test('popup.html :root mirrors the colour tokens 1:1 (no drift)', () => {
  const css = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const vars = parseVars(readFirstRootBlock(css));
  for (const [cssVar, tokenKey] of Object.entries(MIRROR)) {
    expect(vars[cssVar], `${cssVar} should exist in :root`).toBeDefined();
    expect(vars[cssVar].toLowerCase(), `${cssVar} must equal TOKENS.color.${tokenKey}`)
      .toBe(TOKENS.color[tokenKey].toLowerCase());
  }
});

test('all three surfaces load design_tokens.js first', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const js = manifest.content_scripts[0].js;
  expect(js[0]).toBe('design_tokens.js');
  expect(js.indexOf('design_tokens.js')).toBeLessThan(js.indexOf('content_meet.js'));

  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  expect(bg).toMatch(/importScripts\([^)]*design_tokens\.js/);

  const popup = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  expect(popup.indexOf('src="design_tokens.js"')).toBeGreaterThan(-1);
  expect(popup.indexOf('src="design_tokens.js"')).toBeLessThan(popup.indexOf('src="popup.js"'));
});
