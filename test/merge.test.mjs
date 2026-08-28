import assert from 'node:assert/strict'
import { test } from 'node:test'

import { annotatableLines, bareReview, mergeReview } from '../src/pipeline/merge.mjs'
import { splitPatch } from '../src/pipeline/patch.mjs'

const PATCH = [
  'diff --git a/app/post.rb b/app/post.rb',
  '--- a/app/post.rb',
  '+++ b/app/post.rb',
  '@@ -10,3 +10,4 @@',
  ' context',
  '-removed',
  '+added one',
  '+added two',
  '',
].join('\n')

const files = splitPatch(PATCH)
const target = { kind: 'pr', repo: 'o/r', number: 1, title: 't', author: 'a', baseRef: 'main', headRef: 'x' }
const build = (analysis) => mergeReview({ target, files, analysis })

test('annotatableLines tracks both sides, counting context on each', () => {
  const { additions, deletions } = annotatableLines(PATCH)
  // Context at 10, then two additions at 11 and 12.
  assert.deepEqual(
    [...additions].sort((a, b) => a - b),
    [10, 11, 12],
  )
  // Context at 10, then the removed line at 11.
  assert.deepEqual(
    [...deletions].sort((a, b) => a - b),
    [10, 11],
  )
})

test('a finding on a line outside the diff is demoted, not dropped', () => {
  const { review, warnings } = build({
    slices: [{ id: 's', title: 'S', kind: 'behavior', summary: '', paths: ['app/post.rb'] }],
    findings: [{ severity: 'bug', path: 'app/post.rb', line: 9999, title: 'Real bug', why: 'w' }],
  })

  assert.equal(review.findings.length, 1, 'a real bug with a bad anchor still reaches the reviewer')
  assert.equal(review.findings[0].line, null)
  assert.equal(review.findings[0].title, 'Real bug')
  assert.match(warnings.join(' '), /not in the diff/)
})

test('a finding on a path outside the diff is dropped', () => {
  const { review, warnings } = build({
    slices: [{ id: 's', title: 'S', kind: 'behavior', summary: '', paths: ['app/post.rb'] }],
    findings: [{ severity: 'bug', path: 'nope.rb', line: 10, title: 'Ghost', why: 'w' }],
  })
  assert.equal(review.findings.length, 0)
  assert.match(warnings.join(' '), /unknown path/)
})

test('a valid line anchor survives on the side it was reported against', () => {
  const { review } = build({
    slices: [{ id: 's', title: 'S', kind: 'behavior', summary: '', paths: ['app/post.rb'] }],
    findings: [{ severity: 'risk', path: 'app/post.rb', line: 11, side: 'deletions', title: 'T', why: 'w' }],
  })
  assert.equal(review.findings[0].line, 11)
  assert.equal(review.findings[0].side, 'deletions')
})

test('files the analysis forgot get their own bucket rather than vanishing', () => {
  const { review, warnings } = build({ slices: [], findings: [] })
  const unsliced = review.slices.find((s) => s.id === 'unsliced')
  assert.ok(unsliced, 'an unsliced file is often the one nothing else explains')
  assert.deepEqual(unsliced.paths, ['app/post.rb'])
  assert.match(warnings.join(' '), /not placed in any slice/)
})

test('a path claimed by two slices is kept by the first', () => {
  const { review, warnings } = build({
    slices: [
      { id: 'a', title: 'A', kind: 'behavior', summary: '', paths: ['app/post.rb'] },
      { id: 'b', title: 'B', kind: 'behavior', summary: '', paths: ['app/post.rb'] },
    ],
    findings: [],
  })
  assert.equal(review.slices.length, 1)
  assert.equal(review.slices[0].id, 'a')
  assert.match(warnings.join(' '), /more than one slice/)
})

test('duplicate slice ids are made unique', () => {
  const other = splitPatch(PATCH.replace(/app\/post\.rb/g, 'app/other.rb'))
  const { review } = mergeReview({
    target,
    files: [...files, ...other],
    analysis: {
      slices: [
        { id: 'same', title: 'A', kind: 'behavior', summary: '', paths: ['app/post.rb'] },
        { id: 'same', title: 'B', kind: 'behavior', summary: '', paths: ['app/other.rb'] },
      ],
      findings: [],
    },
  })
  assert.equal(new Set(review.slices.map((s) => s.id)).size, review.slices.length)
})

test('unknown severities and slice kinds fall back safely', () => {
  const { review } = build({
    slices: [{ id: 's', title: 'S', kind: 'not-a-kind', summary: '', paths: ['app/post.rb'] }],
    findings: [{ severity: 'catastrophe', path: 'app/post.rb', line: 10, title: 'T', why: 'w' }],
  })
  // Both fall back in the under-claiming direction.
  assert.equal(review.slices[0].kind, 'behavior')
  assert.equal(review.findings[0].severity, 'question')
})

test('the taxonomy in play is written into the manifest', () => {
  const config = {
    review: {
      severities: { blocker: { description: 'd', glyph: '!', color: 'red' } },
      sliceKinds: { chunk: { description: 'd', color: null } },
    },
  }
  const { review } = mergeReview({
    target,
    files,
    config,
    analysis: {
      slices: [{ id: 's', title: 'S', kind: 'chunk', summary: '', paths: ['app/post.rb'] }],
      findings: [{ severity: 'blocker', path: 'app/post.rb', line: 10, title: 'T', why: 'w' }],
    },
  })

  assert.deepEqual(Object.keys(review.taxonomy.severities), ['blocker'])
  assert.equal(review.findings[0].severity, 'blocker')
  assert.equal(review.slices[0].kind, 'chunk')
})

test('a custom taxonomy falls back within itself, never to the built-ins', () => {
  const config = {
    review: {
      severities: { blocker: { description: 'd' }, note: { description: 'd' } },
      sliceKinds: { chunk: { description: 'd' } },
    },
  }
  const { review } = mergeReview({
    target,
    files,
    config,
    analysis: {
      slices: [{ id: 's', title: 'S', kind: 'behavior', summary: '', paths: ['app/post.rb'] }],
      findings: [{ severity: 'bug', path: 'app/post.rb', line: 10, title: 'T', why: 'w' }],
    },
  })
  assert.equal(review.findings[0].severity, 'note', 'the last severity is the least serious')
  assert.equal(review.slices[0].kind, 'chunk', 'the first slice kind is ordinary behavior')
})

test('bareReview still lists every file when no analysis ran', () => {
  const review = bareReview({ target, files })
  assert.deepEqual(review.slices[0].paths, ['app/post.rb'])
  assert.equal(review.findings.length, 0)
  assert.ok(review.taxonomy.severities.bug)
})
