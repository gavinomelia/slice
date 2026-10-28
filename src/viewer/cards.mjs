import { partitionDrafts } from './github.mjs'
import { indentLines, markdownLines, parseInline, plain, wrapSegments } from './markdown.mjs'

export const findingsFor = (review, path) => review.findings.filter((f) => f.path === path)

/** A row of severity glyphs, so a count reads as "what kind" not just "how many". */
export function severityGlyphs(findings, ui, limit = 4) {
  const shown = findings.slice(0, limit)
  const segments = shown.map((finding) => ({
    text: ui.severity(finding.severity).glyph,
    color: ui.severity(finding.severity).color,
  }))
  if (findings.length > shown.length) segments.push({ text: '+', color: ui.theme.ui.muted })
  return segments
}

/** The submit surface: what is staged, and what will happen to it. */
export function draftsCard(review, drafts, width, ui) {
  const { comments, orphans } = partitionDrafts(drafts)
  const lines = [
    ...wrapSegments(parseInline('Draft review', { bold: true }), width),
    plain(
      `${drafts.length} draft(s) · ${comments.length} as line comments${orphans.length ? ` · ${orphans.length} appended to the body` : ''}`,
      { color: ui.theme.ui.muted },
    ),
    [],
  ]

  if (drafts.length === 0) {
    lines.push(...markdownLines('Nothing staged yet. Press `c` on a line in a diff to write a comment.', width))
  }

  for (const draft of drafts) {
    lines.push([
      { text: '▌ ', color: ui.theme.ui.draft },
      { text: draft.path, bold: true },
      {
        text: draft.line ? `:${draft.line}` : '  (no line anchor — goes in the body)',
        color: draft.line ? ui.theme.ui.muted : ui.theme.risk.medium,
      },
    ])
    lines.push(...indentLines(markdownLines(draft.body, width - 4), 2))
    lines.push([])
  }

  if (review.target.viewerIsAuthor) {
    lines.push(
      ...markdownLines(
        'GitHub rejects **approve** and **request changes** on your own PR, so both post as plain comments here.',
        width,
      ),
      [],
    )
  }

  lines.push(plain('SUBMIT', { color: ui.theme.ui.heading, bold: true }))
  lines.push(
    ...markdownLines(
      '`s` comment · `A` approve · `R` request changes — each opens $EDITOR for the review body first. Save it empty to cancel.',
      width,
    ),
  )
  return lines
}

/** The card shown in the centre pane when a slice header is selected. */
export function sliceCard(review, slice, reviewed, width, ui) {
  const kind = ui.sliceKind(slice.kind)
  const lines = [
    ...wrapSegments(parseInline(slice.title, { bold: true }), width),
    [
      { text: slice.kind, color: kind.color ?? ui.theme.ui.muted },
      { text: ` · ${slice.paths.length} file(s)`, color: ui.theme.ui.muted },
    ],
    [],
    ...markdownLines(slice.summary, width),
    [],
    plain('FILES', { color: ui.theme.ui.heading, bold: true }),
  ]
  // The slice's triage list, so read state belongs here too — this is the one
  // place that shows full paths, and what is left to do in a slice is exactly
  // what you came to the card for.
  for (const path of slice.paths) {
    const findings = findingsFor(review, path)
    const status = ui.fileStatus(review.files[path]?.status)
    lines.push([
      { text: reviewed.has(path) ? '✓ ' : '  ', color: ui.theme.ui.reviewed },
      { text: `${status.glyph} `, color: status.color },
      { text: path, dim: reviewed.has(path) },
      ...(findings.length ? [{ text: '  ' }, ...severityGlyphs(findings, ui)] : []),
    ])
  }
  return lines
}

