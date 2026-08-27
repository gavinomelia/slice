import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildPayload, partitionDrafts } from '../src/viewer/github.mjs'

const draft = (over = {}) => ({ path: 'a.rb', line: 4, side: 'additions', body: 'hi', ...over })

test('line-anchored drafts become comments, unanchored ones become orphans', () => {
  const { comments, orphans } = partitionDrafts([draft(), draft({ line: null })])
  assert.equal(comments.length, 1)
  assert.equal(orphans.length, 1)
  assert.equal(comments[0].side, 'RIGHT')
})

test('a deletion-side draft maps to LEFT', () => {
  const { comments } = partitionDrafts([draft({ side: 'deletions' })])
  assert.equal(comments[0].side, 'LEFT')
})

test('empty drafts are dropped entirely', () => {
  const { comments, orphans } = partitionDrafts([draft({ body: '   ' }), draft({ body: '' })])
  assert.equal(comments.length + orphans.length, 0)
})

test('orphans go in the body rather than risking a 422 on the whole batch', () => {
  const { payload, orphanCount } = buildPayload({
    event: 'COMMENT',
    body: 'Overall notes.',
    drafts: [draft(), draft({ line: null, body: 'file-level thought' })],
    viewerIsAuthor: false,
  })
  assert.equal(payload.comments.length, 1)
  assert.equal(orphanCount, 1)
  assert.match(payload.body, /Overall notes/)
  assert.match(payload.body, /file-level thought/)
  assert.match(payload.body, /a\.rb/)
})

test('approve and request-changes downgrade on your own PR', () => {
  for (const event of ['APPROVE', 'REQUEST_CHANGES']) {
    const { payload, downgraded } = buildPayload({ event, body: 'x', drafts: [], viewerIsAuthor: true })
    assert.equal(payload.event, 'COMMENT', `${event} is rejected by GitHub on your own PR`)
    assert.equal(downgraded, true)
  }
})

test('nothing is downgraded on somebody else’s PR', () => {
  const { payload, downgraded } = buildPayload({ event: 'APPROVE', body: 'x', drafts: [], viewerIsAuthor: false })
  assert.equal(payload.event, 'APPROVE')
  assert.equal(downgraded, false)
})

test('a plain comment is never "downgraded" to itself', () => {
  const { downgraded } = buildPayload({ event: 'COMMENT', body: 'x', drafts: [], viewerIsAuthor: true })
  assert.equal(downgraded, false)
})
