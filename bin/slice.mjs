#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { configTargets, loadConfig } from '../src/config/index.mjs'
import { configTemplate } from '../src/config/template.mjs'

import { splitPatch } from '../src/pipeline/patch.mjs'
import { bareReview, mergeReview } from '../src/pipeline/merge.mjs'
import { analysisPrompt } from '../src/pipeline/prompt.mjs'
import { runViewer } from '../src/viewer/app.mjs'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json')

const USAGE = `
slice — read a pull request as behavioral slices, not as a pile of files

Usage:
  slice [<pr-number>] [options]

  slice              review the PR for the current branch, or the branch diff
  slice 1679         review PR #1679
  slice --branch     review the local branch diff, ignoring any open PR

Options:
  --branch          diff the local branch against its base instead of a PR
  --base <ref>      base ref for --branch mode (default: the repo default branch)
  --refresh         re-run the analysis even if a cached one exists
  --no-analyze      skip the analysis; open the viewer with the diff only
  --open <file>     open a cached review.json without touching git or the model
  --timeout <s>     give up on the analysis after this many seconds (default 600)
  -h, --help        show this
  -v, --version     print the version

Configuration:
  --config <path>       use this config file instead of the discovered ones
  --print-config        show the resolved config and where each layer came from
  --init-config [where] write a starter config — "repo" (default) or "user"

  Discovered from .slice.jsonc in the repo, then ~/.config/slice/config.jsonc.
  The repo layer says how the code is reviewed; the user layer, how it looks.

Requires the GitHub CLI (gh) and Claude Code (claude) on your PATH.
`

function fail(message) {
  console.error(`slice: ${message}`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options }).trim()
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
    number: null,
    branch: false,
    base: null,
    refresh: false,
    analyze: true,
    open: null,
    timeout: 600,
    config: null,
    printConfig: false,
    initConfig: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE.trim())
      process.exit(0)
    } else if (arg === '-v' || arg === '--version') {
      console.log(VERSION)
      process.exit(0)
    } else if (arg === '--open') options.open = argv[++i]
    else if (arg === '--config') options.config = argv[++i]
    else if (arg === '--print-config') options.printConfig = true
    else if (arg === '--init-config') {
      // The scope is optional, so only consume the next argument when it is
      // one — otherwise `--init-config 1679` would eat the PR number.
      options.initConfig = ['repo', 'user'].includes(argv[i + 1]) ? argv[++i] : 'repo'
    } else if (arg === '--branch') options.branch = true
    else if (arg === '--refresh') options.refresh = true
    else if (arg === '--no-analyze') options.analyze = false
    else if (arg === '--base') options.base = argv[++i]
    else if (arg === '--timeout') options.timeout = Number(argv[++i]) || 600
    else if (/^\d+$/.test(arg)) options.number = Number(arg)
    else fail(`unknown argument "${arg}"\n${USAGE}`)
  }
  return options
}

/**
 * Why there was no PR, in the user's terms.
 *
 * `gh pr view` failing is indistinguishable from "this branch has no PR", so
 * without this a missing or unauthenticated gh silently drops you into
 * branch-diff mode and the tool just looks broken.
 */
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

function resolvePrTarget(repoRoot, number) {
  const fields = 'number,title,author,url,baseRefName,headRefName,headRefOid'
  const args = ['pr', 'view', ...(number ? [String(number)] : []), '--json', fields]
  const raw = tryRun('gh', args, { cwd: repoRoot })
  if (!raw) return null

  const pr = JSON.parse(raw)
  const repo = tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repoRoot })
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

function resolveBranchTarget(repoRoot, base) {
  const headRef = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot })
  const baseRef = base ?? defaultBranch(repoRoot)
  return {
    kind: 'branch',
    repo: tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: repoRoot }) ?? '',
    number: null,
    title: tryRun('git', ['log', '-1', '--pretty=%s'], { cwd: repoRoot }) ?? headRef,
    author: tryRun('git', ['config', 'user.name'], { cwd: repoRoot }) ?? 'you',
    url: null,
    baseRef,
    headRef,
    headSha: run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    viewerIsAuthor: true,
  }
}

function capturePatch(repoRoot, target) {
  if (target.kind === 'pr') {
    const patch = tryRun('gh', ['pr', 'diff', String(target.number)], { cwd: repoRoot })
    if (patch === null) fail(`could not read the diff for PR #${target.number}`)
    return patch
  }
  if (!tryRun('git', ['rev-parse', '--verify', target.baseRef], { cwd: repoRoot })) {
    fail(`base ref "${target.baseRef}" does not exist locally`)
  }
  return run('git', ['diff', `${target.baseRef}...HEAD`], { cwd: repoRoot })
}

/**
 * Pull the analysis object out of claude's final message, tolerating a code
 * fence or stray prose around it.
 *
 * Scans for brace-balanced spans rather than matching a fence, because the
 * `fix` field is asked for as markdown and routinely contains its own fenced
 * code block. A fence-first regex stops at that inner fence and truncates the
 * reply mid-object.
 */
