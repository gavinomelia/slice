import { DEFAULT_CONFIG, severityNames, sliceKindNames } from '../config/index.mjs'

/**
 * The shape of `review.json`, which is the contract between the pipeline and
 * the viewer — and the reason `--open` works at all. Bump it when a change
 * would make an older file render wrongly rather than merely incompletely, so
 * `--open` can refuse instead of failing somewhere deep in a render.
 */
export const REVIEW_VERSION = 1

/** The keys a file must have before the viewer will be handed it. */
export const REVIEW_REQUIRED_KEYS = ['target', 'files', 'slices', 'findings', 'overview']

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The set of line numbers on each side that actually appear in a file's hunks.
 * Context lines count: they are rendered in the diff, and GitHub accepts
 * comments on them. Used to validate where the model anchored its findings.
 */
export function annotatableLines(patch) {
  const additions = new Set()
  const deletions = new Set()
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of patch.split('\n')) {
    const header = line.match(HUNK_HEADER)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      inHunk = true
      continue
    }
    if (!inHunk) continue

    // Every real body line carries a prefix character, so an empty string is
    // the artefact of splitting on a trailing newline. Counting it as context
    // would make one line past the end of the last hunk look annotatable, and
    // GitHub answers an out-of-diff anchor by 422-ing the entire batch.
    if (line === '') continue

    if (line.startsWith('+')) {
      additions.add(newLine++)
    } else if (line.startsWith('-')) {
      deletions.add(oldLine++)
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the previous line.
      continue
    } else {
      additions.add(newLine++)
      deletions.add(oldLine++)
    }
  }
  return { additions, deletions }
}

function slugify(value, fallback) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || fallback
}

/**
 * Combine the deterministic patch data with the model's analysis into the
 * manifest the viewer consumes. Every value the model produced is validated
 * against the patch: bad paths are dropped, bad line anchors are demoted to
 * file level rather than discarded, and unsliced files get their own bucket.
 * Returns the review plus a list of what had to be corrected.
 */
