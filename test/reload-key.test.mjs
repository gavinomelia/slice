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

const root = mkdtempSync(join(tmpdir(), 'slice-reload-'))
after(() => rmSync(root, { recursive: true, force: true }))

const children = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const REPLY = JSON.stringify({
  result: JSON.stringify({
    overview: { intent: 'Add a thing', assessment: 'Fine', risk: 'low' },
    slices: [{ id: 'the-thing', title: 'The stubbed slice', kind: 'behavior', summary: 'One file.', paths: ['a.rb'] }],
    findings: [],
  }),
})

const addedFile = (name) =>
  `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+class Added\n`

function setup(name) {
  const dir = join(root, name)
  const repo = join(dir, 'repo')
  const stubs = join(dir, 'bin')
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubs)
  const git = (...args) => spawnSync('git', args, { cwd: repo })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('checkout', '-q', '-b', 'feature')
  const commit = (file) => {
    writeFileSync(join(repo, file), 'class A\nend\n')
    git('add', '-A')
    git('commit', '-q', '-m', `Add ${file}`)
  }
  commit('a.rb')

  const reply = join(dir, 'reply.json')
  writeFileSync(reply, REPLY)
  writeFileSync(join(stubs, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo stub; exit 0; }\ncat "${reply}"\n`)
  chmodSync(join(stubs, 'claude'), 0o755)

  return { dir, repo, stubs, git, commit, cache: join(dir, 'cache'), config: join(dir, 'config') }
}

function stubGh({ dir, stubs }) {
  const patch = join(dir, 'pr.patch')
  const broken = join(dir, 'gh-broken')
  writeFileSync(patch, addedFile('first.rb'))
  writeFileSync(
    join(stubs, 'gh'),
    `#!/bin/sh
[ -e "${broken}" ] && exit 1
case "$1 $2" in
  "pr view") echo '{"number":7,"title":"The PR","author":{"login":"someone"},"url":"https://github.com/acme/app/pull/7","baseRefName":"main","headRefName":"feature","headRefOid":"abc"}' ;;
  "pr diff") cat "${patch}" ;;
  "api user") echo me ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(stubs, 'gh'), 0o755)
  return { patch, broken }
}

function open({ repo, stubs, cache, config }, ...flags) {
  const command = `stty cols 120 rows 40; exec ${process.execPath} ${BIN} ${flags.join(' ')}`
  const child = spawn('script', ['-qefc', command, '/dev/null'], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      TERM: 'xterm',
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
    until: async (what) => {
      const met = typeof what === 'function' ? what : () => screen.includes(what)
      for (const start = Date.now(); !met(); await sleep(25)) {
        if (Date.now() - start > 20000) assert.fail(`timed out waiting for ${what}\n${screen.slice(-2000)}`)
      }
    },
    press: (key) => child.stdin.write(key),
    pressAndSee: async (key, what) => {
      const mark = screen.length
      child.stdin.write(key)
      await viewer.until(() => screen.slice(mark).includes(what))
    },
    screen: () => screen,
    quit: () => (child.stdin.write('q'), closed),
  }
  return viewer
}

test('r picks up a new commit on a branch diff', { skip }, async () => {
  const fixture = setup('commit')
  const viewer = open(fixture, '--branch')
  await viewer.until('[r] reload')
  assert.equal(viewer.screen().includes('b.rb'), false)

  fixture.commit('b.rb')
  await viewer.pressAndSee('r', 'b.rb')
  await viewer.until('Diff updated')
  await viewer.quit()
})

test('r on a clean, unchanged branch says it is up to date', { skip }, async () => {
  const fixture = setup('clean')
  const viewer = open(fixture, '--branch')
  await viewer.until('[r] reload')
  await viewer.pressAndSee('r', 'already up to date')
  await viewer.quit()
})

test('r on a branch diff explains why an uncommitted edit does not appear', { skip }, async () => {
  const fixture = setup('dirty')
  const viewer = open(fixture, '--branch')
  await viewer.until('[r] reload')
  writeFileSync(join(fixture.repo, 'a.rb'), 'class A\n  changed\nend\n')
  await viewer.pressAndSee('r', 'slice -w')
  await viewer.quit()
})

test('r stays on the branch it opened after you switch away', { skip }, async () => {
  const fixture = setup('switched')
  const viewer = open(fixture, '--branch')
  await viewer.until('[r] reload')
  fixture.git('checkout', '-q', '-b', 'other')
  fixture.commit('other.rb')
  await viewer.pressAndSee('r', 'already up to date')
  assert.equal(viewer.screen().includes('other.rb'), false)
  await viewer.quit()
})

test('r refetches a PR', { skip }, async () => {
  const fixture = setup('pr')
  const { patch } = stubGh(fixture)
  const viewer = open(fixture)
  await viewer.until('[r] reload')
  await viewer.until('first.rb')

  await viewer.pressAndSee('r', 'unchanged on GitHub')

  writeFileSync(patch, addedFile('first.rb') + addedFile('second.rb'))
  await viewer.pressAndSee('r', 'second.rb')
  await viewer.quit()
})

test('a failed PR reload is reported and the viewer stays open', { skip }, async () => {
  const fixture = setup('offline')
  const { broken } = stubGh(fixture)
  const viewer = open(fixture)
  await viewer.until('[r] reload')

  writeFileSync(broken, '')
  await viewer.pressAndSee('r', 'Reload failed')
  rmSync(broken)
  await viewer.pressAndSee('r', 'unchanged on GitHub')
  await viewer.quit()
})

test('a after r analyzes the reloaded diff', { skip }, async () => {
  const fixture = setup('analyze')
  const viewer = open(fixture, '--branch')
  await viewer.until('[r] reload')

  fixture.commit('b.rb')
  await viewer.pressAndSee('r', 'b.rb')
  await viewer.until('Diff updated')
  await viewer.pressAndSee('a', 'Analysis finished')

  const patch = join(fixture.cache, 'slice', 'repo', 'branch-feature.patch')
  assert.ok(existsSync(patch))
  assert.match(readFileSync(patch, 'utf8'), /b\.rb/)
  await viewer.quit()
})
