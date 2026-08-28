/**
 * What you have already read.
 *
 * Reviewing a large PR is not one sitting, and the thing a viewer can do that
 * a scrollback cannot is remember where you stopped. Read state lives beside
 * the review in the cache, keyed the same way drafts are.
 *
 * It is kept per file, never per slice. A slice's paths are re-decided by every
 * analysis run, so a mark stored against a slice would land on a different set
 * of files the next time — and a "reviewed" flag that quietly changes what it
 * covers is worse than none. A slice reads as done when its files do, which is
 * derived and cannot drift.
 *
 * Marks are stored with a digest of the file's patch, because the review path
 * is stable for a PR while its diff is not: push a fix and `slice 1679` opens
 * the same cache entry with different code in it. A mark whose digest no longer
 * matches is dropped on load, so the file comes back unread rather than
 * claiming you have seen a change that did not exist yet.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

export const reviewedPathFor = (reviewPath) => reviewPath.replace(/\.review\.json$/, '.reviewed.json')

/** What a mark is against: the file's patch, so any change to it invalidates. */
const digest = (file) =>
  createHash('sha1')
    .update(file?.patch ?? '')
    .digest('hex')
    .slice(0, 12)

export function loadReviewed(reviewPath, review) {
  const path = reviewedPathFor(reviewPath)
  if (!existsSync(path)) return new Set()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return new Set()
    // A path that is no longer in the diff goes too — it is either gone from
    // the PR or renamed, and both mean it was never read in its current form.
    return new Set(Object.keys(parsed).filter((p) => review.files[p] && parsed[p] === digest(review.files[p])))
  } catch {
    // A corrupt file should not stop the review; start from nothing read.
    return new Set()
  }
}

export function saveReviewed(reviewPath, reviewed, review) {
  const path = reviewedPathFor(reviewPath)
  if (reviewed.size === 0) return rmSync(path, { force: true })
  const marks = Object.fromEntries(
    [...reviewed].filter((p) => review.files[p]).map((p) => [p, digest(review.files[p])]),
  )
  writeFileSync(path, JSON.stringify(marks, null, 2))
}

/** Slice paths the tree actually drew, matching buildTree's own filter. */
const sliceFiles = (review, sliceIndex) => (review.slices[sliceIndex]?.paths ?? []).filter((path) => review.files[path])

/**
 * The files a tree row marks. A file row is itself; a slice header is every
 * file under it, which is what makes "I have read this whole slice" one key
 * rather than one key per file.
 */
export function pathsForRow(row, review) {
  if (row?.type === 'file') return [row.path]
  if (row?.type === 'slice') return sliceFiles(review, row.sliceIndex)
  return []
}

/** A slice is read when every file under it is — and when it has files at all. */
export function sliceReviewed(review, sliceIndex, reviewed) {
  const paths = sliceFiles(review, sliceIndex)
  return paths.length > 0 && paths.every((path) => reviewed.has(path))
}

/**
 * Toggle, resolved against the whole group: a slice with one file left unread
 * marks the rest rather than clearing the ones you had already done. Unmarking
 * a whole slice therefore takes two presses, which is the right way round —
 * the destructive direction should not be the one you reach by accident.
 */
export function toggleReviewed(reviewed, paths) {
  const next = new Set(reviewed)
  const done = paths.length > 0 && paths.every((path) => next.has(path))
  for (const path of paths) {
    if (done) next.delete(path)
    else next.add(path)
  }
  return next
}

/**
 * The next file still to read, so marking is also "done, next".
 *
 * Wraps, because a file skipped early is exactly what you want handed back
 * when you reach the end. Returns -1 when nothing is left, which the caller
 * shows rather than moving to.
 */
export function nextUnreviewed(tree, from, reviewed) {
  for (let step = 1; step <= tree.length; step++) {
    const at = (from + step) % tree.length
    if (tree[at].type === 'file' && !reviewed.has(tree[at].path)) return at
  }
  return -1
}
