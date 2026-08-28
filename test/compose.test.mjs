/**
 * Draft persistence and the editor buffer.
 *
 * The $EDITOR round trip itself is not tested — it takes over the real
 * terminal — but everything either side of it is, because both directions can
 * silently eat somebody's review comment.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { draftsPathFor, loadDrafts, saveDrafts, seedFromFinding, stripComments } from '../src/viewer/compose.mjs'

const dir = mkdtempSync(join(tmpdir(), 'slice-compose-'))
const reviewPath = join(dir, 'pr-1.review.json')
after(() => rmSync(dir, { recursive: true, force: true }))

test('drafts live beside the review they belong to', () => {
  assert.equal(draftsPathFor('/tmp/x/pr-9.review.json'), '/tmp/x/pr-9.drafts.json')
})

test('drafts survive a round trip', () => {
  const drafts = [{ path: 'a.rb', line: 4, side: 'additions', body: 'this leaks' }]
  saveDrafts(reviewPath, drafts)
  assert.deepEqual(loadDrafts(reviewPath), drafts)
})

test('saving an empty list removes the file rather than leaving an empty one', () => {
  saveDrafts(reviewPath, [{ path: 'a.rb', line: 1, side: 'additions', body: 'x' }])
  saveDrafts(reviewPath, [])
  assert.equal(existsSync(draftsPathFor(reviewPath)), false)
  assert.deepEqual(loadDrafts(reviewPath), [])
})

test('a corrupt drafts file starts clean instead of stopping the review', () => {
  writeFileSync(draftsPathFor(reviewPath), '{ not json')
  assert.deepEqual(loadDrafts(reviewPath), [])

  writeFileSync(draftsPathFor(reviewPath), '{"not": "an array"}')
  assert.deepEqual(loadDrafts(reviewPath), [])
})

test('no drafts file at all is not an error', () => {
  assert.deepEqual(loadDrafts(join(dir, 'never-written.review.json')), [])
})

test('comment lines are stripped and the body is trimmed', () => {
  assert.equal(stripComments('# hint\nreal text\n# more\n'), 'real text')
})

test('only a # in the first column is a comment', () => {
  // A review comment may well be about a markdown heading, or C#.
  assert.equal(stripComments('  # indented stays\ntrailing C# stays'), '# indented stays\ntrailing C# stays')
})

test('an all-comment buffer comes back empty, which callers read as "discard"', () => {
  assert.equal(stripComments('# hint\n#\n# more\n'), '')
})

test('a finding seeds a comment with its title, reason, and fix', () => {
  const seed = seedFromFinding({
    title: 'Nil author crashes the header',
    why: 'author is nil for bots',
    fix: '`author&.login`',
  })
  assert.equal(seed, '**Nil author crashes the header**\n\nauthor is nil for bots\n\n`author&.login`')
})

test('a finding with no fix does not trail blank lines', () => {
  assert.equal(seedFromFinding({ title: 'T', why: 'W', fix: '   ' }), '**T**\n\nW')
})

test('no finding means an empty buffer, not the word undefined', () => {
  assert.equal(seedFromFinding(null), '')
  assert.equal(seedFromFinding(undefined), '')
})
