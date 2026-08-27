import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergePatch, promptSection, resolveTheme, stripJsonComments } from '../src/config/index.mjs'
import { DEFAULT_CONFIG } from '../src/config/defaults.mjs'

test('strips comments without touching comment-like text inside strings', () => {
  const parsed = JSON.parse(
    stripJsonComments(`{
      // a line comment
      "url": "https://example.com/x", /* trailing block */
      "path": "a/*not a comment*/b",
      "last": 1,
    }`),
  )
  assert.deepEqual(parsed, { url: 'https://example.com/x', path: 'a/*not a comment*/b', last: 1 })
})

test('keeps line numbering stable across a multi-line block comment', () => {
  const stripped = stripJsonComments('{\n/* one\n   two\n   three */\n"a": 1\n}')
  // A parse error should still point near the line the user wrote.
  assert.equal(stripped.split('\n').length, 6)
})

test('mergePatch merges objects and replaces everything else', () => {
  const merged = mergePatch({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] })
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] })
})

test('null deletes a key, which is how a severity gets removed', () => {
  const merged = mergePatch(DEFAULT_CONFIG.review.severities, { nit: null })
  assert.ok(!('nit' in merged))
  assert.ok('bug' in merged)
})

test('a partial severity override keeps the rest of the definition', () => {
  const merged = mergePatch(DEFAULT_CONFIG.review.severities, { bug: { color: 'magenta' } })
  assert.equal(merged.bug.color, 'magenta')
  assert.equal(merged.bug.glyph, DEFAULT_CONFIG.review.severities.bug.glyph)
  assert.ok(merged.bug.description.length > 0, 'the prompt text survives a recolour')
})

test('base order is preserved and new keys append', () => {
  const merged = mergePatch(DEFAULT_CONFIG.review.severities, {
    security: { description: 'd' },
    bug: { color: 'x' },
  })
  assert.deepEqual(Object.keys(merged), ['bug', 'risk', 'cleanup', 'nit', 'question', 'security'])
})

test('nulling every default hands ordering back to the user', () => {
  const merged = mergePatch(DEFAULT_CONFIG.review.severities, {
    bug: null,
    risk: null,
    cleanup: null,
    nit: null,
    question: null,
    blocker: { description: 'd' },
    note: { description: 'd' },
  })
  assert.deepEqual(Object.keys(merged), ['blocker', 'note'])
})

test('a patch never mutates the object it was applied to', () => {
  const before = JSON.stringify(DEFAULT_CONFIG)
  mergePatch(DEFAULT_CONFIG, { review: { model: 'opus', severities: { nit: null } } })
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before)
})

test('resolveTheme accepts a name, an object, or a preset plus overrides', () => {
  assert.equal(resolveTheme('light').syntax, 'pierre-light')
  assert.equal(resolveTheme('nonsense').syntax, 'pierre-dark', 'an unknown preset falls back')
  assert.equal(resolveTheme({ preset: 'light', ui: { accent: 'magenta' } }).ui.accent, 'magenta')
  assert.equal(
    resolveTheme({ preset: 'light', ui: { accent: 'magenta' } }).diff.addBg,
    resolveTheme('light').diff.addBg,
    'overriding one key keeps the rest of the preset',
  )
})

test('promptSection appends by default and replaces on request', () => {
  assert.equal(promptSection('', 'BUILT'), 'BUILT')
  assert.equal(promptSection('extra', 'BUILT'), 'BUILT\nextra\n')
  assert.equal(promptSection({ append: 'extra' }, 'BUILT'), 'BUILT\nextra\n')
  assert.equal(promptSection({ replace: 'NEW' }, 'BUILT'), 'NEW\n')
  assert.equal(promptSection({ nonsense: 'x' }, 'BUILT'), 'BUILT', 'an unrecognised shape changes nothing')
})
