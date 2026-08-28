import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  markdownLines,
  padSegments,
  parseInline,
  segmentsWidth,
  sliceSegments,
  wrapSegments,
} from '../src/viewer/markdown.mjs'

const text = (segments) => segments.map((s) => s.text).join('')

test('sliceSegments takes a column window and keeps styling', () => {
  const segments = [
    { text: 'const ', color: 'red' },
    { text: 'value', color: 'blue' },
    { text: ' = 1', color: 'green' },
  ]
  const full = text(segments)

  for (const [from, width] of [
    [0, 5],
    [3, 6],
    [6, 5],
    [8, 100],
    [100, 10],
  ]) {
    assert.equal(text(sliceSegments(segments, from, width)), full.slice(from, from + width), `${from}+${width}`)
  }
  // Styling survives the cut.
  assert.equal(sliceSegments(segments, 6, 5)[0].color, 'blue')
})

test('padSegments fills to width so a diff tint reads as a band', () => {
  const padded = padSegments([{ text: 'abc' }], 10, { bg: '#123456' })
  assert.equal(segmentsWidth(padded), 10)
  assert.equal(padded.at(-1).bg, '#123456')
  // Already wide enough: left alone rather than truncated.
  assert.equal(segmentsWidth(padSegments([{ text: 'x'.repeat(20) }], 10, {})), 20)
})

test('inline code keeps its own styling and drops surrounding dim', () => {
  const segments = parseInline('call `Post#save` now', { dim: true })
  const code = segments.find((s) => s.text === 'Post#save')
  assert.ok(code, 'the code span is extracted without its backticks')
  assert.equal(code.dim, false, 'a greyed-out identifier is the thing you most need to read')
  assert.ok(code.bg)
})

test('bold, italic and links are unwrapped to their visible text', () => {
  assert.equal(text(parseInline('**b** and *i* and [label](http://x)')), 'b and i and label')
  const link = parseInline('[label](http://x)')[0]
  assert.equal(link.underline, true)
})

test('wrapping never exceeds the width and carries style per word', () => {
  const lines = wrapSegments(parseInline('the quick brown fox jumps over the lazy dog'), 12)
  for (const line of lines) assert.ok(segmentsWidth(line) <= 12, text(line))
  assert.equal(lines.map(text).join(' ').replace(/\s+/g, ' ').trim(), 'the quick brown fox jumps over the lazy dog')
})

test('a word longer than the pane is broken rather than dropped', () => {
  const lines = wrapSegments([{ text: 'x'.repeat(50) }], 10)
  assert.equal(lines.map(text).join(''), 'x'.repeat(50))
  for (const line of lines) assert.ok(segmentsWidth(line) <= 10)
})

test('fenced code keeps its own line breaks and indentation', () => {
  const lines = markdownLines('before\n\n```ruby\ndef a\n  b\nend\n```\n\nafter', 40)
  const rendered = lines.map(text)
  assert.ok(rendered.some((l) => l.includes('def a')))
  assert.ok(
    rendered.some((l) => l.includes('  b')),
    'indentation inside a fence is preserved',
  )
})

test('an unterminated fence still renders', () => {
  // Common in truncated model output; dropping it would lose the fix entirely.
  const rendered = markdownLines('```ruby\ndef a', 40).map(text)
  assert.ok(rendered.some((l) => l.includes('def a')))
})

test('consecutive plain lines rewrap as one paragraph', () => {
  const hard = markdownLines('a model\nhard-wrapped\nthis text', 40).map(text)
  assert.equal(hard.length, 1, 'model line breaks are not honoured inside a paragraph')
})

test('bullets hang their continuation under the text, not the marker', () => {
  const lines = markdownLines('- ' + 'word '.repeat(12), 20).map(text)
  assert.ok(lines[0].startsWith('•'))
  for (const line of lines.slice(1)) assert.ok(line.startsWith('  '), line)
})
