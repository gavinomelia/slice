import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { watchDirs } from '../src/pipeline/watch.mjs'

const root = mkdtempSync(join(tmpdir(), 'slice-watch-'))
after(() => rmSync(root, { recursive: true, force: true }))

const settle = (ms) => new Promise((done) => setTimeout(done, ms))

test('a burst of writes reloads once, after it settles', async () => {
  const dir = join(root, 'burst')
  mkdirSync(dir)
  let changes = 0
  const stop = watchDirs({ dirs: () => [dir], onChange: () => changes++, delayMs: 50 })
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'a.rb'), `v${i}\n`)
    await settle(200)
    assert.equal(changes, 1)
  } finally {
    stop()
  }
})

test('ignored events do not reload', async () => {
  const dir = join(root, 'ignored')
  mkdirSync(dir)
  let changes = 0
  const stop = watchDirs({
    dirs: () => [dir],
    ignore: (_, name) => name === 'index.lock',
    onChange: () => changes++,
    delayMs: 50,
  })
  try {
    writeFileSync(join(dir, 'index.lock'), '')
    await settle(200)
    assert.equal(changes, 0)
  } finally {
    stop()
  }
})

test('directories that appear after a change are watched from then on', async () => {
  const dir = join(root, 'grow')
  const nested = join(dir, 'nested')
  mkdirSync(dir)
  let changes = 0
  const stop = watchDirs({ dirs: () => [dir, nested], onChange: () => changes++, delayMs: 50 })
  try {
    mkdirSync(nested)
    await settle(200)
    assert.equal(changes, 1)

    writeFileSync(join(nested, 'b.rb'), 'x\n')
    await settle(200)
    assert.equal(changes, 2)
  } finally {
    stop()
  }
})

test('nothing fires after the watcher is stopped', async () => {
  const dir = join(root, 'stopped')
  mkdirSync(dir)
  let changes = 0
  const stop = watchDirs({ dirs: () => [dir], onChange: () => changes++, delayMs: 50 })
  writeFileSync(join(dir, 'a.rb'), 'x\n')
  stop()
  await settle(200)
  assert.equal(changes, 0)
})