export function overviewCard(review, width, ui) {
  const { overview, target } = review
  return [
    ...wrapSegments(parseInline(target.title, { bold: true }), width),
    plain(
      `${target.kind === 'pr' ? `#${target.number}` : target.headRef} · ${target.author} · ${target.baseRef} ← ${target.headRef}`,
      { color: ui.theme.ui.muted },
    ),
    [],
    plain('INTENT', { color: ui.theme.ui.heading, bold: true }),
    ...markdownLines(overview.intent, width),
    [],
    plain('ASSESSMENT', { color: ui.theme.ui.heading, bold: true }),
    ...markdownLines(overview.assessment, width),
    [],
    plain(`risk: ${overview.risk}`, { color: ui.theme.risk[overview.risk] ?? ui.theme.ui.muted, bold: true }),
    ...walkthroughLines(review.walkthrough ?? [], width, ui),
    ...decisionLines(review.decisions ?? [], width, ui),
  ]
}

function pathLines(paths, width, ui) {
  return paths.flatMap((path) => wrapSegments([{ text: path, color: ui.theme.ui.muted }], width))
}

function walkthroughLines(steps, width, ui) {
  if (steps.length === 0) return []
  const lines = [[], plain('WALKTHROUGH', { color: ui.theme.ui.heading, bold: true })]
  steps.forEach((step, index) => {
    const number = `${index + 1}. `
    lines.push(
      [],
      ...wrapSegments(parseInline(step.title, { bold: true }), width - number.length).map((line, i) => [
        { text: i === 0 ? number : ' '.repeat(number.length), color: ui.theme.ui.accent, bold: true },
        ...line,
      ]),
      ...indentLines(markdownLines(step.body, width - number.length), number.length),
      ...indentLines(pathLines(step.paths, width - number.length, ui), number.length),
    )
  })
  return lines
}

function decisionLines(decisions, width, ui) {
  if (decisions.length === 0) return []
  const lines = [[], plain('DECISIONS', { color: ui.theme.ui.heading, bold: true })]
  for (const decision of decisions) {
    lines.push(
      [],
      ...wrapSegments(parseInline(decision.title, { bold: true }), width - 2).map((line, i) => [
        { text: i === 0 ? '◇ ' : '  ', color: ui.theme.ui.accent },
        ...line,
      ]),
      ...indentLines(markdownLines(decision.why, width - 2), 2),
      ...indentLines(pathLines(decision.paths, width - 2, ui), 2),
    )
  }
  return lines
}

/**
 * Findings as display lines, with the active one expanded in place.
 *
 * `starts` records where each finding begins so the pane can scroll the active
 * one to the top — a finding whose body runs past the pane is useless if you
 * can only ever see its first line.
 */
export function findingLines(findings, active, width, ui) {
  const lines = []
  const starts = []

  findings.forEach((finding, index) => {
    starts.push(lines.length)
    const meta = ui.severity(finding.severity)
    const isActive = index === active

    const head = wrapSegments(parseInline(finding.title, { bold: isActive, dim: !isActive }), width - 3)
    head.forEach((line, i) =>
      lines.push([
        { text: `${i === 0 ? `${isActive ? '▸' : ' '}${meta.glyph}` : '  '} `, color: meta.color, dim: !isActive },
        ...line,
      ]),
    )

    if (isActive) {
      const anchor = finding.line
        ? `L${finding.line}${finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : ''}`
        : 'file'
      // An expanded finding runs long, so it gets a rule down its left edge —
      // without it there is no telling where the body stops and the next
      // collapsed finding starts.
      const rule = (line) => [{ text: ' ▏ ', color: meta.color, dim: true }, ...line]

      lines.push([
        { text: ' ▏ ', color: meta.color, dim: true },
        { text: `${anchor} · ${finding.severity} · ${finding.confidence}`, color: ui.theme.ui.muted },
      ])
      lines.push(rule([]))
      lines.push(...markdownLines(finding.why, width - 6).map(rule))
      if (finding.fix?.trim()) {
        lines.push(rule([]), rule([{ text: 'FIX', color: ui.theme.ui.draft, bold: true }]))
        lines.push(...markdownLines(finding.fix, width - 6).map(rule))
      }
    } else {
      const [first] = markdownLines(finding.why, width - 6)
      if (first) lines.push([{ text: '   ' }, ...first.map((s) => ({ ...s, dim: true }))])
    }
    lines.push([])
  })

  return { lines, starts }
}
