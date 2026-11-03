import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, test } from 'node:test'

const BIN = fileURLToPath(new URL('../bin/slice.mjs', import.meta.url))
const skip =
  process.platform === 'linux' && spawnSync('script', ['--version']).status === 0 ? false : 'needs util-linux script'

const root = mkdtempSync(join(tmpdir(), 'slice-mouse-'))
after(() => rmSync(root, { recursive: true, force: true }))

const children = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const press = (x, y) => `\x1b[<0;${x};${y}M`
const drag = (x, y) => `\x1b[<32;${x};${y}M`
const release = (x, y) => `\x1b[<0;${x};${y}m`

const CODE_LEFT = 40
const RIGHT_EDGE = 118
const SPLIT_RIGHT_CODE = 83
const FIRST_CODE_ROW = 6

async function open(name, { before = null, after: changed, editor = 'true' }) {
  const dir = join(root, name)
  const repo = join(dir, 'repo')
  const stubs = join(dir, 'bin')
  const clip = join(dir, 'clip')
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubs)
  const git = (...args) => spawnSync('git', args, { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  if (before) writeFileSync(join(repo, 'a.rb'), before)
  git('add', '-A')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(repo, 'a.rb'), changed)
  git('add', '-A')
  git('commit', '-q', '-m', 'Change A')
  writeFileSync(join(stubs, 'wl-copy'), `#!/bin/sh\ncat > "${clip}"\n`)
  chmodSync(join(stubs, 'wl-copy'), 0o755)

  const command = `stty cols 120 rows 40; exec ${process.execPath} ${BIN} --branch`
  const child = spawn('script', ['-qefc', command, '/dev/null'], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_CONFIG_HOME: join(dir, 'config'),
      VISUAL: editor,
      EDITOR: editor,
      TERM: 'xterm',
      FORCE_COLOR: '3',
      CI: 'false',
      CONTINUOUS_INTEGRATION: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let screen = ''
  child.stdout.on('data', (chunk) => (screen += chunk))
  const closed = new Promise((done) => child.on('close', done))

  const viewer = {
    send: (...keys) => child.stdin.write(keys.join('')),
    screen: () => screen,
    until: async (what) => {
      for (const start = Date.now(); !what(); await sleep(25)) {
        if (Date.now() - start > 20000) assert.fail(`timed out\n${screen.slice(-2000)}`)
      }
    },
    clipboard: async () => {
      await viewer.until(() => existsSync(clip))
      await sleep(50)
      return readFileSync(clip, 'utf8')
    },
    copied: () => existsSync(clip),
    quit: () => (child.stdin.write('q'), closed),
  }

  await viewer.until(() => screen.includes('[q] quit'))
  for (let i = 0; i < 4 && !screen.includes('a.rb'); i++) await sleep(100)
  for (let i = 0; i < 4 && !screen.includes('@@'); i++) {
    viewer.send('j')
    await sleep(200)
  }
  await viewer.until(() => screen.includes('@@'))
  viewer.send('2')
  await viewer.until(() => screen.includes('[j/k] line'))
  return viewer
}

test('a drag across the whole pane copies only the code, and the mouse is handed back on quit', { skip }, async () => {
  const viewer = await open('whole', { after: 'class Alpha\n  def beta\n  end\nend\n' })
  assert.match(viewer.screen(), /\x1b\[\?1002h/)

  viewer.send(press(1, FIRST_CODE_ROW), drag(1, FIRST_CODE_ROW))
  await sleep(100)
  assert.equal(viewer.copied(), false, 'a press in the sidebar starts no selection')
  viewer.send(release(1, FIRST_CODE_ROW))

  viewer.send(press(CODE_LEFT - 8, FIRST_CODE_ROW), drag(RIGHT_EDGE, FIRST_CODE_ROW + 3))
  viewer.send(release(RIGHT_EDGE, FIRST_CODE_ROW + 3))
  assert.equal(await viewer.clipboard(), 'class Alpha\n  def beta\n  end\nend')

  await viewer.quit()
  assert.match(viewer.screen(), /\x1b\[\?1006l\x1b\[\?1002l/)
})

test('a drag copies from the cell it started on to the cell it ended on', { skip }, async () => {
  const viewer = await open('cells', { after: 'class Alpha\n' })
  const mark = viewer.screen().length
  viewer.send(press(CODE_LEFT + 6, FIRST_CODE_ROW), drag(CODE_LEFT + 10, FIRST_CODE_ROW))
  await viewer.until(() => /\x1b\[7m(\x1b\[[\d;]*m)*Alpha/.test(viewer.screen().slice(mark)))
  viewer.send(release(CODE_LEFT + 10, FIRST_CODE_ROW))
  assert.equal(await viewer.clipboard(), 'Alpha')
  await viewer.quit()
})

test('in split view a drag stays in the column it started in', { skip }, async () => {
  const viewer = await open('split', { before: 'old line\n', after: 'new line\n' })
  viewer.send('v')
  await viewer.until(() => viewer.screen().includes('[v] unified'))
  await sleep(100)
  viewer.send(press(SPLIT_RIGHT_CODE, FIRST_CODE_ROW), drag(RIGHT_EDGE, FIRST_CODE_ROW))
  viewer.send(release(RIGHT_EDGE, FIRST_CODE_ROW))
  assert.equal(await viewer.clipboard(), 'new line')
  await viewer.quit()
})

test('holding a drag past the bottom of the pane scrolls and keeps selecting', { skip }, async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`)
  const viewer = await open('scroll', { after: `${lines.join('\n')}\n` })
  viewer.send(press(CODE_LEFT, FIRST_CODE_ROW), drag(RIGHT_EDGE, 39))
  await sleep(1500)
  viewer.send(release(RIGHT_EDGE, 39))
  assert.equal(await viewer.clipboard(), lines.join('\n'))
  await viewer.quit()
})

test('a mouse sequence never reaches the key bindings', { skip }, async () => {
  const viewer = await open('keys', { after: 'class Alpha\n' })
  const mark = viewer.screen().length
  viewer.send('\x1b[<2;50;10M', '\x1b[<2;50;10m')
  await sleep(300)
  assert.equal(viewer.screen().slice(mark).includes('[j/k] move'), false, 'its 1 would have focused the tree')
  await viewer.quit()
})

test('the wheel moves the focused pane', { skip }, async () => {
  const viewer = await open('wheel', { after: 'class Alpha\nend\n' })
  const mark = viewer.screen().length
  viewer.send('\x1b[<65;50;10M')
  await viewer.until(() => viewer.screen().slice(mark).includes('L1'))
  await viewer.quit()
})

test('the mouse is off while $EDITOR has the terminal', { skip }, async () => {
  const viewer = await open('editor', { after: 'class Alpha\n' })
  viewer.send('j')
  await sleep(100)
  const mark = viewer.screen().length
  viewer.send('c')
  await viewer.until(() => /\x1b\[\?1006l[\s\S]*\x1b\[\?1002h/.test(viewer.screen().slice(mark)))
  await viewer.quit()
})
