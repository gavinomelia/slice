import assert from 'node:assert/strict'
import { test } from 'node:test'

import { keysCard } from '../src/viewer/cards.mjs'
import { segmentsWidth } from '../src/viewer/markdown.mjs'

const ui = { theme: { ui: { heading: 'gray', accent: 'cyan' } } }
const text = (lines) => lines.map((line) => line.map((segment) => segment.text).join(''))

test('the keys card fits the pane it is drawn in, however narrow', () => {
  for (const width of [30, 50, 80]) {
    for (const line of keysCard(width, ui)) assert.ok(segmentsWidth(line) <= width, `width ${width}`)
  }
})

test('the keys card lists the key that closes it', () => {
  assert.ok(text(keysCard(80, ui)).some((line) => /^\?\s+show or hide this/.test(line)))
})
