import { readFileSync } from 'node:fs'
import { error } from '@sveltejs/kit'
import type { Review } from '$lib/types'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = () => {
  const path = process.env.PR_REVIEW_FILE
  if (!path) {
    throw error(500, 'PR_REVIEW_FILE is not set. Start this through the `pr-review` command rather than `npm run dev`.')
  }

  let review: Review
  try {
    review = JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    throw error(500, `Could not read the review manifest at ${path}: ${(cause as Error).message}`)
  }

  return { review, repoPath: process.env.PR_REVIEW_REPO ?? null }
}
