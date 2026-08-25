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
export function mergeReview({ target, files, analysis }) {
  const warnings = []
  const byPath = new Map(files.map((f) => [f.path, f]))
  const lineIndex = new Map(files.map((f) => [f.path, annotatableLines(f.patch)]))

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
      kind: ['behavior', 'skim', 'unaccounted'].includes(slice?.kind) ? slice.kind : 'behavior',
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
      kind: 'unaccounted',
      summary:
        'These files were not assigned to a slice by the analysis. They still need review — an unsliced file is often one nothing else explains.',
      paths: orphans,
    })
  }

  const notes = {}
  for (const note of Array.isArray(analysis?.notes) ? analysis.notes : []) {
    if (note?.path && byPath.has(note.path)) notes[note.path] = String(note.summary ?? '')
  }

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

    const endLine = Number.isInteger(finding.endLine) && line !== null && finding.endLine > line ? finding.endLine : null

    findings.push({
      id: `f${index + 1}`,
      severity: ['bug', 'risk', 'cleanup', 'nit', 'question'].includes(finding.severity) ? finding.severity : 'question',
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
    version: 1,
    generatedAt: new Date().toISOString(),
    target,
    overview: {
      intent: String(analysis?.overview?.intent ?? ''),
      assessment: String(analysis?.overview?.assessment ?? ''),
      risk: ['low', 'medium', 'high'].includes(analysis?.overview?.risk) ? analysis.overview.risk : 'medium',
    },
    slices,
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    notes,
    findings,
  }

  return { review, warnings }
}

/** A viewer-only manifest for when analysis is skipped or failed. */
export function bareReview({ target, files }) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    target,
    overview: { intent: '', assessment: 'No analysis was run for this review.', risk: 'medium' },
    slices: [
      {
        id: 'all-files',
        title: 'All changed files',
        kind: 'behavior',
        summary: 'Analysis was skipped, so files are listed in diff order rather than grouped by behavior.',
        paths: files.map((f) => f.path),
      },
    ],
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    notes: {},
    findings: [],
  }
}
