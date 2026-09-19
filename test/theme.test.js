import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const html  = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
const css   = readFileSync(join(PUBLIC_DIR, 'style.css'), 'utf8');
const appJs = readFileSync(join(PUBLIC_DIR, 'app.js'), 'utf8');
const initJs = readFileSync(join(PUBLIC_DIR, 'theme-init.js'), 'utf8');

// The server sends `script-src 'self'` with no unsafe-inline and no hashes,
// so any inline <script> body is silently blocked by the browser.
test('no inline script bodies in index.html (blocked by CSP)', () => {
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  assert.equal(inlineScripts.length, 0,
    `found ${inlineScripts.length} inline script(s); CSP script-src 'self' would block them`);
});

test('theme init runs before the stylesheet so there is no flash', () => {
  const initIdx  = html.indexOf('theme-init.js');
  const styleIdx = html.indexOf('style.css');
  assert.ok(initIdx !== -1, 'theme-init.js is not referenced');
  assert.ok(initIdx < styleIdx, 'theme-init.js must load before style.css');
});

test('theme init is not deferred or async', () => {
  const tag = html.match(/<script[^>]*theme-init\.js[^>]*>/i)?.[0] ?? '';
  assert.ok(!/\b(defer|async)\b/i.test(tag), 'theme-init.js must block to avoid a flash');
});

test('theme init falls back to the OS preference when nothing is stored', () => {
  assert.match(initJs, /prefers-color-scheme/);
  assert.match(initJs, /traintalk-theme/);
});

test('theme init tolerates blocked sessionStorage', () => {
  // Safari private mode throws on sessionStorage access rather than returning null.
  assert.match(initJs, /try\s*\{[\s\S]*sessionStorage[\s\S]*\}\s*catch/);
});

test('both themes define every colour variable', () => {
  const block = (sel) => {
    const i = css.indexOf(sel);
    assert.ok(i !== -1, `missing ${sel} block`);
    return css.slice(i, css.indexOf('}', i));
  };
  const names = (s) => (s.match(/--[a-z-]+(?=\s*:)/g) ?? []).sort();

  const dark  = names(block('[data-theme="dark"]'));
  const light = names(block('[data-theme="light"]'));
  assert.deepEqual(light, dark, 'light and dark must define the same variables');
  assert.ok(dark.length >= 10, `expected a full palette, got ${dark.length} variables`);
});

test('[hidden] is defined so the SVG theme icons can hide', () => {
  // SVG gets no UA [hidden] rule, unlike HTML elements.
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none/);
});

test('theme icons are toggled by attribute, not the SVG .hidden property', () => {
  // el.hidden = x on an SVGElement sets a dead JS expando — it is not reflected.
  assert.ok(!/icon(Sun|Moon)\.hidden\s*=/.test(appJs),
    'assigning .hidden on an SVG element has no effect; use setAttribute/removeAttribute');
  assert.match(appJs, /setAttribute\('hidden'/);
  assert.match(appJs, /removeAttribute\('hidden'/);
});

test('incoming bubbles are explicitly start-aligned', () => {
  // Without this, flex defaults to `stretch` and every incoming bubble
  // inflates to the full max-width regardless of its text length.
  const i = css.indexOf('.msg {');
  assert.ok(i !== -1, '.msg rule not found');
  assert.match(css.slice(i, css.indexOf('}', i)), /align-self:\s*flex-start/);
});

test('message input is at least 16px so iOS does not zoom on focus', () => {
  const i = css.indexOf('#msg-input {');
  assert.ok(i !== -1, '#msg-input rule not found');
  const size = css.slice(i, css.indexOf('}', i)).match(/font-size:\s*(\d+)px/);
  assert.ok(size, '#msg-input must set an explicit px font-size');
  assert.ok(Number(size[1]) >= 16, `font-size ${size[1]}px would trigger iOS zoom`);
});

test('layout uses dvh so mobile browser chrome cannot hide the input row', () => {
  assert.match(css, /height:\s*100dvh/);
});
