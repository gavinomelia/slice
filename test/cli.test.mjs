/**
 * Black-box tests for argument handling.
 *
 * The CLI is spawned rather than imported: exit codes and the exact stderr
 * text are the contract a person actually meets, and importing `parseArgs`
 * would test a function while leaving the thing they type untested.
 *
 * Everything here is chosen to fail before the CLI reaches gh, git history or
 * the model, so the suite stays hermetic and fast.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const BIN = fileURLToPath(new URL('../bin/slice.mjs', import.meta.url))

/** A throwaway git repo, so tests never depend on the checkout they run in. */
const repo = mkdtempSync(join(tmpdir(), 'slice-cli-'))
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test')
git('commit', '-q', '--allow-empty', '-m', 'base')
git('checkout', '-q', '-b', 'feature-branch')
writeFileSync(join(repo, 'a.rb'), 'class A\nend\n')
git('add', '-A')
git('commit', '-q', '-m', 'Add A')
git('checkout', '-q', 'main')

/**
 * Cache and config are redirected into the throwaway tree.
 *
 * Without this the suite reads whichever ~/.config/slice/config.jsonc the
 * person running it happens to have — so a developer with a house rule in
 * theirs sees different results from CI — and writes review artifacts into
 * their real ~/.cache.
 */
// Beside the repo, never inside it — cache files under the working tree would
// show up in the very diffs these tests assert on.
const home = mkdtempSync(join(tmpdir(), 'slice-cli-home-'))
const xdg = { XDG_CACHE_HOME: join(home, 'cache'), XDG_CONFIG_HOME: join(home, 'config') }

after(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const slice = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...xdg, SLICE_CONFIG: '' },
  })

const slug = repo
  .split('/')
  .pop()
  .replace(/[^a-zA-Z0-9]+/g, '-')
const cachedReview = (name) => join(xdg.XDG_CACHE_HOME, 'slice', slug, name)

