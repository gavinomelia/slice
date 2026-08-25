#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { splitPatch } from '../lib/patch.mjs'
import { bareReview, mergeReview } from '../lib/merge.mjs'
import { analysisPrompt } from '../lib/prompt.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  --port <n>        dev server port (default 5273)
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

/** Pull the analysis object out of claude's final message, tolerating a code
 *  fence or stray prose around it. */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
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
function runAnalysis({ repoRoot, target, patchPath, filesPath, timeoutMs }) {
  const prompt = analysisPrompt({
    patchPath,
    filesPath,
    target,
    hasConventions: existsSync(join(repoRoot, 'docs/CONVENTIONS.md')),
  })

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
      if (message) console.error(`  ${message}`)
      else console.log(`  analysis finished in ${Math.round((Date.now() - startedAt) / 1000)}s`)
      done(value)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null, `analysis timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)

    child.on('error', (error) => finish(null, `claude failed to start: ${error.message}`))

    child.on('close', (code) => {
      if (code !== 0) {
        return finish(null, `claude exited with code ${code}${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`)
      }

      // --output-format json wraps the reply; older shapes return it bare.
      let envelope
      try {
        envelope = JSON.parse(stdout)
      } catch {
        return finish(extractJson(stdout), null)
      }

      const payload = typeof envelope?.result === 'string' ? extractJson(envelope.result) : envelope
      if (!payload?.slices) return finish(null, 'the analysis reply was not in the expected shape')
      finish(payload, null)
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
    analysis = await runAnalysis({
      repoRoot,
      target,
      patchPath,
      filesPath,
      timeoutMs: options.timeout * 1000,
    })
    if (analysis) writeFileSync(analysisPath, JSON.stringify(analysis, null, 2))
    else console.error('  opening the diff without analysis')
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

  const url = `http://localhost:${options.port}`
  console.log(`  ${url}\n`)

  const server = spawn('npm', ['run', 'dev', '--', '--port', String(options.port)], {
    cwd: APP_DIR,
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