function extractJson(text) {
  const objects = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let j = i; j < text.length; j++) {
      const char = text[j]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = !inString
      else if (inString) continue
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(i, j + 1)))
        } catch {
          // Not JSON, or truncated mid-reply; keep looking.
        }
        i = j
        break
      }
    }
  }

  return objects.find((object) => object?.slices) ?? objects[0] ?? null
}

/** The usage-limit notice claude prints when there is no budget left to run. */
function limitNotice(...texts) {
  for (const text of texts) {
    const match = text?.match(/[^\n]*\b(?:hit your|usage|rate|session|weekly|quota)\b[^\n]*\blimit\b[^\n]*/i)
    if (match) return match[0].trim()
  }
  return null
}

/**
 * Run the analysis and return the parsed object, or null.
 *
 * The result comes back over stdout rather than through a file the model
 * writes: a Write outside the session's cwd needs a permission answer, and in
 * a non-interactive run there is nobody to answer it, so the process hangs
 * forever. Read-only tools plus stdout avoids the prompt entirely. The timeout
 * is a backstop so an unexpected prompt still can't wedge the CLI.
 */
/**
 * Convention sources the review should be judged against.
 *
 * `.github/instructions/*.md` is the Copilot convention and, unlike AGENTS.md
 * or CLAUDE.md, claude does not load it on its own — so it has to be named in
 * the prompt or it is silently ignored.
 */