export function mergeReview({ target, files, analysis, config = DEFAULT_CONFIG }) {
  const warnings = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const lineIndex = new Map(files.map((f) => [f.path, annotatableLines(f.patch)]))

  // Both taxonomies are ordered, and their fallbacks lean on that: an
  // unrecognised severity becomes the least serious one, an unrecognised slice
  // kind becomes ordinary behavior. Both are the safe direction to be wrong in
  // — they under-claim rather than over-claim.
  const severities = severityNames(config)
  const kinds = sliceKindNames(config)
  const fallbackSeverity = severities.at(-1) ?? 'question'
  const fallbackKind = kinds[0] ?? 'behavior'

  const rawSlices = Array.isArray(analysis?.slices) ? analysis.slices : []
  const claimed = new Set()
  const usedIds = new Set()
  const slices = []

  for (const [index, slice] of rawSlices.entries()) {
    const paths = []
    for (const path of Array.isArray(slice?.paths) ? slice.paths : []) {
      if (!byPath.has(path)) {
        warnings.push(`slice "${slice?.title ?? index}" referenced unknown path ${path}`)
        continue
      }
      if (claimed.has(path)) {
        warnings.push(`${path} appeared in more than one slice; kept the first`)
        continue
      }
      claimed.add(path)
      paths.push(path)
    }
    if (paths.length === 0) continue

    let id = slugify(slice?.id ?? slice?.title, `slice-${index + 1}`)
    while (usedIds.has(id)) id = `${id}-${index + 1}`
    usedIds.add(id)

    slices.push({
      id,
      title: String(slice?.title ?? `Slice ${index + 1}`),
      kind: kinds.includes(slice?.kind) ? slice.kind : fallbackKind,
      summary: String(slice?.summary ?? ''),
      paths,
    })
  }

  const orphans = files.filter((f) => !claimed.has(f.path)).map((f) => f.path)
  if (orphans.length > 0) {
    warnings.push(`${orphans.length} file(s) were not placed in any slice`)
    slices.push({
      id: 'unsliced',
      title: 'Unsliced',
      kind: kinds.includes('unaccounted') ? 'unaccounted' : fallbackKind,
      summary:
        'These files were not assigned to a slice by the analysis. They still need review — an unsliced file is often one nothing else explains.',
      paths: orphans,
    })
  }

  const notes = {}
  for (const note of Array.isArray(analysis?.notes) ? analysis.notes : []) {
    if (note?.path && byPath.has(note.path)) notes[note.path] = String(note.summary ?? '')
  }

  const knownPaths = (entry, label) =>
    (Array.isArray(entry?.paths) ? entry.paths : []).filter((path) => {
      if (byPath.has(path)) return true
      warnings.push(`${label} "${entry?.title}" referenced unknown path ${path}`)
      return false
    })

  const walkthrough = (Array.isArray(analysis?.walkthrough) ? analysis.walkthrough : [])
    .filter((step) => step?.title || step?.body)
    .map((step) => ({
      title: String(step.title ?? ''),
      body: String(step.body ?? ''),
      paths: knownPaths(step, 'walkthrough step'),
    }))

  const decisions = (Array.isArray(analysis?.decisions) ? analysis.decisions : [])
    .filter((decision) => decision?.title)
    .map((decision) => ({
      title: String(decision.title),
      why: String(decision.why ?? ''),
      paths: knownPaths(decision, 'decision'),
    }))

  const findings = []
  for (const [index, finding] of (Array.isArray(analysis?.findings) ? analysis.findings : []).entries()) {
    if (!finding?.path || !byPath.has(finding.path)) {
      warnings.push(`dropped finding "${finding?.title ?? index}" — unknown path ${finding?.path}`)
      continue
    }

    const side = finding.side === 'deletions' ? 'deletions' : 'additions'
    const valid = lineIndex.get(finding.path)[side]
    let line = Number.isInteger(finding.line) ? finding.line : null

    if (line !== null && !valid.has(line)) {
      warnings.push(
        `finding "${finding.title}" pointed at ${finding.path}:${line} (${side}), which is not in the diff — moved to file level`,
      )
      line = null
    }

    const endLine =
      Number.isInteger(finding.endLine) && line !== null && finding.endLine > line ? finding.endLine : null

    findings.push({
      id: `f${index + 1}`,
      severity: severities.includes(finding.severity) ? finding.severity : fallbackSeverity,
      confidence: finding.confidence === 'confirmed' ? 'confirmed' : 'suspected',
      path: finding.path,
      line,
      endLine,
      side,
      title: String(finding.title ?? 'Untitled finding'),
      why: String(finding.why ?? ''),
      fix: String(finding.fix ?? ''),
    })
  }

  const review = {
    version: REVIEW_VERSION,
    generatedAt: new Date().toISOString(),
    target,
    // Carried into the manifest so a viewer draws the taxonomy this review was
    // actually produced under. Reading it live from config instead would mean
    // a cached review re-opened after a config change renders severities it
    // was never allowed to emit.
    taxonomy: { severities: config.review.severities, sliceKinds: config.review.sliceKinds },
    overview: {
      intent: String(analysis?.overview?.intent ?? ''),
      assessment: String(analysis?.overview?.assessment ?? ''),
      risk: ['low', 'medium', 'high'].includes(analysis?.overview?.risk) ? analysis.overview.risk : 'medium',
    },
    walkthrough,
    decisions,
    slices,
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    notes,
    findings,
  }

  return { review, warnings }
}

/**
 * A viewer-only manifest for when analysis is skipped, still running, or
 * failed. `assessment` says which of those it is — the viewer's overview
 * pane is the one place that distinction is worth spelling out.
 */
export function bareReview({
  target,
  files,
  config = DEFAULT_CONFIG,
  assessment = 'No analysis was run for this review.',
}) {
  return {
    version: REVIEW_VERSION,
    generatedAt: new Date().toISOString(),
    target,
    taxonomy: { severities: config.review.severities, sliceKinds: config.review.sliceKinds },
    overview: { intent: '', assessment, risk: 'medium' },
    walkthrough: [],
    decisions: [],
    slices: [
      {
        id: 'all-files',
        title: 'All changed files',
        kind: sliceKindNames(config)[0] ?? 'behavior',
        summary: 'Analysis was skipped, so files are listed in diff order rather than grouped by behavior.',
        paths: files.map((f) => f.path),
      },
    ],
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    notes: {},
    findings: [],
  }
}
