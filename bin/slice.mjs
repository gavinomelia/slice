#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { configTargets, loadConfig, mergePatch } from '../src/config/index.mjs'
import { configTemplate } from '../src/config/template.mjs'

import { splitPatch } from '../src/pipeline/patch.mjs'
import { bareReview, mergeReview, REVIEW_REQUIRED_KEYS, REVIEW_VERSION } from '../src/pipeline/merge.mjs'
import { analysisPrompt } from '../src/pipeline/prompt.mjs'
import { resolveProvider } from '../src/pipeline/providers/index.mjs'
import { extractJson, limitNotice } from '../src/pipeline/reply.mjs'
import { runViewer } from '../src/viewer/app.mjs'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json')

const USAGE = `
slice — read a pull request as behavioral slices, not as a pile of files

Usage:
  slice [<pr-number>] [options]

  slice              review the PR for the current branch, or the branch diff
  slice 1679         review PR #1679
  slice my-branch    review that branch's PR, or diff the branch if it has none
  slice --branch     review the local branch diff, ignoring any open PR

  By default this just opens the diff in the viewer — no model runs. Pass
  --ai for the AI-analyzed review: slices, summaries, and findings.

Options:
  -a, --ai          run the AI analysis (slicing, summaries, findings)
  -p, --prompt <t>  add instructions to the review prompt (implies --ai);
                    repeatable — slice -p "review for security in particular"
  --branch          diff the local branch against its base instead of a PR
  --base <ref>      base ref for --branch mode (default: the repo default branch)
  --refresh         re-run the analysis even if a cached one exists (implies --ai)
  --open <file>     open a cached review.json without touching git or the model
  --timeout <s>     give up on the analysis after this many seconds (default 600)
  --clear-cache     delete every cached patch, analysis, and review
  -h, --help        show this
  -v, --version     print the version

Configuration:
  --config <path>       use this config file instead of the discovered ones
  --print-config        show the resolved config and where each layer came from
  --init-config [where] write a starter config — "repo" (default) or "user"

  Discovered from ~/.config/slice/config.jsonc, then .slice.jsonc in the repo.
  The repo layer says how the code is reviewed; yours says how it looks, and is
  the only one that may choose the provider, the model, or the tools the
  analysis is given.

Requires the GitHub CLI (gh) on your PATH. --ai also needs its provider —
Claude Code (claude), which is the only one today.
`

function fail(message) {
  console.error(`slice: ${message}`)
  process.exit(1)
}

/**
 * stderr is captured rather than inherited.
 *
 * execFileSync passes a child's stderr straight through unless told not to,
 * and most calls here are probes whose failure is expected and handled — so
 * the default leaks things like "fatal: ref refs/remotes/origin/HEAD is not a
 * symbolic ref" into a run that is working perfectly well. Genuine failures
 * still carry it, on the thrown error.
 */
