/**
 * Findings as a prompt for whatever is going to fix them.
 *
 * Text, not a tool call: slice does not run the fixer, pick it, or touch your
 * files. Where the text goes is your decision.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

export const fixPathFor = (reviewPath) => reviewPath.replace(/\.review\.json$/, '.fix.md')

/** Wayland before X11: a Wayland session usually still has xclip installed. */
function clipboardTools(platform = process.platform) {
  if (platform === 'darwin') return [{ bin: 'pbcopy', args: [] }]
  return [
    { bin: 'wl-copy', args: [] },
    { bin: 'xclip', args: ['-selection', 'clipboard'] },
    { bin: 'xsel', args: ['--clipboard', '--input'] },
  ]
}

/** Returns the program that took the text, or null if none are installed. */
export function copyToClipboard(text, { tools = clipboardTools() } = {}) {
  for (const { bin, args } of tools) {
    try {
      // stdout and stderr ignored rather than piped: wl-copy forks a child to
      // hold the selection, and a pipe that child inherits never closes.
      execFileSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      return bin
    } catch {
      // Missing, or refused it. The next one gets a turn.
    }
  }
  return null
}

function bySeverity(review) {
  const order = Object.keys(review.taxonomy?.severities ?? {})
  const rank = (finding) => {
    const at = order.indexOf(finding.severity)
    return at === -1 ? order.length : at
  }
  return (a, b) => rank(a) - rank(b)
}

function locate(finding) {
  if (finding.line === null) return finding.path
  // A deletion-side number belongs to the version being edited, so handing it
  // over as path:line would aim the fixer at whatever sits there now.
  if (finding.side === 'deletions') return `${finding.path} (at line ${finding.line} of the version this change edits)`
  const range = finding.endLine ? `${finding.line}-${finding.endLine}` : String(finding.line)
  return `${finding.path}:${range}`
}

function provenance(target) {
  if (target.kind === 'pr') return `PR #${target.number}${target.repo ? ` in ${target.repo}` : ''}`
  if (target.kind === 'worktree') return `uncommitted work on ${target.baseRef}`
  return `branch ${target.headRef}`
}

/** Whether the code these findings describe is the code on disk. */
function checkout(target) {
  if (target.kind === 'worktree') {
    return 'These are uncommitted changes, so the code is already in the working tree — unless you have edited it since the review.'
  }
  return `These findings were made against \`${target.headRef}\`. Check that is what you have checked out before changing anything.`
}

/**
 * The instructions matter as much as the list. A findings dump reads as a work
 * order, and an agent handed one makes eleven changes whether or not eleven
 * were warranted — so the prompt says that a suspected finding is a question,
 * that a suggested fix is a guess, and that arguing back is a fine outcome.
 */
export function fixPrompt({ review, findings }) {
  const ordered = [...findings].sort(bySeverity(review))
  const { target } = review

  const items = ordered.map((finding, index) => {
    const suspected = finding.confidence === 'suspected' ? ' (suspected)' : ''
    const lines = [
      `## ${index + 1}. ${finding.severity} · ${locate(finding)}${suspected}`,
      finding.title,
      '',
      `Why: ${finding.why.trim()}`,
    ]
    if (finding.fix?.trim()) lines.push('', `Suggested fix: ${finding.fix.trim()}`)
    return lines.join('\n')
  })

  return [
    'Fix these code review findings.',
    '',
    `${ordered.length} finding(s) from a review of ${target.title} (${provenance(target)}).`,
    checkout(target),
    '',
    'How to work through them:',
    '',
    '- Read the code at each path before changing it. The line numbers come from',
    '  the reviewed diff, so they are where to start looking rather than where the',
    '  problem necessarily is.',
    // Only when one of them is, or it invites hedging on the confirmed ones.
    ...(ordered.some((f) => f.confidence === 'suspected')
      ? [
          '- A finding marked (suspected) was not verified by the reviewer. Confirm it',
          '  first, and if it is wrong, say so instead of changing code to satisfy it.',
        ]
      : []),
    "- The suggested fix is the reviewer's guess, not a specification. If the code",
    '  says otherwise, follow the code and explain why.',
    '- Make the smallest change that fixes each finding. Do not fix anything that',
    '  is not listed here, and do not reformat code you are not otherwise changing.',
    '- Report back per finding: fixed, or not, and why.',
    '',
    '---',
    '',
    items.join('\n\n'),
    '',
  ].join('\n')
}

/**
 * Build the prompt and get it out of the viewer. Falls back to a file beside
 * the review when nothing on the machine owns the clipboard — over SSH, or on a
 * box with no wl-copy/xclip.
 */
export function handOff({ review, findings, reviewPath, tools }) {
  if (findings.length === 0) return { ok: false, count: 0 }

  const text = fixPrompt({ review, findings })
  const via = copyToClipboard(text, tools ? { tools } : {})
  if (via) return { ok: true, count: findings.length, via }

  const path = fixPathFor(reviewPath)
  writeFileSync(path, text)
  return { ok: true, count: findings.length, path }
}
