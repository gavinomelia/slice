/**
 * Getting an analysis out of a model reply.
 *
 * These are the shapes a real run actually produces when it goes wrong: a
 * sentence before the JSON, a code fence around it, a reply cut off partway,
 * and braces inside a `fix` field that contains code.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractJson, limitNotice } from '../src/pipeline/reply.mjs'

const analysis = { slices: [{ id: 'a', paths: ['a.rb'] }], findings: [] }

test('a bare JSON object is read as-is', () => {
  assert.deepEqual(extractJson(JSON.stringify(analysis)), analysis)
})

test('prose on either side of the object is ignored', () => {
  const reply = `Here is the review you asked for:\n\n${JSON.stringify(analysis)}\n\nLet me know if you want more detail.`
  assert.deepEqual(extractJson(reply), analysis)
})

test('a code fence around the object is ignored', () => {
  assert.deepEqual(extractJson('```json\n' + JSON.stringify(analysis) + '\n```'), analysis)
})

test('the object that looks like an analysis wins over an earlier one', () => {
  // A reply that shows the schema back before answering is the common case.
  const reply = `An example: {"note": "not the answer"}\n\nThe review:\n${JSON.stringify(analysis)}`
  assert.deepEqual(extractJson(reply), analysis)
})

test('with no analysis-shaped object, the first parseable one is returned', () => {
  assert.deepEqual(extractJson('noise {"a":1} more {"b":2}'), { a: 1 })
})

test('braces inside strings do not unbalance the scan', () => {
  const withCode = { slices: [], findings: [{ fix: 'use `if (x) { return y }` instead' }] }
  assert.deepEqual(extractJson(`prelude ${JSON.stringify(withCode)}`), withCode)
})

test('an escaped quote inside a string does not end it early', () => {
  const quoted = { slices: [], findings: [{ why: 'the header says "author" and { breaks' }] }
  assert.deepEqual(extractJson(JSON.stringify(quoted)), quoted)
})

test('a reply truncated mid-object yields nothing rather than throwing', () => {
  assert.equal(extractJson('{"slices": [{"id": "a", "paths": ["a.rb"'), null)
})

test('a reply with no JSON at all yields nothing', () => {
  assert.equal(extractJson('I was unable to complete the review.'), null)
})

test('non-string input is not an error', () => {
  assert.equal(extractJson(undefined), null)
  assert.equal(extractJson(null), null)
})

test('a usage limit is recognised and returned as the line that said so', () => {
  const stderr = 'some noise\nYou have hit your usage limit. Resets at 4pm.\nmore noise'
  assert.equal(limitNotice(stderr), 'You have hit your usage limit. Resets at 4pm.')
})

test('a limit is looked for across every text it is given, in order', () => {
  assert.equal(limitNotice(null, 'fine', 'weekly limit reached'), 'weekly limit reached')
})

test('an ordinary failure is not mistaken for a limit', () => {
  assert.equal(limitNotice('Error: ENOENT, no such file or directory'), null)
  // "limit" alone is not enough — maxLineDiffLength talk should not match.
  assert.equal(limitNotice('the line length limit was applied'), null)
})

test('non-string inputs are skipped rather than throwing', () => {
  assert.equal(limitNotice(undefined, null, 42), null)
})
