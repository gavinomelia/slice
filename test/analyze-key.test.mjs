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

const root = mkdtempSync(join(tmpdir(), 'slice-key-'))
after(() => rmSync(root, { recursive: true, force: true }))

const children = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

const REPLY = JSON.stringify({
  result: JSON.stringify({
    overview: { intent: 'Add a thing', assessment: 'Fine', risk: 'low' },
    slices: [{ id: 'the-thing', title: 'The stubbed slice', kind: 'behavior', summary: 'One file.', paths: ['a.rb'] }],
    findings: [],
  }),
})

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
  writeFileSync(join(repo, 'a.rb'), 'class A\nend\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Add A')

  const args = join(dir, 'args')
  const fail = join(dir, 'fail')
  const reply = join(dir, 'reply.json')
  writeFileSync(reply, REPLY)
  writeFileSync(
    join(stubs, 'claude'),
    `#!/bin/sh
[ "$1" = "--version" ] && { echo stub; exit 0; }
echo "$@" >> "${args}"
[ -e "${fail}" ] && { echo refused >&2; exit 3; }
cat "${reply}"
`,
  )
  chmodSync(join(stubs, 'claude'), 0o755)

  const cache = join(dir, 'cache')
  return {
    repo,
    stubs,
    args,
    fail,
    cache,
    config: join(dir, 'config'),
    analysis: join(cache, 'slice', 'repo', 'branch-feature.analysis.json'),
  }
}

function open({ repo, stubs, cache, config }, ...flags) {
  const command = `stty cols 120 rows 40; exec ${process.execPath} ${BIN} --branch ${flags.join(' ')}`
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

  return {
    press: (key) => child.stdin.write(key),
    screen: () => screen,
    until: async (what) => {
      const met = typeof what === 'function' ? what : () => screen.includes(what)
      for (const start = Date.now(); !met(); await new Promise((done) => setTimeout(done, 25))) {
        if (Date.now() - start > 20000) assert.fail(`timed out waiting for ${what}\n${screen.slice(-2000)}`)
      }
    },
    quit: () => (child.stdin.write('q'), closed),
  }
}

test('a analyzes the open diff with the model from --model', { skip }, async () => {
  const fixture = setup('runs')
  const viewer = open(fixture, '--model', 'opus')
  await viewer.until('[a] analyze')
  assert.equal(existsSync(fixture.args), false, 'nothing runs until the key is pressed')

  viewer.press('a')
  await viewer.until('The stubbed slice')
  assert.ok(existsSync(fixture.analysis), 'the result is cached for the next run')
  assert.match(readFileSync(fixture.args, 'utf8'), /--model opus/)

  viewer.press('a')
  await viewer.until('already analyzed')
  await viewer.quit()
  assert.equal(
    readFileSync(fixture.args, 'utf8').match(/--output-format/g).length,
    1,
    'a current analysis is not redone',
  )
})

test('a failed analysis leaves the viewer able to try again, and says why on quit', { skip }, async () => {
  const fixture = setup('retries')
  writeFileSync(fixture.fail, '')
  const viewer = open(fixture)
  await viewer.until('[a] analyze')

  viewer.press('a')
  await viewer.until('Analysis failed')
  const running = viewer.screen().lastIndexOf('Analysis is running')
  await viewer.until(() => viewer.screen().indexOf('Press a to run one', running) > running)

  rmSync(fixture.fail)
  viewer.press('a')
  await viewer.until('The stubbed slice')
  await viewer.quit()

  writeFileSync(fixture.fail, '')
  rmSync(fixture.analysis)
  const second = open(fixture)
  await second.until('[a] analyze')
  second.press('a')
  await second.until('Analysis failed')
  await second.quit()
  assert.match(second.screen(), /analysis failed: claude exited with code 3: refused/)
})
