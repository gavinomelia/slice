/**
 * The viewer's pure navigation logic: what the tree contains, and which diff
 * cell the cursor is actually on.
 *
 * Split out of app.mjs because none of it needs React or a terminal, and all of
 * it is the kind of index arithmetic that goes subtly wrong — a cursor pointing
 * at the wrong half of a split row is how `c` ends up commenting on the line
 * above the one you were looking at.
 */

/**
 * Slices flattened into one selectable list. Headers are selectable too.
 *
 * `last` marks the final file of a slice so the tree can close the group with
 * a corner rather than a tee — the one cue that tells you where a slice ends
 * without counting.
 */
export function buildTree(review) {
  const rows = [{ type: 'overview' }]
  for (const [index, slice] of review.slices.entries()) {
    rows.push({ type: 'slice', sliceIndex: index })
    const paths = slice.paths.filter((path) => review.files[path])
    paths.forEach((path, at) => rows.push({ type: 'file', sliceIndex: index, path, last: at === paths.length - 1 }))
  }
  // Only a PR can receive a review, so a branch diff gets no drafts row.
  if (review.target.kind === 'pr' && review.target.number) rows.push({ type: 'drafts' })
  return rows
}

/**
 * The diff row the cursor is actually on.
 *
 * Unified rows are their own answer. A split row is a pair, and only one of its
 * two columns can be commented on at a time — so the side the user asked for
 * wins, falling back to whichever column exists. Half-empty pairs are the norm
 * (an insert has no left, a delete has no right), and a cursor pointing at
 * nothing would make `c` fail on rows that look perfectly commentable.
 */
export const cellAt = (row, side) => {
  if (!row) return null
  if (row.kind !== 'pair') return row.kind === 'hunk' ? null : row
  return (side === 'left' ? row.left : row.right) ?? row.left ?? row.right ?? null
}

/** Which column the cursor mark is drawn in, after that same fallback. */
export const sideAt = (row, side) => {
  if (row?.kind !== 'pair') return side
  return (side === 'left' ? row.left : row.right) ? side : side === 'left' ? 'right' : 'left'
}

/** Does this display row carry `line` in either column? Used to chase a finding's anchor. */
export const rowHasLine = (row, line) =>
  row.kind === 'pair' ? row.left?.line === line || row.right?.line === line : row.kind !== 'hunk' && row.line === line

/**
 * The identity of a draft comment.
 *
 * Side is part of the key because the same number means two different lines on
 * the two sides of a diff, and `file` stands in for a null line so a file-level
 * draft has somewhere to live that no line-level draft can collide with.
 */
export const draftKey = (path, side, line) => `${path}:${side}:${line ?? 'file'}`

/** Keep `index` visible inside a window of `height` rows. */
export function windowFor(index, total, height) {
  if (total <= height) return 0
  return Math.max(0, Math.min(index - Math.floor(height / 2), total - height))
}
