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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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

after(() => rmSync(repo, { recursive: true, force: true }))

const slice = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8' })

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

  const slug = repo.split('/').pop().replace(/[^a-zA-Z0-9]+/g, '-')
  const reviewPath = join(homedir(), '.cache', 'slice', slug, 'branch-order-branch.review.json')
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'))
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
