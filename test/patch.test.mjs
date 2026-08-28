import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitPatch } from '../src/pipeline/patch.mjs'

const diff = (...lines) => lines.join('\n') + '\n'

test('splits a multi-file diff into self-contained patches', () => {
  const files = splitPatch(
    diff(
      'diff --git a/a.rb b/a.rb',
      '--- a/a.rb',
      '+++ b/a.rb',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/b.rb b/b.rb',
      '--- a/b.rb',
      '+++ b/b.rb',
      '@@ -1,0 +1,2 @@',
      '+one',
      '+two',
    ),
  )

  assert.equal(files.length, 2)
  assert.deepEqual(
    files.map((f) => f.path),
    ['a.rb', 'b.rb'],
  )
  // Each chunk has to stand alone — the viewer parses one file at a time.
  assert.ok(files[1].patch.startsWith('diff --git a/b.rb'))
  assert.ok(!files[1].patch.includes('a.rb'))
})

test('counts additions and deletions but not the hunk header', () => {
  const [file] = splitPatch(
    diff('diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' ctx', '-gone', '+here', '+extra'),
  )
  assert.equal(file.additions, 2)
  assert.equal(file.deletions, 1)
})

test('classifies added, deleted, renamed, and binary files', () => {
  const cases = [
    ['new file mode 100644', 'added'],
    ['deleted file mode 100644', 'deleted'],
  ]
  for (const [marker, status] of cases) {
    const [file] = splitPatch(diff('diff --git a/x b/x', marker, '--- a/x', '+++ b/x', '@@ -1 +1 @@', '+y'))
    assert.equal(file.status, status, marker)
  }

  const [renamed] = splitPatch(
    diff('diff --git a/old.rb b/new.rb', 'similarity index 90%', 'rename from old.rb', 'rename to new.rb'),
  )
  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.path, 'new.rb', 'a rename is keyed by where the file ends up')
  assert.equal(renamed.prevPath, 'old.rb')

  const [binary] = splitPatch(diff('diff --git a/i.png b/i.png', 'Binary files a/i.png and b/i.png differ'))
  assert.equal(binary.status, 'binary')
})

test('reads paths containing spaces from the ---/+++ lines', () => {
  // The `diff --git` line is ambiguous when a path has a space in it, which is
  // exactly why the body is preferred over the header.
  const [file] = splitPatch(
    diff(
      'diff --git a/my dir/a b.rb b/my dir/a b.rb',
      '--- a/my dir/a b.rb',
      '+++ b/my dir/a b.rb',
      '@@ -1 +1 @@',
      '+x',
    ),
  )
  assert.equal(file.path, 'my dir/a b.rb')
})

test('a deleted file is keyed by its old path, not /dev/null', () => {
  const [file] = splitPatch(
    diff(
      'diff --git a/gone.rb b/gone.rb',
      'deleted file mode 100644',
      '--- a/gone.rb',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
    ),
  )
  assert.equal(file.path, 'gone.rb')
})

test('returns nothing for empty or non-diff input', () => {
  for (const input of ['', '   ', null, undefined, 'just some prose']) {
    assert.deepEqual(splitPatch(input), [])
  }
})
