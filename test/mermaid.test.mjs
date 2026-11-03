import assert from 'node:assert/strict'
import { test } from 'node:test'

import { documentLines, mermaidSources } from '../src/viewer/markdown.mjs'
import { renderDiagrams } from '../src/viewer/mermaid.mjs'
import { renderedLines } from '../src/viewer/rendered.mjs'
import { buildRows } from '../src/viewer/render.mjs'

const text = (line) => line.map((segment) => segment.text).join('')
const theme = { diff: { addMark: 'green', delMark: 'red' } }
const SEQUENCE = 'sequenceDiagram\n  A->>B: hello\n'
const chain = (nodes) =>
  'flowchart LR\n' +
  Array.from({ length: nodes }, (_, i) => `  N${i}[Node ${i}] --> N${i + 1}[Node ${i + 1}]`).join('\n')

test('only mermaid fences are collected, wherever they sit', () => {
  const source = '```mermaid\ngraph LR\n```\n\n```js\nx\n```\n\n- item\n\n  ```mermaid title="x"\n  pie\n  ```\n'
  assert.deepEqual(mermaidSources(source), ['graph LR\n', 'pie\n'])
})

test('a diagram is drawn off the main thread', async () => {
  const diagrams = await renderDiagrams([SEQUENCE])
  const lines = diagrams.get(SEQUENCE)
  assert.ok(lines.some((line) => line.includes('hello')))
  assert.ok(lines.every((line) => line === line.trimEnd()))
})

test('an unsupported diagram resolves to null rather than throwing', async () => {
  const source = 'pie title Pets\n  "Dogs" : 386\n'
  assert.equal((await renderDiagrams([source])).get(source), null)
})

test('a diagram that hangs is abandoned and later ones still draw', async () => {
  const hanging = chain(35)
  const started = Date.now()
  const diagrams = await renderDiagrams([hanging, SEQUENCE + ' '], { perDiagramMs: 700, totalMs: 5000 })
  assert.ok(Date.now() - started < 4000, 'the hang is cut short')
  assert.equal(diagrams.get(hanging), null)
  assert.ok(diagrams.get(SEQUENCE + ' '))
})

test('the total budget stops a document full of slow diagrams', async () => {
  const sources = [chain(36), chain(37), chain(38), chain(39), chain(41)]
  const started = Date.now()
  const diagrams = await renderDiagrams(sources, { perDiagramMs: 400, totalMs: 900 })
  assert.ok(Date.now() - started < 3000)
  for (const source of sources) assert.equal(diagrams.get(source), null)
})

test('an oversized diagram is not even attempted', async () => {
  const source = 'graph LR\n' + 'A-->B\n'.repeat(5000)
  assert.equal((await renderDiagrams([source])).get(source), null)
})

test('a drawn diagram replaces its source and has no code gutter', () => {
  const source = '# t\n\n```mermaid\nx\n```\n'
  const lines = documentLines(source, 40, new Map([['x\n', ['┌─┐', '└─┘']]]))
  assert.deepEqual(lines.map(text), ['t', '', '┌─┐', '└─┘'])
})

test('a diagram that failed shows a note above its source', () => {
  const lines = documentLines('```mermaid\nx\n```\n', 60, new Map([['x\n', null]]))
  assert.deepEqual(lines.map(text), ['This diagram could not be drawn, so here is its source.', '│ x'])
})

test('any change inside a diagram marks all of it', () => {
  const lines = renderedLines(
    '```mermaid\nx\ny\n```\n',
    [{ kind: 'add', line: 3 }],
    40,
    theme,
    new Map([['x\ny\n', ['aa', 'bb']]]),
  )
  assert.deepEqual(lines.map(text), ['▌ aa', '▌ bb'])
})

test('documents show where a link goes, unless the text already does', () => {
  const lines = documentLines('[docs](https://x.io) <https://y.io> [top](#a) [![b](i.png)](https://z.io)', 80)
  assert.equal(text(lines[0]), 'docs (https://x.io) https://y.io top b')
})

test('generated text keeps links to their label', () => {
  assert.equal(text(documentLines('[a](#b)', 40)[0]), 'a')
})

test('escape sequences in a patch never reach a diff row', async () => {
  const patch =
    'diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new \x1b]0;pwned\x07 line\n'
  const rows = await buildRows({ path: 'a.txt', patch })
  for (const row of rows) assert.doesNotMatch(row.segments.map((s) => s.text).join(''), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  assert.ok(
    rows.some(
      (row) =>
        row.kind === 'add' &&
        row.segments
          .map((s) => s.text)
          .join('')
          .includes('new'),
    ),
  )
})
