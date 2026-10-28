import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adaptToBackground, blend, isLight, parseHex, toHex } from '../src/config/color.mjs'
import { resolveTheme, THEMES } from '../src/config/index.mjs'
import { parseBackground } from '../src/viewer/terminal.mjs'

const slate = { r: 0x2b, g: 0x31, b: 0x3a }
const white = { r: 255, g: 255, b: 255 }

test('hex round-trips, and anything else parses to null', () => {
  assert.deepEqual(parseHex('#3fb950'), { r: 0x3f, g: 0xb9, b: 0x50 })
  assert.equal(toHex(parseHex('#3fb950')), '#3fb950')
  assert.equal(parseHex('green'), null)
  assert.equal(parseHex(null), null)
})

test('blending is a straight mix from the background toward the colour', () => {
  assert.equal(toHex(blend(slate, white, 0)), '#2b313a')
  assert.equal(toHex(blend(slate, white, 1)), '#ffffff')
  assert.equal(toHex(blend({ r: 0, g: 0, b: 0 }, white, 0.5)), '#808080')
})

test('diff tints sit just above the terminal background, not below it', () => {
  const { diff } = adaptToBackground(THEMES.dark, slate)
  assert.equal(diff.addBg, '#2e443d')
  assert.ok(parseHex(diff.addBg).g > slate.g, 'an added line is greener than the background')
  assert.ok(parseHex(diff.delBg).r > slate.r, 'a removed line is redder than the background')
  assert.ok(parseHex(diff.addWordBg).g > parseHex(diff.addBg).g, 'changed words are tinted harder than their line')
})

test('without a background, or with opacity turned off, the fixed colours stand', () => {
  assert.equal(adaptToBackground(THEMES.dark, null), THEMES.dark)
  const fixed = resolveTheme({ preset: 'dark', diff: { opacity: null } }, slate)
  assert.equal(fixed.diff.addBg, THEMES.dark.diff.addBg)
})

test('auto picks the preset that matches the terminal', () => {
  assert.ok(isLight(white))
  assert.ok(!isLight(slate))
  assert.equal(resolveTheme('auto', white).syntax, 'pierre-light')
  assert.equal(resolveTheme('auto', slate).syntax, 'pierre-dark')
  assert.equal(resolveTheme('auto', null).syntax, 'pierre-dark', 'no answer falls back to dark')
  assert.equal(resolveTheme({ preset: 'auto', ui: { accent: 'magenta' } }, white).ui.accent, 'magenta')
})

test('terminal replies parse in every width xterm allows, with either terminator', () => {
  assert.deepEqual(parseBackground('\x1b]11;rgb:2b2b/3131/3a3a\x1b\\\x1b[?62;22c'), slate)
  assert.deepEqual(parseBackground('\x1b]11;rgb:2b/31/3a\x07'), slate)
  assert.deepEqual(parseBackground('\x1b]11;rgba:ffff/ffff/ffff/ffff\x07'), white)
  assert.equal(parseBackground('\x1b[?62;22c'), null, 'a terminal that ignores the query')
})
