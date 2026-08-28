/**
 * The viewer's navigation arithmetic.
 *
 * Split-view cursor handling is the part of the viewer most likely to be
 * quietly wrong: a pair is two rows drawn as one, so an off-by-one lands `c` on
 * the line above the one you were looking at, and nothing on screen says so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildTree, cellAt, draftKey, rowHasLine, sideAt, windowFor } from '../src/viewer/tree.mjs'

const review = (over = {}) => ({
  target: { kind: 'pr', number: 7 },
  slices: [
    { id: 's1', paths: ['a.rb', 'b.rb'] },
    { id: 's2', paths: ['c.rb'] },
  ],
  files: { 'a.rb': {}, 'b.rb': {}, 'c.rb': {} },
  findings: [],
  ...over,
})

test('the tree opens on the overview and groups files under their slice', () => {
  const rows = buildTree(review())
  assert.deepEqual(
    rows.map((r) => r.type),
    ['overview', 'slice', 'file', 'file', 'slice', 'file', 'drafts'],
  )
})

test('the last file of a slice is marked, so the tree can close the group', () => {
  const rows = buildTree(review()).filter((r) => r.type === 'file')
  assert.deepEqual(
    rows.map((r) => [r.path, r.last]),
    [
      ['a.rb', false],
      ['b.rb', true],
      ['c.rb', true],
    ],
  )
})

test('a slice path with no file behind it is not drawn', () => {
  // mergeReview should never emit one, but the viewer also opens files written
  // by an older run, and a row that selects nothing is a dead end.
  const rows = buildTree(review({ files: { 'a.rb': {}, 'c.rb': {} } }))
  assert.deepEqual(
    rows.filter((r) => r.type === 'file').map((r) => r.path),
    ['a.rb', 'c.rb'],
  )
  assert.equal(rows.find((r) => r.type === 'slice' && r.sliceIndex === 0).sliceIndex, 0)
})

test('a branch diff gets no draft review row, because there is nothing to post to', () => {
  const rows = buildTree(review({ target: { kind: 'branch', number: null } }))
  assert.ok(!rows.some((r) => r.type === 'drafts'))
})

test('a unified row is its own answer, and a hunk header is not commentable', () => {
  const row = { kind: 'add', line: 12 }
  assert.equal(cellAt(row, 'right'), row)
  assert.equal(cellAt({ kind: 'hunk' }, 'right'), null)
  assert.equal(cellAt(null, 'right'), null)
})

test('a split pair hands back the column that was asked for', () => {
  const left = { kind: 'del', line: 3 }
  const right = { kind: 'add', line: 4 }
  const pair = { kind: 'pair', left, right }

  assert.equal(cellAt(pair, 'left'), left)
  assert.equal(cellAt(pair, 'right'), right)
})

test('a half-empty pair falls back to whichever column exists', () => {
  const right = { kind: 'add', line: 4 }
  // A pure insertion has no left column, and asking for the left one should
  // still land on a commentable line rather than nothing.
  assert.equal(cellAt({ kind: 'pair', left: null, right }, 'left'), right)

  const left = { kind: 'del', line: 3 }
  assert.equal(cellAt({ kind: 'pair', left, right: null }, 'right'), left)
})

test('the cursor mark is drawn in the column it actually landed in', () => {
  const right = { kind: 'add', line: 4 }
  assert.equal(sideAt({ kind: 'pair', left: null, right }, 'left'), 'right')
  assert.equal(sideAt({ kind: 'pair', left: right, right: null }, 'right'), 'left')
  // Unified rows have no sides to choose between.
  assert.equal(sideAt({ kind: 'add', line: 1 }, 'left'), 'left')
})

test('a finding anchor is found in either column of a pair', () => {
  const pair = { kind: 'pair', left: { line: 3 }, right: { line: 9 } }
  assert.equal(rowHasLine(pair, 3), true)
  assert.equal(rowHasLine(pair, 9), true)
  assert.equal(rowHasLine(pair, 4), false)

  assert.equal(rowHasLine({ kind: 'add', line: 9 }, 9), true)
  assert.equal(rowHasLine({ kind: 'hunk', line: null }, null), false)
})

test('draft keys separate the two sides of a diff and give file-level drafts a home', () => {
  assert.notEqual(draftKey('a.rb', 'additions', 4), draftKey('a.rb', 'deletions', 4))
  assert.equal(draftKey('a.rb', 'additions', null), 'a.rb:additions:file')
})

test('a window that fits does not scroll', () => {
  assert.equal(windowFor(3, 5, 10), 0)
})

test('a window centres the cursor, then stops at the end of the content', () => {
  assert.equal(windowFor(50, 100, 10), 45)
  assert.equal(windowFor(0, 100, 10), 0)
  assert.equal(windowFor(99, 100, 10), 90)
})
