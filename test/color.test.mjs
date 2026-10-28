import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adaptToBackground, blend, isLight, luminance, parseHex, toHex } from '../src/config/color.mjs'
import { resolveTheme, THEMES } from '../src/config/index.mjs'
import { ANSI_THEME, terminalColor } from '../src/viewer/ansi.mjs'
import { parseColors } from '../src/viewer/terminal.mjs'

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
  assert.ok(parseHex(diff.addBg).g > slate.g, 'an added line is greener than the background')
  assert.ok(parseHex(diff.delBg).r > slate.r, 'a removed line is redder than the background')
  assert.ok(parseHex(diff.addWordBg).g > parseHex(diff.addBg).g, 'changed words are tinted harder than their line')
})

test('without a background, or with tinting turned off, the fixed colours stand', () => {
  assert.equal(adaptToBackground(THEMES.dark, null), THEMES.dark)
  const fixed = resolveTheme({ preset: 'dark', diff: { tint: null } }, slate)
  assert.equal(fixed.diff.addBg, THEMES.dark.diff.addBg)
})

test('auto picks the preset that matches the terminal', () => {
  assert.ok(isLight(white))
  assert.ok(!isLight(slate))
  assert.equal(resolveTheme('auto', white).diff.addTint, THEMES.light.diff.addTint)
  assert.equal(resolveTheme('auto', slate).diff.addTint, THEMES.dark.diff.addTint)
  assert.equal(resolveTheme('auto', null).diff.addTint, THEMES.dark.diff.addTint, 'no answer falls back to dark')
  assert.equal(resolveTheme({ preset: 'auto', ui: { accent: 'magenta' } }, white).ui.accent, 'magenta')
})

test('terminal replies parse in every width xterm allows, with either terminator', () => {
  assert.deepEqual(parseColors('\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:2b2b/3131/3a3a\x1b\\\x1b[?62;22c'), {
    foreground: white,
    background: slate,
  })
  assert.deepEqual(parseColors('\x1b]11;rgb:2b/31/3a\x07').background, slate)
  assert.deepEqual(parseColors('\x1b]11;rgba:ffff/ffff/ffff/ffff\x07').background, white)
  assert.deepEqual(parseColors('\x1b[?62;22c'), { foreground: null, background: null }, 'a terminal that ignores both')
})

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const omarchy = {
  'catppuccin-latte': '#eff1f5',
  'rose-pine': '#faf4ed',
  'flexoki-light': '#FFFCF0',
  white: '#ffffff',
  everforest: '#2d353b',
  'tokyo-night': '#1a1b26',
}

for (const [name, bg] of Object.entries(omarchy)) {
  test(`on ${name}, text comes from the terminal palette and tints stay a wash`, () => {
    const theme = resolveTheme('auto', parseHex(bg))
    assert.equal(theme.syntax, 'ansi')
    assert.equal(theme.ui.muted, 'gray')
    assert.equal(theme.diff.addMark, 'green')
    for (const key of ['addBg', 'delBg']) {
      assert.ok(
        contrast(parseHex(theme.diff[key]), parseHex(bg)) < 1.35,
        `${key} ${theme.diff[key]} is subtle on ${bg}`,
      )
    }
    const added = parseHex(theme.diff.addBg)
    const removed = parseHex(theme.diff.delBg)
    assert.ok(added.g > added.r && added.g > added.b, `added ${theme.diff.addBg} reads as green`)
    assert.ok(removed.r > removed.g, `removed ${theme.diff.delBg} reads as red`)
  })
}

test('the ansi syntax theme only ever hands out palette names', () => {
  const colors = new Set(ANSI_THEME.tokenColors.map((rule) => terminalColor(rule.settings.foreground)))
  for (const color of colors) assert.ok(color === undefined || /^[a-z]+$/.test(color), String(color))
  assert.equal(terminalColor('#A00004'), 'blue')
  assert.equal(terminalColor('#3fb950'), '#3fb950', 'a real hex from another theme passes through')
})
