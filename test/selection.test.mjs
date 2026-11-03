import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isEmptySelection, markRange, parseMouse, rangeOn, selectedText } from '../src/viewer/selection.mjs'

const selection = (anchor, head) => ({ anchor, head })

test('parseMouse reads what a left drag sends', () => {
  assert.deepEqual(parseMouse('[<0;10;20M'), { type: 'press', x: 10, y: 20 })
  assert.deepEqual(parseMouse('[<32;11;20M'), { type: 'drag', x: 11, y: 20 })
  assert.deepEqual(parseMouse('[<0;11;20m'), { type: 'release', x: 11, y: 20 })
})

test('parseMouse tells the wheel directions apart', () => {
  assert.equal(parseMouse('[<64;1;1M').delta, -1)
  assert.equal(parseMouse('[<65;1;1M').delta, 1)
})

test('parseMouse swallows the buttons it does not act on', () => {
  assert.equal(parseMouse('[<2;1;1M').type, 'other')
  assert.equal(parseMouse('[<66;1;1M').type, 'other')
})

test('parseMouse leaves keystrokes alone', () => {
  for (const input of ['j', '[', '[A', 'jjj', '']) assert.equal(parseMouse(input), null)
})

test('selectedText takes partial ends and whole middles, in either drag direction', () => {
  const lines = ['first line', 'middle', 'last line']
  const down = selection({ line: 0, col: 6 }, { line: 2, col: 3 })
  const up = selection(down.head, down.anchor)
  const expected = 'line\nmiddle\nlast'
  assert.equal(
    selectedText(down, (i) => lines[i]),
    expected,
  )
  assert.equal(
    selectedText(up, (i) => lines[i]),
    expected,
  )
})

test('the cell under the pointer is part of the selection, whichever way the drag went', () => {
  const right = selection({ line: 0, col: 1 }, { line: 0, col: 2 })
  const left = selection(right.head, right.anchor)
  assert.equal(
    selectedText(right, () => 'abcd'),
    'bc',
  )
  assert.equal(
    selectedText(left, () => 'abcd'),
    'bc',
  )
})

test('selectedText skips lines the pane has no text for', () => {
  const lines = ['a', null, 'b']
  const chosen = selection({ line: 0, col: 0 }, { line: 2, col: Infinity })
  assert.equal(
    selectedText(chosen, (i) => lines[i]),
    'a\nb',
  )
})

test('a selection to the right edge keeps text clipped off screen', () => {
  const chosen = selection({ line: 0, col: 2 }, { line: 0, col: Infinity })
  assert.equal(
    selectedText(chosen, () => 'a long line'),
    'long line',
  )
})

test('rangeOn is null outside the selection', () => {
  const chosen = selection({ line: 1, col: 2 }, { line: 3, col: 4 })
  assert.equal(rangeOn(chosen, 0), null)
  assert.deepEqual(rangeOn(chosen, 1), [2, Infinity])
  assert.deepEqual(rangeOn(chosen, 2), [0, Infinity])
  assert.deepEqual(rangeOn(chosen, 3), [0, 5])
  assert.equal(rangeOn(chosen, 4), null)
})

test('isEmptySelection is a click with no drag', () => {
  assert.equal(isEmptySelection(selection({ line: 1, col: 1 }, { line: 1, col: 1 })), true)
  assert.equal(isEmptySelection(selection({ line: 1, col: 1 }, { line: 1, col: 2 })), false)
})

test('markRange splits segments at the range and keeps their style', () => {
  const marked = markRange(
    [
      { text: 'abc', color: 'red' },
      { text: 'def', color: 'blue' },
    ],
    1,
    4,
  )
  assert.deepEqual(marked, [
    { text: 'a', color: 'red' },
    { text: 'bc', color: 'red', selected: true },
    { text: 'd', color: 'blue', selected: true },
    { text: 'ef', color: 'blue' },
  ])
})

test('markRange ignores a range that has scrolled off to the left', () => {
  const line = [{ text: 'abc' }]
  assert.deepEqual(markRange(line, -5, -1), line)
  assert.deepEqual(markRange(line, -5, 1), [{ text: 'a', selected: true }, { text: 'bc' }])
})
