import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  markdownLines,
  padSegments,
  parseInline,
  segmentsWidth,
  setCodeHighlighter,
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

test('nested emphasis keeps both styles', () => {
  const [segment] = parseInline('***both***')
  assert.equal(segment.text, 'both')
  assert.equal(segment.bold, true)
  assert.equal(segment.italic, true)
})

test('asterisks that are not emphasis stay literal', () => {
  assert.equal(text(parseInline('2 * 3 * 4')), '2 * 3 * 4')
  assert.equal(text(parseInline('\\*literal\\*')), '*literal*')
  assert.equal(text(parseInline('snake_case_name')), 'snake_case_name')
})

test('strikethrough is carried as a style', () => {
  const [segment] = parseInline('~~gone~~')
  assert.equal(segment.text, 'gone')
  assert.equal(segment.strikethrough, true)
})

test('images show their alt text', () => {
  assert.equal(text(parseInline('![a diagram](x.png)')), 'a diagram')
})

test('raw html is shown as text rather than interpreted', () => {
  assert.equal(text(parseInline('use <b>bold</b> here')), 'use <b>bold</b> here')
})

test('a hard break starts a new line', () => {
  assert.deepEqual(markdownLines('one\\\ntwo', 40).map(text), ['one', 'two'])
})

test('blank lines between blocks survive, and only one is kept', () => {
  assert.deepEqual(markdownLines('a\n\n\n\nb', 40).map(text), ['a', '', 'b'])
  assert.deepEqual(markdownLines('# head\nbody', 40).map(text), ['head', 'body'])
  assert.deepEqual(markdownLines('a\n', 40).map(text), ['a'])
})

test('reference definitions render nothing and resolve their links', () => {
  const lines = markdownLines('[label][ref]\n\n[ref]: http://x', 40)
  assert.deepEqual(lines.map(text), ['label'])
  assert.equal(lines[0][0].underline, true)
})

test('tight lists stay tight and loose lists keep their gaps', () => {
  assert.deepEqual(markdownLines('- a\n- b', 40).map(text), ['• a', '• b'])
  assert.deepEqual(markdownLines('- a\n\n- b', 40).map(text), ['• a', '', '• b'])
})

test('an empty list item does not open a gap', () => {
  assert.deepEqual(markdownLines('- \n- b', 40).map(text), ['• ', '• b'])
})

test('ordered lists keep their source numbers', () => {
  assert.deepEqual(markdownLines('3) one\n4) two', 40).map(text), ['3. one', '4. two'])
})

test('nested lists and fences sit under their item', () => {
  assert.deepEqual(markdownLines('- a\n  - b', 40).map(text), ['• a', '  • b'])
  assert.deepEqual(markdownLines('1. a\n   ```js\n   x\n   ```', 40).map(text), ['1. a', '   │ x'])
})

test('a blockquote marks every line, including its gaps', () => {
  const rendered = markdownLines('> one\n>\n> two', 40).map(text)
  assert.deepEqual(rendered, ['▏ one', '▏ ', '▏ two'])
})

test('an indented block renders as code', () => {
  assert.deepEqual(markdownLines('para\n\n    code', 40).map(text), ['para', '', '│ code'])
})

test('a fence passes its language to the highlighter, including punctuation', () => {
  const seen = []
  setCodeHighlighter((code, lang) => {
    seen.push(lang)
    return null
  })
  try {
    markdownLines('```c++\nint a;\n```\n\n```ts title="x"\nlet a\n```\n\n```mermaid\nflowchart LR\n```', 40)
  } finally {
    setCodeHighlighter(null)
  }
  assert.deepEqual(seen, ['c++', 'ts', 'mermaid'])
})

test('a table lines up its columns under a rule', () => {
  const rendered = markdownLines('| name | n |\n|---|--:|\n| a | 10 |\n| bb | 2 |', 40).map(text)
  assert.deepEqual(rendered, ['name │  n', '─────┼───', 'a    │ 10', 'bb   │  2'])
})

test('a table header is bold', () => {
  const [header] = markdownLines('| name |\n|---|\n| a |', 40)
  assert.ok(header.some((segment) => segment.text === 'name' && segment.bold))
})

test('a table wider than the pane wraps its cells instead of losing them', () => {
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel'
  const lines = markdownLines(`| a | b |\n|---|---|\n| ${words} | ${words} |`, 30)
  for (const line of lines) assert.ok(segmentsWidth(line) <= 30, text(line))
  const left = lines.slice(2).map((line) => text(line).split(' │ ')[0].trim())
  assert.equal(left.join(' ').replace(/\s+/g, ' ').trim(), words)
})

test('a narrow table spends its spare width before breaking a word', () => {
  const notes = 'backoff never resets so a long outage waits far longer'
  const lines = markdownLines(`| Path | Risk | Notes |\n|---|---|---|\n| w/math.ts | high | ${notes} |`, 27)
  assert.ok(text(lines[2]).startsWith('w/math.ts │'), text(lines[2]))
  for (const line of lines) assert.ok(segmentsWidth(line) <= 27, text(line))
})

test('deeply nested input does not throw', () => {
  assert.doesNotThrow(() => markdownLines('> '.repeat(20000) + 'a', 40))
  assert.doesNotThrow(() => markdownLines('- '.repeat(5000) + 'a', 40))
})

test('a long multi-line reference definition stays fast', () => {
  const started = performance.now()
  markdownLines('[a]: b "' + 'x\n'.repeat(80000) + '"\n', 40)
  assert.ok(performance.now() - started < 500)
})

test('missing text renders as nothing', () => {
  assert.deepEqual(markdownLines(undefined, 40), [])
  assert.deepEqual(parseInline(null), [])
})
