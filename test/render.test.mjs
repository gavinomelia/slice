import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildRows, splitRows } from '../src/viewer/render.mjs'

const diff = (...lines) => lines.join('\n') + '\n'

const rows = (...kinds) => kinds.map((kind, i) => ({ kind, line: i + 1, segments: [], text: kind }))

test('pairs a run of deletions against the additions that follow it', () => {
  const [ctx, ...changed] = rows('ctx', 'del', 'del', 'add', 'add')
  const paired = splitRows([ctx, ...changed])

  assert.equal(paired.length, 3, 'one context pair and two changed pairs')
  assert.deepEqual(
    paired.map((p) => [p.left?.text ?? null, p.right?.text ?? null]),
    [
      ['ctx', 'ctx'],
      ['del', 'add'],
      ['del', 'add'],
    ],
  )
})

test('leaves the longer side of an uneven change in a half-empty pair', () => {
  const paired = splitRows(rows('del', 'del', 'del', 'add'))

  assert.deepEqual(
    paired.map((p) => [p.left?.kind ?? null, p.right?.kind ?? null]),
    [
      ['del', 'add'],
      ['del', null],
      ['del', null],
    ],
    'nothing is dropped and nothing is invented',
  )
})

test('a pure insertion has no left column at all', () => {
  const paired = splitRows(rows('add', 'add'))
  assert.deepEqual(
    paired.map((p) => p.left),
    [null, null],
  )
})

test('hunk headers stay whole rather than being split in half', () => {
  const [header] = splitRows([{ kind: 'hunk', line: null, segments: [], text: '@@ -1 +1 @@' }])
  assert.equal(header.kind, 'hunk', 'a seam in the file is not a line of it')
})

test('a pair holds the same row objects the unified list holds', () => {
  // What lets the cursor survive a v toggle: the line under it is found by
  // identity rather than by recomputing an index that no longer means the same.
  const unified = rows('del', 'add')
  const [pair] = splitRows(unified)
  assert.equal(pair.left, unified[0])
  assert.equal(pair.right, unified[1])
})

test('carries both numberings for a context line', async () => {
  // The hunk starts at line 1 of the old file and line 5 of the new one, so a
  // context line has a different number in each — which is the whole reason
  // split view can show two gutters.
  const built = await buildRows({
    path: 'a.txt',
    patch: diff('diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +5,2 @@', ' kept', '-gone', '+here'),
  })

  const context = built.find((row) => row.kind === 'ctx')
  assert.equal(context.line, 5, 'the addition side, which is what the unified gutter shows')
  assert.equal(context.lineBefore, 1, 'the deletion side, for split view’s left column')
})
