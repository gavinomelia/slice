import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { markdownLines, sourceOf, stripFrontmatter } from '../src/viewer/markdown.mjs'
import {
  addedFileText,
  canRender,
  documentText,
  lineAtRow,
  loadFileText,
  renderedLines,
  rowForLine,
} from '../src/viewer/rendered.mjs'

const theme = { diff: { addMark: 'green', delMark: 'red' } }
const text = (line) => line.map((segment) => segment.text).join('')
const mark = (line) => line[0]?.color
const dir = mkdtempSync(join(tmpdir(), 'slice-rendered-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('only markdown files that still exist can render', () => {
  assert.equal(canRender({ path: 'docs/a.md', status: 'modified' }), true)
  assert.equal(canRender({ path: 'A.MARKDOWN', status: 'added' }), true)
  assert.equal(canRender({ path: 'a.md', status: 'deleted' }), false)
  assert.equal(canRender({ path: 'a.ts', status: 'modified' }), false)
  assert.equal(canRender(null), false)
})

test('an added file is rebuilt from its patch', () => {
  const patch =
    'diff --git a/a.md b/a.md\nnew file mode 100644\n--- /dev/null\n+++ b/a.md\n@@ -0,0 +1,2 @@\n+# Hi\n+there\n\\ No newline at end of file\n'
  assert.equal(addedFileText(patch), '# Hi\nthere')
})

test('a patch with context lines cannot rebuild the whole file', () => {
  assert.equal(addedFileText('@@ -1,2 +1,2 @@\n keep\n+new\n'), null)
})

test('rendered rows keep the source lines they came from', () => {
  const lines = markdownLines('# Title\n\n- one\n- two\n\n> quote\n\n| a |\n|---|\n| 1 |\n| 2 |\n', 40)
  const sourceFor = (wanted) => sourceOf(lines.find((line) => text(line).includes(wanted)))
  assert.deepEqual(sourceFor('Title'), [0, 1])
  assert.deepEqual(sourceFor('two'), [3, 4])
  assert.deepEqual(sourceFor('quote'), [5, 6])
  assert.deepEqual(sourceFor('2'), [10, 11])
})

test('blocks with added lines get an addition mark, others none', () => {
  const rows = [
    { kind: 'ctx', line: 1 },
    { kind: 'ctx', line: 2 },
    { kind: 'add', line: 3 },
  ]
  const lines = renderedLines('one\n\ntwo', rows, 40, theme)
  assert.deepEqual(lines.map(text), ['  one', '', '▌ two'])
  assert.equal(mark(lines[2]), 'green')
  assert.equal(mark(lines[0]), undefined)
})

test('a pure removal marks the block that follows it', () => {
  const rows = [
    { kind: 'ctx', line: 1 },
    { kind: 'del', line: 2 },
    { kind: 'ctx', line: 2 },
    { kind: 'ctx', line: 3 },
  ]
  const lines = renderedLines('one\n\ntwo', rows, 40, theme)
  assert.equal(mark(lines[0]), undefined)
  assert.equal(mark(lines[2]), 'red')
})

test('a removal at the end of a file marks the last block', () => {
  const rows = [
    { kind: 'ctx', line: 1 },
    { kind: 'del', line: 2 },
  ]
  assert.equal(mark(renderedLines('only', rows, 40, theme)[0]), 'red')
})

test('front matter is hidden and line numbers still line up', () => {
  const source = '---\ntitle: x\n---\n# Head\n'
  assert.equal(stripFrontmatter(source), '\n\n\n# Head\n')
  const lines = renderedLines(source, [{ kind: 'add', line: 4 }], 40, theme)
  assert.deepEqual(lines.map(text), ['▌ Head'])
})

test('a leading horizontal rule is not mistaken for front matter', () => {
  const source = '---\n\nplain\n\n---\n'
  assert.equal(stripFrontmatter(source), source)
})

test('a source line maps to its rendered row and back', () => {
  const lines = renderedLines('# a\n\nb\n\nc\n', [], 40, theme)
  assert.equal(rowForLine(lines, 5), 4)
  assert.equal(rowForLine(lines, 4), 2)
  assert.equal(rowForLine(lines, 1), 0)
  assert.equal(lineAtRow(lines, 1), 3)
  assert.equal(lineAtRow(lines, 2), 3)
})

const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })

test('file text comes from the commit under review, not the working tree', async () => {
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.md'), 'committed')
  git('add', '.')
  git('commit', '-qm', 'one')
  const headSha = git('rev-parse', 'HEAD').stdout.trim()
  writeFileSync(join(dir, 'a.md'), 'edited since')

  const file = { path: 'a.md', status: 'modified', patch: '' }
  assert.equal(await loadFileText({ file, target: { kind: 'pr', headSha }, repoRoot: dir }), 'committed')
  assert.equal(await loadFileText({ file, target: { kind: 'worktree', headSha: null }, repoRoot: dir }), 'edited since')
})

test('a file that cannot be found resolves to null rather than throwing', async () => {
  const file = { path: 'missing.md', status: 'modified', patch: '' }
  assert.equal(await loadFileText({ file, target: { kind: 'worktree' }, repoRoot: dir }), null)
})

test('a working tree path cannot climb out of the repository', async () => {
  const file = { path: '../outside.md', status: 'modified', patch: '' }
  assert.equal(await loadFileText({ file, target: { kind: 'worktree' }, repoRoot: dir }), null)
})

test('only the changed line of a code fence is marked', () => {
  const lines = renderedLines('```js\na\nb\nc\n```', [{ kind: 'add', line: 3 }], 40, theme)
  assert.deepEqual(lines.map(text), ['  │ a', '▌ │ b', '  │ c'])
})

test('a removal just before a closing fence marks the last code line', () => {
  const rows = [
    { kind: 'ctx', line: 2 },
    { kind: 'del', line: 3 },
    { kind: 'ctx', line: 3 },
  ]
  const lines = renderedLines('```js\na\n```', rows, 40, theme)
  assert.equal(mark(lines[0]), 'red')
})

test('a wholly removed paragraph marks the block after it', () => {
  const rows = [
    { kind: 'ctx', line: 1 },
    { kind: 'ctx', line: 2 },
    { kind: 'del', line: 3 },
    { kind: 'del', line: 4 },
    { kind: 'ctx', line: 3 },
  ]
  const lines = renderedLines('one\n\ntwo', rows, 40, theme)
  assert.equal(mark(lines[0]), undefined)
  assert.equal(mark(lines[2]), 'red')
})

test('a stalled gh call is abandoned and retried, without touching stdin', async () => {
  const bin = join(dir, 'fake-bin')
  const state = join(dir, 'gh-calls')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nif [ ! -e "${state}" ]; then touch "${state}"; exec sleep 30; fi\ncat >/dev/null\necho fetched\n`,
    { mode: 0o755 },
  )
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const file = { path: 'b.md', status: 'modified', patch: '' }
    const target = { kind: 'pr', repo: 'o/r', headSha: 'deadbeef' }
    const started = Date.now()
    const text = await loadFileText({ file, target, repoRoot: dir, ghTimeouts: [300, 3000] })
    assert.equal(text.trim(), 'fetched')
    assert.ok(Date.now() - started < 3000)
  } finally {
    process.env.PATH = path
  }
})

test('a mermaid file becomes a document holding one diagram', () => {
  assert.equal(documentText('a.mmd', 'graph LR; A-->B'), '```mermaid\ngraph LR; A-->B\n```\n')
  assert.equal(documentText('a.md', '# x'), '# x')
  assert.equal(canRender({ path: 'flow.mermaid', status: 'modified' }), true)
})
