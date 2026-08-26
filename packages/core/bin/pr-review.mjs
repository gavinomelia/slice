#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { splitPatch } from '../lib/patch.mjs'
import { bareReview, mergeReview } from '../lib/merge.mjs'
import { analysisPrompt } from '../lib/prompt.mjs'

// The viewers are sibling workspace packages, resolved through node rather
// than by walking relative paths, so moving this file cannot silently break
// the handoff to either one.
const require = createRequire(import.meta.url)
const TUI_BIN = require.resolve('@pr-review/tui')
const WEB_DIR = dirname(require.resolve('@pr-review/web/package.json'))

const USAGE = `
pr-review — slice-grouped PR review with AI analysis alongside the diff

Usage:
  pr-review [<pr-number>] [options]

  pr-review              review the PR for the current branch, or the branch diff
  pr-review 1679         review PR #1679
  pr-review --branch     review the local branch diff, ignoring any open PR

Options:
  --branch          diff the local branch against its base instead of a PR
  --base <ref>      base ref for --branch mode (default: the repo default branch)
  --refresh         re-run the analysis even if a cached one exists
  --no-analyze      skip the analysis; open the viewer with the diff only
  --web             review in the browser instead of the terminal
  --port <n>        dev server port for --web (default 5273)
  --timeout <s>     give up on the analysis after this many seconds (default 600)
  -h, --help        show this
`

function fail(message) {
  console.error(`pr-review: ${message}`)
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
    web: false,
    port: '5273',
    timeout: 600,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE.trim())
      process.exit(0)
    } else if (arg === '--branch') options.branch = true
    else if (arg === '--refresh') options.refresh = true
    else if (arg === '--no-analyze') options.analyze = false
    else if (arg === '--web') options.web = true
    else if (arg === '--base') options.base = argv[++i]
    else if (arg === '--port') options.port = argv[++i]
    else if (arg === '--timeout') options.timeout = Number(argv[++i]) || 600
    else if (/^\d+$/.test(arg)) options.number = Number(arg)
    else fail(`unknown argument "${arg}"\n${USAGE}`)
  }
  return options
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
function conventionSources(repoRoot) {
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

function runAnalysis({ repoRoot, target, patchPath, filesPath, rawPath, timeoutMs, conventionFiles }) {
  const prompt = analysisPrompt({ patchPath, filesPath, target, conventionFiles })

  // claude -p emits nothing until it finishes, so without a ticker a run that
  // legitimately takes minutes is indistinguishable from a hang.
  const startedAt = Date.now()
  const ticker = setInterval(() => {
    process.stderr.write(`\r  analyzing — reading the repo… ${Math.round((Date.now() - startedAt) / 1000)}s`)
  }, 1000)

  const child = spawn(
    'claude',
    ['-p', prompt, '--output-format', 'json', '--allowed-tools', 'Read', 'Grep', 'Glob'],
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

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    // Not worth failing the run over; the URL is printed regardless.
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  const repoRoot = tryRun('git', ['rev-parse', '--show-toplevel'])
  if (!repoRoot) fail('not inside a git repository')

  const target = options.branch
    ? resolveBranchTarget(repoRoot, options.base)
    : (resolvePrTarget(repoRoot, options.number) ?? resolveBranchTarget(repoRoot, options.base))

  if (options.number && target.kind === 'branch') fail(`could not find PR #${options.number}`)

  const label = target.kind === 'pr' ? `PR #${target.number}` : `branch ${target.headRef} vs ${target.baseRef}`
  console.log(`\n  ${target.title}\n  ${label}\n`)

  const patch = capturePatch(repoRoot, target)
  const files = splitPatch(patch)
  if (files.length === 0) fail('no file changes found in the diff')
  console.log(`  ${files.length} changed file(s)`)

  const slug = (target.repo || repoRoot.split('/').pop()).replace(/[^a-zA-Z0-9]+/g, '-')
  const id = target.kind === 'pr' ? `pr-${target.number}` : `branch-${target.headRef.replace(/[^a-zA-Z0-9]+/g, '-')}`
  const cacheDir = join(homedir(), '.cache', 'pr-review', slug)
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
      const conventionFiles = conventionSources(repoRoot)
      if (conventionFiles.length > 0) {
        console.log(`  judging against ${conventionFiles.join(', ')}`)
      }

      analysis = await runAnalysis({
        repoRoot,
        target,
        patchPath,
        filesPath,
        rawPath,
        timeoutMs: options.timeout * 1000,
        conventionFiles,
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
    ? mergeReview({ target, files, analysis })
    : { review: bareReview({ target, files }), warnings: [] }

  writeFileSync(reviewPath, JSON.stringify(review, null, 2))

  if (warnings.length > 0) {
    console.log(`\n  ${warnings.length} correction(s) applied to the analysis:`)
    for (const warning of warnings.slice(0, 8)) console.log(`    · ${warning}`)
    if (warnings.length > 8) console.log(`    · …and ${warnings.length - 8} more`)
  }

  const findings = review.findings.length
  const slices = review.slices.length
  console.log(`\n  ${slices} slice(s), ${findings} finding(s)\n`)

  // The terminal viewer is the default: it needs no server, no browser, and no
  // second window. `--web` gets the richer surface — line comments and posting
  // a review back to GitHub still only exist there.
  if (!options.web) {
    const viewer = spawn(process.execPath, [TUI_BIN, reviewPath], {
      stdio: 'inherit',
      env: { ...process.env, PR_REVIEW_REPO: repoRoot },
    })
    viewer.on('close', (code) => process.exit(code ?? 0))
    return
  }

  const url = `http://localhost:${options.port}`
  console.log(`  ${url}\n`)

  const server = spawn('npm', ['run', 'dev', '--', '--port', String(options.port)], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PR_REVIEW_FILE: reviewPath, PR_REVIEW_REPO: repoRoot },
  })

  setTimeout(() => openBrowser(url), 1800)

  const stop = () => {
    server.kill('SIGTERM')
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  server.on('close', (code) => process.exit(code ?? 0))
}

main().catch((error) => fail(error.stack ?? error.message))
