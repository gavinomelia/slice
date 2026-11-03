import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'

import { documentLines, mermaidSources, sourceOf } from './markdown.mjs'
import { renderDiagrams } from './mermaid.mjs'

const exec = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024
const GUTTER = 2
const GIT_TIMEOUT = 5000
const GH_TIMEOUTS = [3000, 8000]
const DIAGRAM_ONLY = /\.(mmd|mermaid)$/i
const sourceLines = new WeakMap()

export const canRender = (file) =>
  Boolean(file) && /\.(md|markdown|mmd|mermaid)$/i.test(file.path) && file.status !== 'deleted'

export const documentText = (path, text) => (DIAGRAM_ONLY.test(path) ? `\`\`\`mermaid\n${text}\n\`\`\`\n` : text)

function run(command, args, options) {
  const running = exec(command, args, { maxBuffer: MAX_BUFFER, ...options })
  running.child.stdin?.end()
  return running.then(({ stdout }) => stdout)
}

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
  return run('git', ['show', `${sha}:${path}`], { cwd: repoRoot, timeout: GIT_TIMEOUT })
}

async function ghContents(repoRoot, repo, sha, path, timeouts = GH_TIMEOUTS) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const args = ['api', `repos/${repo}/contents/${encoded}?ref=${sha}`, '-H', 'Accept: application/vnd.github.raw']
  for (const [i, timeout] of timeouts.entries()) {
    try {
      return await run('gh', args, { cwd: repoRoot, timeout })
    } catch (error) {
      if (!error.killed || i === timeouts.length - 1) throw error
    }
  }
  return null
}

export async function loadFileText({ file, target, repoRoot, ghTimeouts }) {
  const attempts = []
  if (target?.kind === 'worktree') attempts.push(() => readWorktreeFile(repoRoot, file.path))
  if (file.status === 'added') attempts.push(async () => addedFileText(file.patch))
  if (target?.headSha) {
    attempts.push(() => gitShow(repoRoot, target.headSha, file.path))
    if (target.repo) attempts.push(() => ghContents(repoRoot, target.repo, target.headSha, file.path, ghTimeouts))
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

const documents = new Map()

export function loadDocument({ file, target, repoRoot }) {
  const key = [target?.headSha, file.path, file.patch].join('\0')
  if (documents.has(key)) return documents.get(key)

  const loading = (async () => {
    const raw = await loadFileText({ file, target, repoRoot })
    if (raw == null) {
      documents.delete(key)
      return { value: null, diagrams: new Map() }
    }
    const value = documentText(file.path, raw)
    return { value, diagrams: await renderDiagrams(mermaidSources(value)) }
  })()
  documents.set(key, loading)
  return loading
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

function removalRows(lines, removedAt) {
  const sourced = lines.filter((line) => sourceOf(line))
  const rows = new Set()
  for (const removed of removedAt) {
    const next = sourced.find((line) => removed <= sourceOf(line)[1]) ?? sourced.at(-1)
    if (next) rows.add(next)
  }
  return rows
}

function isAdded(source, added) {
  if (!source) return false
  for (let line = source[0] + 1; line <= source[1]; line++) if (added.has(line)) return true
  return false
}

export function renderedLines(text, rows, width, theme, diagrams) {
  const changes = changedLines(rows)
  const marks = {
    add: { text: '▌ ', color: theme.diff.addMark },
    del: { text: '▌ ', color: theme.diff.delMark },
  }
  const blank = { text: ' '.repeat(GUTTER) }

  const lines = documentLines(text, width - GUTTER, diagrams)
  const removed = removalRows(lines, changes.removedAt)

  return lines.map((line) => {
    if (line.length === 0) return line
    const kind = isAdded(sourceOf(line), changes.added) ? 'add' : removed.has(line) ? 'del' : null
    const out = [marks[kind] ?? blank, ...line]
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
