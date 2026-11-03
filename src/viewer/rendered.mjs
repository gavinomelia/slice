import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { markdownLines, sourceOf, stripFrontmatter } from './markdown.mjs'

const exec = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024
const GUTTER = 2
const sourceLines = new WeakMap()

export const canRender = (file) => Boolean(file) && /\.(md|markdown)$/i.test(file.path) && file.status !== 'deleted'

export function addedFileText(patch) {
  const lines = []
  let inHunk = false
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) lines.push(line.slice(1))
    else if (inHunk && line && !line.startsWith('\\')) return null
  }
  return inHunk ? lines.join('\n') : null
}

async function readWorktreeFile(repoRoot, path) {
  const root = resolve(repoRoot)
  const full = resolve(root, path)
  if (!full.startsWith(root + sep)) return null
  return readFile(full, 'utf8')
}

async function gitShow(repoRoot, sha, path) {
  const { stdout } = await exec('git', ['show', `${sha}:${path}`], { cwd: repoRoot, maxBuffer: MAX_BUFFER })
  return stdout
}

async function ghContents(repoRoot, repo, sha, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const { stdout } = await exec(
    'gh',
    ['api', `repos/${repo}/contents/${encoded}?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw'],
    { cwd: repoRoot, maxBuffer: MAX_BUFFER },
  )
  return stdout
}

export async function loadFileText({ file, target, repoRoot }) {
  const attempts = []
  if (target?.kind === 'worktree') attempts.push(() => readWorktreeFile(repoRoot, file.path))
  if (file.status === 'added') attempts.push(async () => addedFileText(file.patch))
  if (target?.headSha) {
    attempts.push(() => gitShow(repoRoot, target.headSha, file.path))
    if (target.repo) attempts.push(() => ghContents(repoRoot, target.repo, target.headSha, file.path))
  }

  for (const attempt of attempts) {
    try {
      const text = await attempt()
      if (text != null) return text
    } catch {
      continue
    }
  }
  return null
}

function changedLines(rows) {
  const added = new Set()
  const removedAt = new Set()
  let lastNew = null
  let pendingRemoval = false

  const settleRemoval = (line) => {
    if (pendingRemoval && line != null) removedAt.add(line)
    pendingRemoval = false
  }

  for (const row of rows) {
    if (row.kind === 'del') {
      pendingRemoval = true
    } else if (row.kind === 'hunk') {
      settleRemoval(lastNew)
    } else {
      settleRemoval(row.line)
      if (row.kind === 'add') added.add(row.line)
      lastNew = row.line
    }
  }
  settleRemoval(lastNew)

  return { added, removedAt }
}

function changeKind(source, { added, removedAt }) {
  if (!source) return null
  let kind = null
  for (let line = source[0] + 1; line <= source[1]; line++) {
    if (added.has(line)) return 'add'
    if (removedAt.has(line)) kind = 'del'
  }
  return kind
}

export function renderedLines(text, rows, width, theme) {
  const changes = changedLines(rows)
  const marks = {
    add: { text: '▌ ', color: theme.diff.addMark },
    del: { text: '▌ ', color: theme.diff.delMark },
  }
  const blank = { text: ' '.repeat(GUTTER) }

  return markdownLines(stripFrontmatter(text), width - GUTTER).map((line) => {
    if (line.length === 0) return line
    const out = [marks[changeKind(sourceOf(line), changes)] ?? blank, ...line]
    sourceLines.set(out, sourceOf(line))
    return out
  })
}

const firstLineOf = (line) => {
  const source = sourceLines.get(line)
  return source ? source[0] + 1 : null
}

export function rowForLine(lines, line) {
  let best = 0
  for (let i = 0; i < lines.length; i++) {
    const source = sourceLines.get(lines[i])
    if (!source) continue
    if (source[0] + 1 > line) break
    best = i
    if (line <= source[1]) break
  }
  return best
}

export function lineAtRow(lines, row) {
  for (let i = row; i < lines.length; i++) {
    const first = firstLineOf(lines[i])
    if (first != null) return first
  }
  return null
}