test('--version prints just the version', () => {
  const { status, stdout } = slice('--version')
  assert.equal(status, 0)
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('--help names the command and both positional forms', () => {
  const { status, stdout } = slice('--help')
  assert.equal(status, 0)
  assert.match(stdout, /slice 1679/)
  assert.match(stdout, /slice my-branch/)
  assert.match(stdout, /--ai/)
})

test('no analysis runs unless --ai is passed', () => {
  const { status, stdout } = slice('feature-branch', '--branch')
  assert.equal(status, 0)
  assert.match(stdout, /no AI analysis/)
})

test('--prompt with no text is rejected rather than appending nothing', () => {
  const { status, stderr } = slice('--branch', '--prompt')
  assert.equal(status, 1)
  assert.match(stderr, /--prompt needs some text/)
})

test('-p lands in review.instructions, and adds to what the config already said', () => {
  // --print-config resolves and exits, so this checks the wiring without
  // reaching the model. The config lives outside the repo so it never shows
  // up in a later test's diff.
  const configPath = join(mkdtempSync(join(tmpdir(), 'slice-prompt-')), 'config.jsonc')
  writeFileSync(configPath, '{ "review": { "instructions": "Ignore vendor." } }')

  const { status, stdout } = slice(
    '--config',
    configPath,
    '--print-config',
    '-p',
    'Group by file type.',
    '-p',
    'Security.',
  )
  assert.equal(status, 0)

  const { review } = JSON.parse(stdout.slice(stdout.indexOf('{')))
  assert.match(review.instructions, /Ignore vendor\./, 'the config rule survives a one-off prompt')
  assert.match(review.instructions, /Group by file type\.\nSecurity\./, 'repeating -p adds rather than replaces')
})

test('an unknown option is rejected as an option, not read as a branch', () => {
  const { status, stderr } = slice('--bogus')
  assert.equal(status, 1)
  assert.match(stderr, /unknown option "--bogus"/)
})

test('two positionals are rejected rather than one silently winning', () => {
  const { status, stderr } = slice('1679', 'some-branch')
  assert.equal(status, 1)
  assert.match(stderr, /only one PR number or branch/)
})

test('a branch that does not exist says so, and says it is not a PR either', () => {
  const { status, stderr } = slice('no-such-branch', '--branch')
  assert.equal(status, 1)
  assert.match(stderr, /no pull request and no branch named "no-such-branch"/)
})

test('a named branch is diffed against its base', () => {
  // No --ai, so this never touches the model — analysis is opt-in.
  const { status, stdout } = slice('feature-branch', '--branch')
  assert.equal(status, 0)
  assert.match(stdout, /branch feature-branch vs main/)
  assert.match(stdout, /1 changed file/, 'the named branch is diffed even though main is checked out')
})

test('with no AI analysis, files are ordered by when they were first committed, not alphabetically', () => {
  git('checkout', '-q', '-b', 'order-branch')
  writeFileSync(join(repo, 'z.rb'), 'first\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'touch z first')
  writeFileSync(join(repo, 'a.rb'), 'second\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'touch a second')
  git('checkout', '-q', 'main')

  const { status, stderr } = slice('order-branch', '--branch')
  assert.equal(status, 0, stderr)

  const review = JSON.parse(readFileSync(cachedReview('branch-order-branch.review.json'), 'utf8'))
  assert.deepEqual(review.slices[0].paths, ['z.rb', 'a.rb'])
})

test('probing git does not leak the child stderr', () => {
  // The repo has no remote, so origin/HEAD lookups fail on every run. Those
  // are expected misses and must not surface as "fatal:" noise.
  const { stderr } = slice('feature-branch', '--branch')
  assert.ok(!stderr.includes('fatal:'), stderr)
})

test('--open reports a missing review file instead of crashing', () => {
  const { status, stderr } = slice('--open', join(repo, 'nope.json'))
  assert.equal(status, 1)
  assert.match(stderr, /no such review file/)
})

test('--print-config resolves without any config file present', () => {
  const { status, stdout } = slice('--print-config')
  assert.equal(status, 0)
  assert.match(stdout, /"severities"/)
})

test('--init-config writes a repo config and refuses to clobber it', () => {
  const first = slice('--init-config')
  assert.equal(first.status, 0)
  assert.match(first.stdout, /\.slice\.jsonc/)

  const second = slice('--init-config')
  assert.equal(second.status, 1)
  assert.match(second.stderr, /already exists/)
})

test('--init-config does not swallow a following positional', () => {
  // `--init-config 1679` must not read 1679 as the scope.
  const { stderr, status } = slice('--init-config', 'no-such-branch')
  assert.equal(status, 1, stderr)
  assert.match(stderr, /already exists|no pull request/)
})

test('a flag that needs a value says so instead of silently dropping itself', () => {
  // A bare --open used to become undefined, which is falsy, so the flag was
  // ignored and the current branch got reviewed instead.
  for (const flag of ['--open', '--config', '--base']) {
    const { status, stderr } = slice(flag)
    assert.equal(status, 1, `${flag} exits non-zero`)
    assert.match(stderr, new RegExp(`\\${flag} needs a value`))
  }
})

test('a flag swallowing the next flag is caught too', () => {
  const { status, stderr } = slice('--open', '--ai')
  assert.equal(status, 1)
  assert.match(stderr, /--open needs a value/)
})

test('--timeout rejects what it cannot use rather than defaulting silently', () => {
  for (const bad of ['abc', '0', '-5']) {
    const { status, stderr } = slice('--timeout', bad)
    assert.equal(status, 1, `--timeout ${bad} exits non-zero`)
    assert.match(stderr, /--timeout needs a positive number/)
  }
})

test('--open refuses a file that is not a review, and says which way it is wrong', () => {
  const bad = join(home, 'bad.json')

  writeFileSync(bad, 'not json at all')
  assert.match(slice('--open', bad).stderr, /not valid JSON/)

  writeFileSync(bad, JSON.stringify({ version: 99, target: {}, files: {}, slices: [], findings: [], overview: {} }))
  assert.match(slice('--open', bad).stderr, /review format 99/)

  writeFileSync(bad, JSON.stringify({ version: 1 }))
  assert.match(slice('--open', bad).stderr, /missing target/)
})

test('--open works outside a git repository, as documented', () => {
  const { status, stdout } = slice('--branch', 'feature-branch')
  assert.equal(status, 0)

  const reviewPath = cachedReview('branch-feature-branch.review.json')
  assert.ok(stdout.length > 0)

  // Run it from somewhere that is definitely not a checkout.
  const outside = spawnSync(process.execPath, [BIN, '--open', reviewPath], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, ...xdg, SLICE_CONFIG: '' },
  })
  assert.equal(outside.status, 0, outside.stderr)
  // Not a tty under the test runner, so the viewer declines to draw and says
  // where the review is instead — which is the non-interactive contract.
  assert.match(outside.stderr, /not a terminal/)
})

test('a repo config cannot hand the analysis new tools, and the CLI says so', () => {
  writeFileSync(join(repo, '.slice.jsonc'), JSON.stringify({ review: { allowedTools: ['Bash'] } }))
  try {
    const { stdout, stderr } = slice('--print-config')
    assert.match(stderr, /ignoring "review\.allowedTools"/)
    const config = JSON.parse(stdout.slice(stdout.indexOf('{')))
    assert.deepEqual(config.review.allowedTools, ['Read', 'Grep', 'Glob'])
  } finally {
    rmSync(join(repo, '.slice.jsonc'), { force: true })
  }
})

test('--clear-cache removes the cache and is honest when there is none', () => {
  slice('--branch', 'feature-branch')
  assert.ok(existsSync(cachedReview('branch-feature-branch.review.json')))

  const first = slice('--clear-cache')
  assert.equal(first.status, 0)
  assert.match(first.stdout, /removed/)
  assert.equal(existsSync(cachedReview('branch-feature-branch.review.json')), false)

  assert.match(slice('--clear-cache').stdout, /nothing cached/)
})
