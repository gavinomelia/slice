import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { markdownLines, setMarkdownTheme } from '../src/viewer/markdown.mjs'
import { plainDocument } from '../src/viewer/document.mjs'

const BIN = fileURLToPath(new URL('../bin/slice.mjs', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'slice-document-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const slice = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_CACHE_HOME: join(dir, 'cache'),
      SLICE_CONFIG: '',
    },
  })

test('a markdown file renders outside any git repository', () => {
  writeFileSync(join(dir, 'notes.md'), '# Title\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
  const result = slice('notes.md')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'Title\n\nSome bold text.\n\na │ b\n──┼──\n1 │ 2\n')
})

test('the longer extension and any case count as markdown', () => {
  writeFileSync(join(dir, 'LONG.MARKDOWN'), 'hello')
  assert.equal(slice('LONG.MARKDOWN').stdout, 'hello\n')
})

test('a missing markdown file says so', () => {
  const result = slice('nope.md')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no such file: nope\.md/)
})

test('a directory with a markdown name fails cleanly', () => {
  mkdirSync(join(dir, 'folder.md'))
  const result = slice('folder.md')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot read folder\.md/)
})

test('review flags are refused rather than ignored', () => {
  writeFileSync(join(dir, 'flags.md'), 'x')
  for (const flag of ['--ai', '--wip', '--branch', '--refresh']) {
    const result = slice('flags.md', flag)
    assert.equal(result.status, 1, flag)
    assert.match(result.stderr, new RegExp(`${flag} reviews a diff`))
  }
})

test('a plain document has no trailing padding', () => {
  assert.equal(plainDocument('| a |\n|---|\n| 1 |', 40), 'a\n─\n1')
})

test('the top two heading levels stand out from the rest', () => {
  setMarkdownTheme({ heading: 'magenta' })
  try {
    const [[h1], [h2], [h3]] = markdownLines('# one\n## two\n### three', 40)
    assert.deepEqual([h1.bold, h1.underline, h1.color], [true, true, 'magenta'])
    assert.deepEqual([h2.bold, h2.underline, h2.color], [true, undefined, 'magenta'])
    assert.deepEqual([h3.bold, h3.color], [true, undefined])
  } finally {
    setMarkdownTheme({ heading: undefined })
  }
})

test('a mermaid file on its own is drawn', () => {
  writeFileSync(join(dir, 'flow.mmd'), 'flowchart LR\n  A[Start] --> B[End]\n')
  const result = slice('flow.mmd')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Start/)
  assert.match(result.stdout, /┌/)
  assert.doesNotMatch(result.stdout, /flowchart/)
})

test('a markdown file draws the diagrams inside it', () => {
  writeFileSync(join(dir, 'with.md'), '# Doc\n\n```mermaid\nsequenceDiagram\n  A->>B: hello\n```\n')
  const result = slice('with.md')
  assert.match(result.stdout, /hello/)
  assert.doesNotMatch(result.stdout, /sequenceDiagram/)
})
