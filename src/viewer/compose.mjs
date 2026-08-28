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

/**
 * What survives from the editor buffer: everything that is not a `#` line.
 *
 * Only a `#` in the first column counts, so a comment body may talk about `C#`
 * or a markdown heading without losing the line. Exported for its own tests —
 * getting this wrong silently eats somebody's review comment.
 */
export const stripComments = (text) =>
  text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()

/**
 * Silence the parent's stdout for the duration of a callback.
 *
 * Ink does not stop rendering just because another program has the screen, and
 * the viewer is exactly as tall as the terminal — which puts Ink on its
 * clear-the-screen-and-repaint path, so any render at all while $EDITOR is up
 * blanks the editor and draws the viewer over it. The status-line timer alone
 * guarantees this: press `c` within a couple of seconds of any status message
 * and it expires while you are still typing.
 *
 * The editor inherits fd 1 directly, so muting the parent's stream stops Ink
 * without touching the editor.
 */
async function muted(run) {
  const write = process.stdout.write
  process.stdout.write = () => true
  try {
    return await run()
  } finally {
    process.stdout.write = write
  }
}

/**
 * Open $EDITOR on some seeded text and return what came back, comments
 * stripped. Returns '' if the editor was left empty — callers treat that as
 * "delete this draft", the way git treats an empty commit message as abort.
 *
 * Ink owns the terminal, so it has to be handed back whole: leave the alternate
 * screen, show the cursor Ink hid, drop raw mode, stop drawing, and only then
 * run the editor on the real tty. Ink hides the cursor exactly once and shows
 * it again only on unmount, so without the explicit restore an editor that does
 * not assert cursor visibility itself leaves you typing blind.
 */
export async function composeInEditor({ seed, hint, context = [], redraw, onEmpty = 'discard' }) {
  const dir = mkdtempSync(join(tmpdir(), 'slice-'))
  const file = join(dir, 'COMMENT_EDITMSG.md')

  // The editor takes the whole screen, so whatever you were looking at is
  // gone. Carry it in as comment lines, the way `git commit --verbose` puts
  // the diff below the message — writing a review comment with no sight of
  // the code is guesswork.
  const header = [
    hint,
    '#',
    `# Lines starting with # are ignored. Save empty to ${onEmpty === 'cancel' ? 'cancel' : 'discard'}.`,
    ...(context.length > 0 ? ['#', ...context.map((line) => `# ${line}`.trimEnd())] : []),
  ]
    .filter((line) => line != null)
    .join('\n')

  writeFileSync(file, `${seed ? `${seed}\n` : ''}\n${header}\n`)

  const command = process.env.VISUAL || process.env.EDITOR || 'vi'
  const [bin, ...args] = command.split(/\s+/)

  const wasRaw = process.stdin.isRaw
  process.stdout.write('\x1b[?1049l\x1b[?25h')
  if (wasRaw) process.stdin.setRawMode(false)
  process.stdin.pause()

  try {
    await muted(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(bin, [...args, file], { stdio: 'inherit' })
          child.on('error', reject)
          child.on('close', resolve)
        }),
    )
  } finally {
    process.stdin.resume()
    if (wasRaw) process.stdin.setRawMode(true)
    // Back to our own screen with the cursor hidden again. Ink will not do it:
    // it hides once and latches, so having shown the cursor for the editor we
    // now own putting it back.
    process.stdout.write('\x1b[?1049h\x1b[?25l')
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
