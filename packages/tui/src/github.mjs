/**
 * Posting a review back to GitHub.
 *
 * `gh pr review` cannot attach line comments, so this goes through the reviews
 * API with every comment in one request.
 */
import { spawn } from 'node:child_process'

/** gh reads the payload from stdin, so the child is driven directly. */
function ghWithStdin(args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(Object.assign(new Error(stderr || `gh exited with ${code}`), { stderr }))
    })

    child.stdin.end(input)
  })
}

/**
 * Split drafts into what GitHub will accept as line comments and what it will
 * not.
 *
 * GitHub rejects a comment on any line outside the diff and 422s the *whole
 * batch* without naming the offender, so a draft with no usable anchor is
 * folded into the review body rather than risking every other comment.
 */
export function partitionDrafts(drafts) {
  const comments = []
  const orphans = []

  for (const draft of drafts) {
    if (!draft.body?.trim()) continue
    if (draft.line) {
      comments.push({
        path: draft.path,
        line: draft.line,
        side: draft.side === 'deletions' ? 'LEFT' : 'RIGHT',
        body: draft.body.trim(),
      })
    } else {
      orphans.push(draft)
    }
  }

  return { comments, orphans }
}

export function buildPayload({ event, body, drafts, viewerIsAuthor }) {
  const { comments, orphans } = partitionDrafts(drafts)

  // GitHub refuses APPROVE and REQUEST_CHANGES on your own PR, so downgrade
  // rather than letting the whole post fail.
  const resolved = viewerIsAuthor && event !== 'COMMENT' ? 'COMMENT' : event

  const sections = [body?.trim()].filter(Boolean)
  for (const orphan of orphans) {
    sections.push(`**\`${orphan.path}\`**\n\n${orphan.body.trim()}`)
  }

  return {
    payload: { body: sections.join('\n\n---\n\n'), event: resolved, comments },
    downgraded: resolved !== event,
    orphanCount: orphans.length,
  }
}

export async function postReview({ repo, number, event, body, drafts, viewerIsAuthor, cwd }) {
  const { payload, downgraded, orphanCount } = buildPayload({ event, body, drafts, viewerIsAuthor })

  if (!payload.body && payload.comments.length === 0) {
    return { ok: false, error: 'Nothing to post — no draft comments and no review body.' }
  }

  try {
    const stdout = await ghWithStdin(
      ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'],
      JSON.stringify(payload),
      cwd,
    )
    const created = JSON.parse(stdout)
    return { ok: true, url: created.html_url ?? null, downgraded, orphanCount, count: payload.comments.length }
  } catch (cause) {
    const stderr = cause.stderr ?? cause.message ?? String(cause)
    const hint = stderr.includes('422')
      ? ' — GitHub rejected the batch, most likely a comment anchored to a line that is not part of the diff.'
      : ''
    return { ok: false, error: `${stderr.trim().split('\n').slice(0, 2).join(' ')}${hint}` }
  }
}
