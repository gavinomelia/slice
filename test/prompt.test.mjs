import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analysisPrompt } from '../src/pipeline/prompt.mjs'
import { DEFAULT_CONFIG } from '../src/config/defaults.mjs'
import { mergePatch } from '../src/config/index.mjs'

const target = { kind: 'pr', repo: 'o/r', number: 7, title: 'T', author: 'a', baseRef: 'main', headRef: 'x' }
const build = (config = DEFAULT_CONFIG, conventionFiles = []) =>
  analysisPrompt({ patchPath: '/p.patch', filesPath: '/f.json', target, conventionFiles, config })

test('the default prompt names the patch, the file list, and the schema', () => {
  const prompt = build()
  assert.match(prompt, /\/p\.patch/)
  assert.match(prompt, /\/f\.json/)
  assert.match(prompt, /"overview"/)
  assert.match(prompt, /PR #7 in o\/r/)
})

test('conventions appear only when there are convention files', () => {
  assert.ok(!build().includes('Project conventions'))
  assert.match(build(DEFAULT_CONFIG, ['docs/C.md']), /docs\/C\.md/)
})

test('a section override appends by default and replaces on request', () => {
  const appended = build(mergePatch(DEFAULT_CONFIG, { review: { slicing: 'HOUSE RULE.' } }))
  assert.match(appended, /HOUSE RULE\./)
  assert.match(appended, /Slice by behavior/, 'appending keeps the built-in section')

  const replaced = build(mergePatch(DEFAULT_CONFIG, { review: { findings: { replace: 'ONLY SECURITY.' } } }))
  assert.match(replaced, /ONLY SECURITY\./)
  assert.ok(!replaced.includes('At most two or three'), 'replacing drops the built-in section')
})

test('the taxonomy drives both the instructions and the output schema', () => {
  const config = mergePatch(DEFAULT_CONFIG, {
    review: { severities: { nit: null, security: { description: 'exploitable.', glyph: '!', color: 'red' } } },
  })
  const prompt = build(config)

  assert.match(prompt, /`security` — exploitable\./)
  const enums = /"severity": "([^"]+)"/.exec(prompt)[1].split('|')
  assert.deepEqual(enums, ['bug', 'risk', 'cleanup', 'question', 'security'])
  assert.ok(!enums.includes('nit'), 'a removed severity cannot be emitted')
})

test('instructions land at the very end', () => {
  const prompt = build(mergePatch(DEFAULT_CONFIG, { review: { instructions: 'Ignore vendor/.' } }))
  assert.ok(prompt.trimEnd().endsWith('Ignore vendor/.'))
})

test('the output schema is always present, whatever is overridden', () => {
  const config = mergePatch(DEFAULT_CONFIG, {
    review: { slicing: { replace: 'x' }, summaries: { replace: 'x' }, findings: { replace: 'x' }, anchoring: { replace: 'x' } },
  })
  assert.match(build(config), /"slices": \[/, 'the viewer and the validator both depend on this shape')
})