function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function tryRun(cmd, args, options = {}) {
  try {
    return run(cmd, args, options)
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const options = {
    ref: null,
    branch: false,
    base: null,
    refresh: false,
    analyze: false,
    prompt: null,
    open: null,
    timeout: 600,
    config: null,
    printConfig: false,
    initConfig: null,
    clearCache: false,
  }

  let i = 0

  /**
   * The value after a flag that needs one.
   *
   * Reading `argv[++i]` unguarded is worse than it looks: a bare `--open`
   * silently becomes `undefined`, which is falsy, so the flag is dropped and
   * the CLI cheerfully reviews the current branch instead of telling you the
   * argument went missing. Anything starting with `-` is the same slip one
   * word later — `slice --open --ai` meant two flags, not a file named --ai.
   */
  const value = (flag, { allowDashes = false } = {}) => {
    const next = argv[++i]
    if (next === undefined || (!allowDashes && next.startsWith('-'))) fail(`${flag} needs a value`)
    return next
  }

  for (; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE.trim())
      process.exit(0)
    } else if (arg === '-v' || arg === '--version') {
      console.log(VERSION)
      process.exit(0)
    } else if (arg === '--open') options.open = value('--open')
    else if (arg === '--config') options.config = value('--config')
    else if (arg === '--print-config') options.printConfig = true
    else if (arg === '--clear-cache') options.clearCache = true
    else if (arg === '--init-config') {
      // The scope is optional, so only consume the next argument when it is
      // one — otherwise `--init-config 1679` would eat the PR number.
      options.initConfig = ['repo', 'user'].includes(argv[i + 1]) ? argv[++i] : 'repo'
    } else if (arg === '--branch') options.branch = true
    else if (arg === '--refresh') options.refresh = true
    else if (arg === '-a' || arg === '--ai') options.analyze = true
    else if (arg === '-p' || arg === '--prompt') {
      // Not routed through `value()`: an instruction is prose, so it may start
      // with a dash, and the message below earns its keep by showing the shape
      // of the thing that is missing.
      const text = argv[++i]
      // A bare -p is a plausible slip, and the silent version of it — an empty
      // instruction appended to the prompt — is indistinguishable from the
      // flag not working.
      if (!text?.trim()) fail('--prompt needs some text, e.g. slice -p "review for security in particular"')
      // Repeating the flag adds to the instructions rather than replacing
      // them, so a shell alias can carry a standing rule and the call still
      // gets to say something of its own.
      options.prompt = options.prompt ? `${options.prompt}\n${text.trim()}` : text.trim()
    } else if (arg === '--base') options.base = value('--base')
    else if (arg === '--timeout') {
      // Dashes allowed through so the numeric check below owns the message: a
      // negative timeout deserves "needs a positive number", not "needs a value".
      const raw = value('--timeout', { allowDashes: true })
      const seconds = Number(raw)
      // `Number(x) || 600` quietly turned both "abc" and "0" into the default,
      // so a mistyped timeout looked like it had been accepted.
      if (!Number.isFinite(seconds) || seconds <= 0) {
        fail(`--timeout needs a positive number of seconds (got "${raw}")`)
      }
      options.timeout = seconds
    } else if (arg.startsWith('-')) fail(`unknown option "${arg}"\n${USAGE}`)
    else if (options.ref !== null) fail(`only one PR number or branch at a time (got "${options.ref}" and "${arg}")`)
    // A bare argument is a PR number or a branch name. Which one it is is not
    // decided here: `gh pr view` accepts either, so the distinction only
    // matters once we know whether a PR came back.
    else options.ref = arg
  }
  // Asking to redo the analysis, or to say something to it, implies wanting it
  // in the first place — otherwise either flag with no --ai silently does
  // nothing.
  if (options.refresh || options.prompt) options.analyze = true
  return options
}

function ghDiagnosis(repoRoot) {
  if (!tryRun('gh', ['--version'])) return 'the GitHub CLI is not installed — see https://cli.github.com'
  if (!tryRun('gh', ['auth', 'status'], { cwd: repoRoot })) return 'gh is not authenticated — run `gh auth login`'
  return null
}

function defaultBranch(repoRoot) {
  const symbolic = tryRun('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot })
  if (symbolic) return symbolic.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if (tryRun('git', ['rev-parse', '--verify', candidate], { cwd: repoRoot })) return candidate
  }
  return 'main'
}

function resolvePrTarget(repoRoot, ref) {
  const fields = 'number,title,author,url,baseRefName,headRefName,headRefOid'
  const args = ['pr', 'view', ...(ref ? [String(ref)] : []), '--json', fields]
  const raw = tryRun('gh', args, { cwd: repoRoot })
  if (!raw) return null

  const pr = JSON.parse(raw)
  const repo =
    pr.url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ??
    tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repoRoot })
  const viewer = tryRun('gh', ['api', 'user', '-q', '.login'], { cwd: repoRoot })

  return {
    kind: 'pr',
    repo: repo ?? '',
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? 'unknown',
    url: pr.url,
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    headSha: pr.headRefOid,
    viewerIsAuthor: Boolean(viewer && pr.author?.login && viewer === pr.author.login),
  }
}

