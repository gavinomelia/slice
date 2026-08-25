import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { json } from '@sveltejs/kit'
import type { Review } from '$lib/types'
import type { RequestHandler } from './$types'

/** gh reads the review payload from stdin, which execFile's promisified form
 *  cannot supply, so the child is driven directly. */
function ghWithStdin(args: string[], input: string, cwd: string): Promise<string> {
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

interface PostBody {
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'
  body: string
  comments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
  bodyOnly: { path: string; body: string }[]
}

export const POST: RequestHandler = async ({ request }) => {
  const manifestPath = process.env.PR_REVIEW_FILE
  if (!manifestPath) return json({ error: 'PR_REVIEW_FILE is not set.' }, { status: 500 })

  // The target comes from the manifest, never from the request, so a stray
  // page can't aim a review at a different repo.
  const review: Review = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { repo, number, viewerIsAuthor } = review.target
  if (review.target.kind !== 'pr' || !number) {
    return json({ error: 'This review is a local branch diff, not a PR.' }, { status: 400 })
  }
  if (!repo) return json({ error: 'No GitHub repository is associated with this review.' }, { status: 400 })

  const payload = (await request.json()) as PostBody

  let event = payload.event
  if (viewerIsAuthor && event !== 'COMMENT') event = 'COMMENT'

  const sections = [payload.body?.trim()].filter(Boolean)
  for (const orphan of payload.bodyOnly ?? []) {
    sections.push(`**\`${orphan.path}\`**\n\n${orphan.body}`)
  }

  const body = {
    body: sections.join('\n\n---\n\n'),
    event,
    comments: (payload.comments ?? []).map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    })),
  }

  if (!body.body && body.comments.length === 0) {
    return json({ error: 'Nothing to post.' }, { status: 400 })
  }

  try {
    const stdout = await ghWithStdin(
      ['api', '--method', 'POST', `repos/${repo}/pulls/${number}/reviews`, '--input', '-'],
      JSON.stringify(body),
      process.env.PR_REVIEW_REPO ?? process.cwd(),
    )
    const created = JSON.parse(stdout)
    return json({ url: created.html_url ?? review.target.url })
  } catch (cause) {
    // A 422 here almost always means a comment landed on a line outside the
    // diff, and gh does not say which one.
    const stderr = (cause as { stderr?: string }).stderr ?? (cause as Error).message
    const hint = stderr.includes('422')
      ? ' — GitHub rejected the batch, most likely a comment anchored to a line that is not part of the diff.'
      : ''
    return json({ error: `${stderr.trim().split('\n').slice(0, 3).join(' ')}${hint}` }, { status: 502 })
  }
}
