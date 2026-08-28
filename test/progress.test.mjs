/**
 * Read state: what it covers, and when it stops being true.
 *
 * The staleness rule is the part worth guarding. A review path is stable for
 * the life of a PR while its diff is not, so a mark that outlived the code it
 * was made against would tell you a file is read when the author has since
 * rewritten it — the one failure mode that makes the feature worse than
 * nothing.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { buildTree } from '../src/viewer/tree.mjs'
import {
  loadReviewed,
  nextUnreviewed,
  pathsForRow,
  reviewedPathFor,
  saveReviewed,
  sliceReviewed,
  toggleReviewed,
} from '../src/viewer/progress.mjs'

const dir = mkdtempSync(join(tmpdir(), 'slice-progress-'))
const reviewPath = join(dir, 'pr-1.review.json')
after(() => rmSync(dir, { recursive: true, force: true }))

const review = (over = {}) => ({
  target: { kind: 'pr', number: 7 },
  slices: [
    { id: 's1', paths: ['a.rb', 'b.rb'] },
    { id: 's2', paths: ['c.rb'] },
  ],
  files: {
    'a.rb': { path: 'a.rb', status: 'modified', patch: 'diff a' },
    'b.rb': { path: 'b.rb', status: 'added', patch: 'diff b' },
    'c.rb': { path: 'c.rb', status: 'deleted', patch: 'diff c' },
  },
  findings: [],
  ...over,
})

test('read state lives beside the review it belongs to', () => {
  assert.equal(reviewedPathFor('/tmp/x/pr-9.review.json'), '/tmp/x/pr-9.reviewed.json')
})

test('marks survive a round trip', () => {
  saveReviewed(reviewPath, new Set(['a.rb', 'c.rb']), review())
  assert.deepEqual([...loadReviewed(reviewPath, review())].sort(), ['a.rb', 'c.rb'])
})

test('a mark is dropped once the file it was made against has changed', () => {
  saveReviewed(reviewPath, new Set(['a.rb', 'b.rb']), review())

  const pushed = review()
  pushed.files['a.rb'] = { path: 'a.rb', status: 'modified', patch: 'diff a, with the fix' }

  assert.deepEqual([...loadReviewed(reviewPath, pushed)], ['b.rb'])
})

test('a mark on a file no longer in the diff is dropped', () => {
  saveReviewed(reviewPath, new Set(['a.rb', 'c.rb']), review())

  const smaller = review()
  delete smaller.files['c.rb']

  assert.deepEqual([...loadReviewed(reviewPath, smaller)], ['a.rb'])
})

test('marking nothing removes the file rather than leaving an empty one', () => {
  saveReviewed(reviewPath, new Set(['a.rb']), review())
  saveReviewed(reviewPath, new Set(), review())
  assert.equal(existsSync(reviewedPathFor(reviewPath)), false)
  assert.equal(loadReviewed(reviewPath, review()).size, 0)
})

test('a corrupt file starts from nothing read instead of stopping the review', () => {
  writeFileSync(reviewedPathFor(reviewPath), '{ not json')
  assert.equal(loadReviewed(reviewPath, review()).size, 0)

  writeFileSync(reviewedPathFor(reviewPath), '["an", "array"]')
  assert.equal(loadReviewed(reviewPath, review()).size, 0)
})

test('no file at all is not an error', () => {
  assert.equal(loadReviewed(join(dir, 'never-written.review.json'), review()).size, 0)
})

test('a file row marks itself and a slice header marks everything under it', () => {
  const r = review()
  assert.deepEqual(pathsForRow({ type: 'file', path: 'b.rb' }, r), ['b.rb'])
  assert.deepEqual(pathsForRow({ type: 'slice', sliceIndex: 0 }, r), ['a.rb', 'b.rb'])
  // Overview and drafts have nothing to mark, and neither does no row at all.
  assert.deepEqual(pathsForRow({ type: 'overview' }, r), [])
  assert.deepEqual(pathsForRow(null, r), [])
})

test('a slice header does not offer to mark a path with no file behind it', () => {
  const r = review({ files: { 'a.rb': { patch: 'diff a' } } })
  assert.deepEqual(pathsForRow({ type: 'slice', sliceIndex: 0 }, r), ['a.rb'])
})

test('a slice is read only once every file under it is', () => {
  const r = review()
  assert.equal(sliceReviewed(r, 0, new Set(['a.rb'])), false)
  assert.equal(sliceReviewed(r, 0, new Set(['a.rb', 'b.rb'])), true)
})

test('a slice with no files left in the diff is not silently read', () => {
  // Otherwise "every file is marked" is vacuously true and the tree claims a
  // slice was reviewed that was never shown.
  const r = review({ files: {} })
  assert.equal(sliceReviewed(r, 0, new Set()), false)
})

test('a part-read slice marks the rest rather than clearing what is done', () => {
  assert.deepEqual([...toggleReviewed(new Set(['a.rb']), ['a.rb', 'b.rb'])].sort(), ['a.rb', 'b.rb'])
})

test('a fully read group is what unmarking takes', () => {
  assert.deepEqual([...toggleReviewed(new Set(['a.rb', 'b.rb']), ['a.rb', 'b.rb'])], [])
  assert.deepEqual([...toggleReviewed(new Set(['a.rb', 'b.rb']), ['a.rb'])], ['b.rb'])
})

test('toggling nothing changes nothing', () => {
  assert.deepEqual([...toggleReviewed(new Set(['a.rb']), [])], ['a.rb'])
})

test('marking advances to the next file that still needs reading', () => {
  const tree = buildTree(review())
  // overview, slice, a.rb, b.rb, slice, c.rb, drafts
  assert.equal(nextUnreviewed(tree, 2, new Set(['a.rb'])), 3)
  // b.rb is done too, so the next file is past the second slice header.
  assert.equal(nextUnreviewed(tree, 3, new Set(['a.rb', 'b.rb'])), 5)
})

test('the search wraps, so a file skipped early comes back at the end', () => {
  const tree = buildTree(review())
  assert.equal(nextUnreviewed(tree, 5, new Set(['b.rb', 'c.rb'])), 2)
})

test('nothing left to read says so rather than moving the cursor', () => {
  const tree = buildTree(review())
  assert.equal(nextUnreviewed(tree, 2, new Set(['a.rb', 'b.rb', 'c.rb'])), -1)
})