function resolveBranchTarget(repoRoot, base, ref = null) {
  const headRev = ref
    ? ['refs/heads/' + ref, 'refs/remotes/origin/' + ref].find((candidate) =>
        tryRun('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: repoRoot }),
      )
    : 'HEAD'
  if (!headRev) return null

  const headRef = ref ?? run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
  const baseRef = base ?? defaultBranch(repoRoot)
  return {
    kind: 'branch',
    repo: tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repoRoot }) ?? '',
    number: null,
    title: tryRun('git', ['log', '-1', '--pretty=%s', headRev], { cwd: repoRoot }) ?? headRef,
    author: tryRun('git', ['config', 'user.name'], { cwd: repoRoot }) ?? 'you',
    url: null,
    baseRef,
    headRef,
    headRev,
    headSha: run('git', ['rev-parse', headRev], { cwd: repoRoot }),
    viewerIsAuthor: true,
  }
}

function capturePatch(repoRoot, target) {
  if (target.kind === 'pr') {
    const args = ['pr', 'diff', String(target.number), ...(target.repo ? ['--repo', target.repo] : [])]
    const patch = tryRun('gh', args, { cwd: repoRoot })
    if (patch === null) fail(`could not read the diff for PR #${target.number}`)
    return patch
  }
  if (!tryRun('git', ['rev-parse', '--verify', target.baseRef], { cwd: repoRoot })) {
    fail(`base ref "${target.baseRef}" does not exist locally`)
  }
  return run('git', ['diff', `${target.baseRef}...${target.headRev ?? 'HEAD'}`], { cwd: repoRoot })
}

function commitOrder(repoRoot, target) {
  const head = target.kind === 'pr' ? target.headSha : (target.headRev ?? 'HEAD')
  const log = tryRun(
    'git',
    ['log', '--reverse', '--no-merges', '--name-only', '--format=', `${target.baseRef}..${head}`],
    { cwd: repoRoot },
  )
  if (log === null) return null

  const order = []
  const seen = new Set()
  for (const line of log.split('\n')) {
    const path = line.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    order.push(path)
  }
  return order
}

function orderByCommit(files, order) {
  if (!order) return files
  const rank = new Map(order.map((path, i) => [path, i]))
  return files
    .map((file, i) => ({ file, i, rank: rank.get(file.path) ?? rank.get(file.prevPath) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ file }) => file)
}

function conventionSources(repoRoot, configured) {
  if (Array.isArray(configured)) {
    const missing = configured.filter((path) => !existsSync(join(repoRoot, path)))
    for (const path of missing) console.error(`  config names a convention file that does not exist: ${path}`)
    return configured.filter((path) => !missing.includes(path))
  }

  const found = []

  const instructions = join(repoRoot, '.github/instructions')
  if (existsSync(instructions)) {
    for (const name of readdirSync(instructions).sort()) {
      if (name.endsWith('.md')) found.push(`.github/instructions/${name}`)
    }
  }

  for (const candidate of ['docs/CONVENTIONS.md', 'CONVENTIONS.md']) {
    if (existsSync(join(repoRoot, candidate))) found.push(candidate)
  }

  return found
}

