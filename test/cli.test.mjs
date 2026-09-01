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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

const sliceIn = (cwd, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...xdg, SLICE_CONFIG: '' },
  })

const slice = (...args) => sliceIn(repo, ...args)

const slugFor = (dir) =>
  dir
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9]+/g, '-')
const cachedIn = (dir, name) => join(xdg.XDG_CACHE_HOME, 'slice', slugFor(dir), name)
const cachedReview = (name) => cachedIn(repo, name)

/**
 * A repo of its own for each working-tree test.
 *
 * --wip reads whatever is lying around, so these tests have to leave things
 * lying around — and a dirty shared tree would quietly change what every later
 * test diffs.
 */
const scratch = []
function wipRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'slice-wip-'))
  scratch.push(dir)
  const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.rb'), 'class A\nend\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'base')
  return { dir, git: run }
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

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

test('--wip reviews staged, unstaged and untracked work as one diff', () => {
  const { dir, git } = wipRepo()

  writeFileSync(join(dir, 'a.rb'), 'class A\n  def a; end\nend\n')
  git('add', 'a.rb')
  // Edited again after staging, so this file is in both states at once.
  appendFileSync(join(dir, 'a.rb'), '# still typing\n')
  writeFileSync(join(dir, 'new.rb'), 'fresh\n')
  writeFileSync(join(dir, '.gitignore'), 'build.log\n')
  writeFileSync(join(dir, 'build.log'), 'noise\n')

  const { status, stdout } = sliceIn(dir, '--wip')
  assert.equal(status, 0, stdout)
  assert.match(stdout, /working tree vs main/)
  assert.match(stdout, /3 changed file\(s\) — 1 staged, 1 with unstaged edits, 2 untracked/)

  const review = JSON.parse(readFileSync(cachedIn(dir, 'wip-main.review.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(review.files).sort(),
    ['.gitignore', 'a.rb', 'new.rb'],
    'an ignored file is not part of the change',
  )
  assert.equal(review.files['new.rb'].status, 'added', 'an untracked file reads as added, not as missing')
  assert.match(review.files['new.rb'].patch, /\+fresh/, 'and carries its contents, without being staged')
  assert.equal(
    git('status', '--porcelain', 'new.rb').stdout.slice(0, 2),
    '??',
    'reviewing an untracked file does not stage it',
  )
})

test('--wip orders files by when you touched them, not alphabetically', () => {
  const { dir } = wipRepo()
  for (const name of ['c.rb', 'b.rb', 'd.rb']) writeFileSync(join(dir, name), `# ${name}\n`)

  // Set mtimes explicitly: writing three files takes less time than the
  // filesystem's timestamp resolution, so the order would otherwise be a
  // coin toss.
  const at = (name, seconds) => utimesSync(join(dir, name), seconds, seconds)
  at('d.rb', 1_700_000_100)
  at('b.rb', 1_700_000_200)
  at('c.rb', 1_700_000_300)

  const { status, stdout } = sliceIn(dir, '--wip')
  assert.equal(status, 0, stdout)

  const review = JSON.parse(readFileSync(cachedIn(dir, 'wip-main.review.json'), 'utf8'))
  assert.deepEqual(review.slices[0].paths, ['d.rb', 'b.rb', 'c.rb'])
})

test('--wip on a clean tree says so rather than opening an empty review', () => {
  const { dir } = wipRepo()
  const { status, stderr } = sliceIn(dir, '--wip')
  assert.equal(status, 1)
  assert.match(stderr, /nothing uncommitted — the working tree is clean/)
})

test('--wip refuses the flags it would otherwise have to ignore', () => {
  const { dir } = wipRepo()
  writeFileSync(join(dir, 'a.rb'), 'changed\n')

  assert.match(sliceIn(dir, '--wip', '--branch').stderr, /--wip and --branch are different diffs/)
  assert.match(sliceIn(dir, '--wip', 'some-branch').stderr, /takes no PR number or branch \(got "some-branch"\)/)
  assert.match(sliceIn(dir, '--wip', '--base', 'main').stderr, /--base belongs to --branch/)
  for (const args of [
    ['--wip', '--branch'],
    ['--wip', 'some-branch'],
    ['--wip', '--base', 'main'],
  ]) {
    assert.equal(sliceIn(dir, ...args).status, 1, args.join(' '))
  }
})

test('a cached wip analysis is dropped once the tree it read has changed', () => {
  const { dir } = wipRepo()
  appendFileSync(join(dir, 'a.rb'), '# one\n')
  assert.equal(sliceIn(dir, '--wip').status, 0)

  // Stand in for a finished --ai run, keyed to the tree it analyzed, alongside
  // cache entries belonging to other targets.
  const analysis = cachedIn(dir, 'wip-main-deadbeef.analysis.json')
  const other = cachedIn(dir, 'branch-main-deadbeef.analysis.json')
  writeFileSync(analysis, '{}')
  writeFileSync(other, '{}')

  appendFileSync(join(dir, 'a.rb'), '# two\n')
  assert.equal(sliceIn(dir, '--wip').status, 0)

  assert.equal(existsSync(analysis), false, 'an analysis of code that has since changed is not kept to be reused')
  assert.ok(existsSync(other), 'and nothing else in the cache is touched')
  assert.ok(existsSync(cachedIn(dir, 'wip-main.review.json')), 'the review path is stable, so read marks survive')
})

test('an analysis already on disk is reopened without --ai', () => {
  // Planted rather than produced: reusing a cached analysis must not reach the
  // provider, which is the whole reason it is allowed without --ai.
  git('checkout', '-q', '-b', 'cached-branch')
  writeFileSync(join(repo, 'cached.rb'), 'work\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'work')
  git('checkout', '-q', 'main')

  writeFileSync(
    cachedReview('branch-cached-branch.analysis.json'),
    JSON.stringify({
      overview: { intent: 'Add a thing', assessment: 'Fine', risk: 'low' },
      slices: [{ id: 'the-thing', title: 'The thing', kind: 'behavior', summary: 'One file.', paths: ['cached.rb'] }],
      findings: [
        {
          severity: 'bug',
          confidence: 'confirmed',
          path: 'cached.rb',
          line: 1,
          title: 'Wrong',
          why: 'It is.',
          fix: '',
        },
      ],
    }),
  )

  const { status, stdout } = slice('cached-branch', '--branch')
  assert.equal(status, 0, stdout)
  assert.match(stdout, /using the analysis from an earlier --ai run/)
  assert.doesNotMatch(stdout, /no AI analysis/)
  assert.match(stdout, /1 slice\(s\), 1 finding\(s\)/)

  const review = JSON.parse(readFileSync(cachedReview('branch-cached-branch.review.json'), 'utf8'))
  assert.equal(review.slices[0].title, 'The thing')
  assert.equal(review.findings[0].title, 'Wrong')
})

test('--refresh does not quietly reuse the analysis it was asked to redo', () => {
  // Aimed at a provider that cannot resolve, so this proves the refresh went
  // looking for one — no test in this file may actually reach a model.
  const configPath = join(mkdtempSync(join(tmpdir(), 'slice-refresh-')), 'config.jsonc')
  writeFileSync(configPath, '{ "review": { "provider": "nope" } }')

  const { status, stdout, stderr } = slice('cached-branch', '--branch', '--refresh', '--config', configPath)
  assert.equal(status, 1)
  assert.match(stderr, /unknown review\.provider "nope"/)
  assert.doesNotMatch(stdout, /using the analysis|using cached analysis/, stdout)
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