function conventionSources(repoRoot, configured) {
  // An explicit list is taken at its word, minus anything that isn't there —
  // naming a file that does not exist would tell the model to read nothing.
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

function runAnalysis({ repoRoot, target, patchPath, filesPath, rawPath, timeoutMs, conventionFiles, config }) {
  const prompt = analysisPrompt({ patchPath, filesPath, target, repoRoot, conventionFiles, config })

  // claude -p emits nothing until it finishes, so without a ticker a run that
  // legitimately takes minutes is indistinguishable from a hang.
  const startedAt = Date.now()
  const ticker = setInterval(() => {
    process.stderr.write(`\r  analyzing — reading the repo… ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, 1000)

  const child = spawn(
    'claude',
    [
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(config.review.model ? ['--model', config.review.model] : []),
      // An empty list means "no tools", which is a bare --allowed-tools that
      // would swallow the next argument. Omit the flag instead.
      ...(config.review.allowedTools?.length ? ['--allowed-tools', ...config.review.allowedTools] : []),
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  return new Promise((done) => {
    const finish = (value, message) => {
      clearInterval(ticker)
      clearTimeout(timer)
      process.stderr.write(`\r${' '.repeat(56)}\r`)
      const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`
      if (message) console.error(`  analysis failed after ${elapsed}: ${message}`)
      else console.log(`  analysis finished in ${elapsed}`)
      done(value)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, `analysis timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)

    child.on('error', (error) => finish(null, `claude failed to start: ${error.message}`))

    child.on('close', (code) => {
      // --output-format json wraps the reply, but a run that dies early prints
      // the bare reply or nothing at all. Try every shape before giving up: a
      // usable reply is worth salvaging even from a nonzero exit, because
      // re-running it costs another slice of the usage window.
      let envelope = null
      try {
        envelope = JSON.parse(stdout)
      } catch {
        // Not the JSON envelope; the scan below still reads stdout directly.
      }
      const reply = typeof envelope?.result === 'string' ? envelope.result : stdout

      const payload = extractJson(reply) ?? extractJson(stdout)
      if (payload?.slices) return finish(payload, null)

      const limit = limitNotice(reply, stderr)

      // Keep whatever came back so a parse bug or a partial reply can be
      // recovered without paying for the run twice. A limit notice is not a
      // reply, so it is not worth caching.
      let saved = false
      if (!limit && reply.includes('{')) {
        writeFileSync(rawPath, reply)
        saved = true
      }

      const reason = limit
        ? `claude hit a usage limit — ${limit}`
        : code !== 0
          ? `claude exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}`
          : payload
            ? 'the analysis reply was JSON but had no "slices" key'
            : 'the analysis reply was not in the expected shape'

      finish(null, `${reason}${saved ? `\n  the raw reply is at ${rawPath} — the next run will retry parsing it` : ''}`)
    })
  })
}

/** `--init-config`: write a starter file, never over an existing one. */
function initConfig(scope, repoRoot) {
  const path = configTargets(repoRoot)[scope]
  if (existsSync(path)) fail(`${path} already exists — edit it, or delete it first`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, configTemplate(scope))
  console.log(`\n  wrote ${path}\n\n  Everything in it is commented out; uncomment what you want to change.\n`)
}

/** `--print-config`: the resolved result, and which files produced it. */
function printConfig({ config, sources }) {
  console.log(`\n  ${sources.length ? sources.join('\n  ') : 'no config files found — these are the built-in defaults'}\n`)
  console.log(JSON.stringify(config, null, 2))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  const repoRoot = tryRun('git', ['rev-parse', '--show-toplevel'])
  if (!repoRoot) fail('not inside a git repository')

  if (options.initConfig) return initConfig(options.initConfig, repoRoot)

  let loaded
  try {
    loaded = loadConfig({ cwd: repoRoot, explicit: options.config })
  } catch (error) {
    fail(error.message)
  }
  const { config, sources, warnings: configWarnings } = loaded
  for (const warning of configWarnings) console.error(`  ${warning}`)

  if (options.printConfig) return printConfig({ config, sources })

  // --open is the cached-review path: no git, no gh, no model. It exists
  // because re-opening a review you already paid for should not cost anything.
  if (options.open) {
    if (!existsSync(options.open)) fail(`no such review file: ${options.open}`)
    return runViewer({
      review: JSON.parse(readFileSync(options.open, 'utf8')),
      reviewPath: options.open,
      repoRoot,
    })
  }

  const target = options.branch
    ? resolveBranchTarget(repoRoot, options.base)
    : (resolvePrTarget(repoRoot, options.number) ?? resolveBranchTarget(repoRoot, options.base))

  if (options.number && target.kind === 'branch') {
    const why = ghDiagnosis(repoRoot)
    fail(why ? `could not find PR #${options.number} — ${why}` : `could not find PR #${options.number}`)
  }

  if (!options.branch && target.kind === 'branch') {
    const why = ghDiagnosis(repoRoot)
    if (why) console.error(`  no PR found: ${why}\n  falling back to a branch diff.`)
  }

  const label = target.kind === 'pr' ? `PR #${target.number}` : `branch ${target.headRef} vs ${target.baseRef}`
  console.log(`\n  ${target.title}\n  ${label}\n`)

  const patch = capturePatch(repoRoot, target)
  const files = splitPatch(patch)
  if (files.length === 0) fail('no file changes found in the diff')
  console.log(`  ${files.length} changed file(s)`)

  const slug = (target.repo || repoRoot.split('/').pop()).replace(/[^a-zA-Z0-9]+/g, '-')
  const id = target.kind === 'pr' ? `pr-${target.number}` : `branch-${target.headRef.replace(/[^a-zA-Z0-9]+/g, '-')}`
  const cacheDir = join(homedir(), '.cache', 'slice', slug)
  mkdirSync(cacheDir, { recursive: true })

  const patchPath = join(cacheDir, `${id}.patch`)
  const filesPath = join(cacheDir, `${id}.files.json`)
  const analysisPath = join(cacheDir, `${id}.analysis.json`)
  const rawPath = join(cacheDir, `${id}.analysis.raw.txt`)
  const reviewPath = join(cacheDir, `${id}.review.json`)

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
  if (!options.analyze) {
    console.log('  skipping analysis (--no-analyze)')
  } else if (existsSync(analysisPath) && !options.refresh) {
    console.log('  using cached analysis (--refresh to redo)')
    try {
      analysis = JSON.parse(readFileSync(analysisPath, 'utf8'))
    } catch (error) {
      console.error(`  could not parse the cached analysis: ${error.message}`)
    }
  } else {
    // A previous run's reply that failed to parse is retried first: it already
    // cost a slice of the usage window, so spend the parse before the tokens.
    if (existsSync(rawPath) && !options.refresh) {
      analysis = extractJson(readFileSync(rawPath, 'utf8'))
      if (analysis?.slices) console.log('  recovered the previous run’s reply from cache')
      else analysis = null
    }

    if (!analysis) {
      // Checked up front rather than left to the spawn's error event: by then
      // the patch is already written and the ticker is already running, so the
      // failure reads as "the analysis broke" instead of "install this".
      if (!tryRun('claude', ['--version'])) {
        fail('Claude Code is not installed — see https://claude.com/claude-code, or pass --no-analyze')
      }

      const conventionFiles = conventionSources(repoRoot, config.review.conventionFiles)
      if (conventionFiles.length > 0) {
        console.log(`  judging against ${conventionFiles.join(', ')}`)
      }
      if (sources.length > 0) console.log(`  configured by ${sources.join(', ')}`)

      analysis = await runAnalysis({
        repoRoot,
        target,
        patchPath,
        filesPath,
        rawPath,
        timeoutMs: options.timeout * 1000,
        conventionFiles,
        config,
      })
    }

    if (analysis) {
      writeFileSync(analysisPath, JSON.stringify(analysis, null, 2))
      rmSync(rawPath, { force: true })
    } else {
      console.error('  opening the diff without analysis')
    }
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

  await runViewer({ review, reviewPath, repoRoot })
}

main().catch((error) => fail(error.stack ?? error.message))