function runAnalysis({
  repoRoot,
  target,
  patchPath,
  filesPath,
  rawPath,
  timeoutMs,
  conventionFiles,
  config,
  provider,
  quiet = false,
}) {
  const prompt = analysisPrompt({ patchPath, filesPath, target, repoRoot, conventionFiles, config })

  const startedAt = Date.now()

  // A \r-redrawn counter is for a person watching it. Sent to a pipe or a log
  // file it is one junk line per second, so a non-tty gets a single line
  // instead and still knows something long-running has started. `quiet` is a
  // third case: the viewer is already drawing to this terminal, and either
  // form of progress line would tear its screen up, so nothing is written and
  // the viewer's own status line carries the news instead.
  const live = !quiet && process.stderr.isTTY
  if (!quiet && !live) console.error('  analyzing — reading the repo…')
  const ticker = live
    ? setInterval(() => {
        process.stderr.write(`\r  analyzing — reading the repo… ${Math.round((Date.now() - startedAt) / 1000)}s`)
      }, 1000)
    : null

  const child = spawn(provider.command, provider.buildArgs({ prompt, review: config.review }), {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  return new Promise((done) => {
    const finish = (value, message) => {
      if (ticker) clearInterval(ticker)
      clearTimeout(timer)
      if (live) process.stderr.write(`\r${' '.repeat(56)}\r`)
      if (!quiet) {
        const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`
        if (message) console.error(`  analysis failed after ${elapsed}: ${message}`)
        else console.log(`  analysis finished in ${elapsed}`)
      }
      done(value)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, `analysis timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)

    child.on('error', (error) => finish(null, `${provider.command} failed to start: ${error.message}`))

    child.on('close', (code) => {
      const reply = provider.extractReply(stdout)

      const payload = extractJson(reply) ?? extractJson(stdout)
      if (payload?.slices) return finish(payload, null)

      const limit = limitNotice(reply, stderr)

      let saved = false
      if (!limit && reply.includes('{')) {
        writeFileSync(rawPath, reply)
        saved = true
      }

      const reason = limit
        ? `${provider.name} hit a usage limit — ${limit}`
        : code !== 0
          ? `${provider.command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}`
          : payload
            ? 'the analysis reply was JSON but had no "slices" key'
            : 'the analysis reply was not in the expected shape'

      finish(null, `${reason}${saved ? `\n  the raw reply is at ${rawPath} — the next run will retry parsing it` : ''}`)
    })
  })
}

function initConfig(scope, repoRoot) {
  const path = configTargets(repoRoot)[scope]
  if (existsSync(path)) fail(`${path} already exists — edit it, or delete it first`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, configTemplate(scope))
  console.log(`\n  wrote ${path}\n\n  The settings in it are commented out; uncomment what you want to change.\n`)
}

function printConfig({ config, sources }) {
  console.log(
    `\n  ${sources.length ? sources.join('\n  ') : 'no config files found — these are the built-in defaults'}\n`,
  )
  console.log(JSON.stringify(config, null, 2))
}

/** Everything slice caches lives under one directory, so it can all be dropped at once. */
const cacheHome = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'slice')

function clearCache() {
  const root = cacheHome()
  if (!existsSync(root)) return console.log(`\n  nothing cached at ${root}\n`)
  const repos = readdirSync(root).length
  rmSync(root, { recursive: true, force: true })
  console.log(`\n  removed ${root} (${repos} repo(s))\n`)
}

/**
 * Read a review.json, checking it is one before the viewer is handed it.
 *
 * `--open` takes a path from a person, and the failure modes are a stale file
 * from an older format and a path typed one directory off. Both used to end in
 * a stack trace from somewhere inside a render, which says nothing about
 * either.
 */
function readReview(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${path} does not look like a slice review`)
  }
  if (parsed.version !== REVIEW_VERSION) {
    fail(
      `${path} is review format ${parsed.version ?? 'unknown'}, and this build of slice reads ${REVIEW_VERSION} — re-run the review to regenerate it`,
    )
  }
  const missing = REVIEW_REQUIRED_KEYS.filter((key) => !(key in parsed))
  if (missing.length > 0) fail(`${path} is missing ${missing.join(', ')} — it does not look like a slice review`)

  return parsed
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.clearCache) return clearCache()

  // Only the modes that read git need a repo. `--open` was documented as
  // touching neither git nor gh and then refused to run outside a checkout,
  // and `--init-config user` writes to your home directory either way.
  const repoRoot = tryRun('git', ['rev-parse', '--show-toplevel'])
  const cwd = repoRoot ?? process.cwd()

  if (options.initConfig) {
    if (options.initConfig === 'repo' && !repoRoot) {
      fail('not inside a git repository — run this from a repo, or use `slice --init-config user`')
    }
    return initConfig(options.initConfig, cwd)
  }

  let loaded
  try {
    loaded = loadConfig({ cwd, explicit: options.config })
  } catch (error) {
    fail(error.message)
  }
  const { sources, warnings: configWarnings } = loaded
  for (const warning of configWarnings) console.error(`  ${warning}`)

  const config = options.prompt
    ? mergePatch(loaded.config, {
        review: { instructions: [loaded.config.review.instructions, options.prompt].filter(Boolean).join('\n\n') },
      })
    : loaded.config

  if (options.printConfig) return printConfig({ config, sources })

  if (options.open) {
    if (!existsSync(options.open)) fail(`no such review file: ${options.open}`)
    return runViewer({
      review: readReview(options.open),
      reviewPath: options.open,
      repoRoot: cwd,
      config,
      warnings: configWarnings,
    })
  }

  if (!repoRoot) fail('not inside a git repository')

  const asBranch = () => resolveBranchTarget(repoRoot, options.base, options.branch ? options.ref : null)
  const target = options.branch
    ? asBranch()
    : (resolvePrTarget(repoRoot, options.ref) ?? resolveBranchTarget(repoRoot, options.base, options.ref))

  if (!target) {
    const why = ghDiagnosis(repoRoot)
    const named = options.ref ? `"${options.ref}"` : 'that branch'
    fail(
      /^\d+$/.test(options.ref ?? '')
        ? `could not find PR #${options.ref}${why ? ` — ${why}` : ''}`
        : `no pull request and no branch named ${named}${why ? ` — ${why}` : ''}`,
    )
  }

  if (!options.branch && target.kind === 'branch') {
    const why = ghDiagnosis(repoRoot)
    if (why) console.error(`  no PR found: ${why}\n  falling back to a branch diff.`)
    else if (options.ref) console.error(`  no open PR for "${options.ref}" — diffing the branch instead.`)
  }

  const label = target.kind === 'pr' ? `PR #${target.number}` : `branch ${target.headRef} vs ${target.baseRef}`
  console.log(`\n  ${target.title}\n  ${label}\n`)

  const patch = capturePatch(repoRoot, target)
  const files = orderByCommit(splitPatch(patch), commitOrder(repoRoot, target))
  if (files.length === 0) fail('no file changes found in the diff')
  console.log(`  ${files.length} changed file(s)`)

  const slug = (target.repo || repoRoot.split('/').pop()).replace(/[^a-zA-Z0-9]+/g, '-')
  const id = target.kind === 'pr' ? `pr-${target.number}` : `branch-${target.headRef.replace(/[^a-zA-Z0-9]+/g, '-')}`
  const cacheDir = join(cacheHome(), slug)
  mkdirSync(cacheDir, { recursive: true })

  const tag = options.prompt ? `-${createHash('sha256').update(options.prompt).digest('hex').slice(0, 8)}` : ''

  const patchPath = join(cacheDir, `${id}.patch`)
  const filesPath = join(cacheDir, `${id}.files.json`)
  const analysisPath = join(cacheDir, `${id}${tag}.analysis.json`)
  const rawPath = join(cacheDir, `${id}${tag}.analysis.raw.txt`)
  const reviewPath = join(cacheDir, `${id}${tag}.review.json`)

  writeFileSync(patchPath, patch)
  writeFileSync(
    filesPath,
    JSON.stringify(
      files.map(({ path, prevPath, status, additions, deletions }) => ({
        path,
        prevPath,
        status,
        additions,
        deletions,
      })),
      null,
      2,
    ),
  )

  let analysis = null
  // Set only when analysis is running against a live viewer: it resolves to
  // { review, warnings } once the provider replies, or null if it failed.
  let analysisPromise = null

  if (!options.analyze) {
    console.log('  no AI analysis (pass --ai for slices, summaries, and findings)')
  } else if (existsSync(analysisPath) && !options.refresh) {
    console.log('  using cached analysis (--refresh to redo)')
    try {
      analysis = JSON.parse(readFileSync(analysisPath, 'utf8'))
    } catch (error) {
      console.error(`  could not parse the cached analysis: ${error.message}`)
    }
  } else {
    if (existsSync(rawPath) && !options.refresh) {
      analysis = extractJson(readFileSync(rawPath, 'utf8'))
      if (analysis?.slices) console.log('  recovered the previous run’s reply from cache')
      else analysis = null
    }

    if (!analysis) {
      // Resolved here rather than at startup: a provider that slice does not
      // have only matters once something is actually going to be run, and a
      // config typo should not stop you reading a diff.
      let provider
      try {
        provider = resolveProvider(config.review.provider)
      } catch (error) {
        fail(error.message)
      }

      if (!tryRun(provider.command, provider.versionArgs)) {
        fail(`${provider.name} is not installed — see ${provider.docsUrl}, or drop --ai to just read the diff`)
      }

      const conventionFiles = conventionSources(repoRoot, config.review.conventionFiles)
      if (conventionFiles.length > 0) {
        console.log(`  judging against ${conventionFiles.join(', ')}`)
      }
      if (sources.length > 0) console.log(`  configured by ${sources.join(', ')}`)
      if (options.prompt) {
        const line = options.prompt.replace(/\s+/g, ' ')
        console.log(`  also asked: ${line.length > 68 ? `${line.slice(0, 67)}…` : line}`)
      }

      // With a real terminal on both ends, there is a viewer to open on the
      // bare diff right away rather than a spinner to stare at — so the
      // analysis runs in the background and the viewer is told to wait for
      // it instead of this function waiting here.
      const interactive = process.stdout.isTTY && process.stdin.isTTY

      const task = runAnalysis({
        repoRoot,
        target,
        patchPath,
        filesPath,
        rawPath,
        timeoutMs: options.timeout * 1000,
        conventionFiles,
        config,
        provider,
        quiet: interactive,
      })

      if (interactive) {
        // Nothing here may touch stdout or stderr: the viewer already owns the
        // terminal by the time this settles, and anything printed lands on top
        // of its alternate screen instead of the scrollback. Files are still
        // written so the result is cached and `main` can report on it once the
        // terminal is back.
        analysisPromise = task.then((result) => {
          if (!result) return null
          writeFileSync(analysisPath, JSON.stringify(result, null, 2))
          rmSync(rawPath, { force: true })
          const merged = mergeReview({ target, files, analysis: result, config })
          writeFileSync(reviewPath, JSON.stringify(merged.review, null, 2))
          return merged
        })
      } else {
        analysis = await task
      }
    }

    if (!analysisPromise) {
      if (analysis) {
        writeFileSync(analysisPath, JSON.stringify(analysis, null, 2))
        rmSync(rawPath, { force: true })
      } else {
        console.error('  opening the diff without analysis')
      }
    }
  }

  if (analysisPromise) {
    const review = bareReview({
      target,
      files,
      config,
      assessment: 'Analysis is running in the background — this pane updates when it finishes.',
    })
    writeFileSync(reviewPath, JSON.stringify(review, null, 2))
    await runViewer({ review, reviewPath, repoRoot, config, warnings: configWarnings, analysisPromise })

    // The viewer has given the terminal back by the time this line runs,
    // whether the analysis finished while it was still open or the user quit
    // first — either way, this is the first point since it kicked off that
    // printing anything is safe.
    const result = await analysisPromise
    if (!result) {
      console.error('  analysis failed; the diff stayed open without it')
    } else if (result.warnings.length > 0) {
      console.log(`\n  ${result.warnings.length} correction(s) applied to the analysis:`)
      for (const warning of result.warnings.slice(0, 8)) console.log(`    · ${warning}`)
      if (result.warnings.length > 8) console.log(`    · …and ${result.warnings.length - 8} more`)
    }
    return
  }

  const { review, warnings } = analysis
    ? mergeReview({ target, files, analysis, config })
    : { review: bareReview({ target, files, config }), warnings: [] }

  writeFileSync(reviewPath, JSON.stringify(review, null, 2))

  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} correction(s) applied to the analysis:`)
    for (const warning of warnings.slice(0, 8)) console.log(`    · ${warning}`)
    if (warnings.length > 8) console.log(`    · …and ${warnings.length - 8} more`)
  }

  const findings = review.findings.length
  const slices = review.slices.length
  console.log(`\n  ${slices} slice(s), ${findings} finding(s)\n`)

  await runViewer({ review, reviewPath, repoRoot, config, warnings: configWarnings })
}

// A stack trace is for whoever is fixing slice, not for whoever is using it.
main().catch((error) =>
  fail(process.env.SLICE_DEBUG ? (error.stack ?? error.message) : (error.message ?? String(error))),
)
