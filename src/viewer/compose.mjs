/**
 * Composing text in $EDITOR, and the draft comments that result.
 *
 * Drafts live beside the review in the cache, keyed the same way, so closing
 * the terminal mid-review does not lose them.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const draftsPathFor = (reviewPath) => reviewPath.replace(/\.review\.json$/, '.drafts.json')

export function loadDrafts(reviewPath) {
  const path = draftsPathFor(reviewPath)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt drafts file should not stop the review; start clean.
    return []
  }
}

export function saveDrafts(reviewPath, drafts) {
  const path = draftsPathFor(reviewPath)
  if (drafts.length === 0) return rmSync(path, { force: true })
  writeFileSync(path, JSON.stringify(drafts, null, 2))
}

const stripComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()

/**
 * Open $EDITOR on some seeded text and return what came back, comments
 * stripped. Returns '' if the editor was left empty — callers treat that as
 * "delete this draft", the way git treats an empty commit message as abort.
 *
 * Ink owns the terminal, so it has to be handed back: leave the alternate
 * screen, drop raw mode, run the editor on the real tty, then restore and tell
 * Ink to repaint from scratch — its diffing cache is stale after another
 * program has drawn over the screen.
 */
export async function composeInEditor({ seed, hint, context = [], redraw }) {
  const dir = mkdtempSync(join(tmpdir(), 'slice-'))
  const file = join(dir, 'COMMENT_EDITMSG.md')

  // The editor takes the whole screen, so whatever you were looking at is
  // gone. Carry it in as comment lines, the way `git commit --verbose` puts
  // the diff below the message — writing a review comment with no sight of
  // the code is guesswork.
  const header = [
    hint,
    '#',
    '# Lines starting with # are ignored. Save empty to discard.',
    ...(context.length > 0 ? ['#', ...context.map((line) => `# ${line}`.trimEnd())] : []),
  ]
    .filter((line) => line != null)
    .join('\n')

  writeFileSync(file, `${seed ? `${seed}\n` : ''}\n${header}\n`)

  const command = process.env.VISUAL || process.env.EDITOR || 'vi'
  const [bin, ...args] = command.split(/\s+/)

  const wasRaw = process.stdin.isRaw
  process.stdout.write('\x1b[?1049l')
  if (wasRaw) process.stdin.setRawMode(false)
  process.stdin.pause()

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bin, [...args, file], { stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', resolve)
    })
  } finally {
    process.stdin.resume()
    if (wasRaw) process.stdin.setRawMode(true)
    process.stdout.write('\x1b[?1049h')
    redraw?.()
  }

  const text = stripComments(readFileSync(file, 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  return text
}

/** The body a finding seeds a comment with, matching the browser viewer. */
export function seedFromFinding(finding) {
  if (!finding) return ''
  const parts = [`**${finding.title}**`, '', finding.why]
  if (finding.fix?.trim()) parts.push('', finding.fix.trim())
  return parts.join('\n')
}
