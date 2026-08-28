/**
 * Terminal viewer for a review.json.
 *
 * Deliberately no JSX: this runs straight off node with no build step, so the
 * layout is written with createElement.
 *
 * Nothing here hardcodes a colour or a glyph. Appearance comes from the config
 * file and the taxonomy from the review manifest, both resolved once at
 * startup in theme.mjs.
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'

import { buildRows, codeHighlighter, resolveSyntaxTheme, splitRows } from './render.mjs'
import {
  indentLines,
  markdownLines,
  padSegments,
  parseInline,
  plain,
  segmentsWidth,
  setCodeHighlighter,
  setMarkdownTheme,
  sliceSegments,
  wrapSegments,
} from './markdown.mjs'
import { composeInEditor, loadDrafts, saveDrafts, seedFromFinding } from './compose.mjs'
import { partitionDrafts, postReview } from './github.mjs'
import { buildTree, cellAt, draftKey, rowHasLine, sideAt, windowFor } from './tree.mjs'
import { loadReviewed, nextUnreviewed, pathsForRow, saveReviewed, sliceReviewed, toggleReviewed } from './progress.mjs'
import { viewerConfig } from './theme.mjs'

const PANES = ['tree', 'diff', 'findings']

const findingsFor = (review, path) => review.findings.filter((f) => f.path === path)

/** A row of severity glyphs, so a count reads as "what kind" not just "how many". */
function severityGlyphs(findings, ui, limit = 4) {
  const shown = findings.slice(0, limit)
  const segments = shown.map((finding) => ({
    text: ui.severity(finding.severity).glyph,
    color: ui.severity(finding.severity).color,
  }))
  if (findings.length > shown.length) segments.push({ text: '+', color: ui.theme.ui.muted })
  return segments
}

/** The submit surface: what is staged, and what will happen to it. */
function draftsCard(review, drafts, width, ui) {
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
function sliceCard(review, slice, reviewed, width, ui) {
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

function overviewCard(review, width, ui) {
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
  ]
}

/**
 * Findings as display lines, with the active one expanded in place.
 *
 * `starts` records where each finding begins so the pane can scroll the active
 * one to the top — a finding whose body runs past the pane is useless if you
 * can only ever see its first line.
 */
function findingLines(findings, active, width, ui) {
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

/**
 * A one-column scrollbar down the right edge of a pane.
 *
 * Three panes all scroll independently, and without this there is nothing on
 * screen that says how much of anything you are looking at. It renders nothing
 * when the content fits, so a short pane stays clean.
 */
function Scrollbar({ total, top, height, theme }) {
  if (total <= height || height <= 0) return h(Box, { width: 1, flexShrink: 0 })

  const size = Math.max(1, Math.round((height * height) / total))
  const at = Math.round(((height - size) * top) / (total - height))

  // A quarter block against an eighth block. The two read as thumb and track
  // by weight rather than by colour, which keeps a permanent fixture in the
  // margin from competing with the diff for attention.
  return h(
    Box,
    { width: 1, flexShrink: 0, flexDirection: 'column' },
    ...Array.from({ length: height }, (_, i) =>
      i >= at && i < at + size
        ? h(Text, { key: i, color: theme.ui.scrollThumb }, '▎')
        : h(Text, { key: i, color: theme.ui.scrollTrack, dimColor: true }, '▏'),
    ),
  )
}

/**
 * The focused pane is drawn with a heavy accent border and its number in the
 * title. The mode is real, so it has to be visible — an invisible focus is
 * what makes j do three unpredictable things.
 */
function Pane({ title, number, focused, width, theme, total, top, height, children }) {
  const edge = focused ? theme.ui.borderFocus : theme.ui.border
  return h(
    Box,
    {
      flexDirection: 'column',
      width,
      flexShrink: 0,
      borderStyle: focused ? 'bold' : 'round',
      borderColor: edge,
      overflow: 'hidden',
      paddingX: 1,
    },
    // Elided in the middle, not at the end: a diff title is a long path
    // followed by the position indicators, and both ends carry more than the
    // directories in between do.
    h(
      Text,
      { bold: true, wrap: 'truncate-middle' },
      h(Text, { color: edge }, `${number} `),
      h(Text, { color: edge, dimColor: !focused }, title),
    ),
    h(
      Box,
      { flexDirection: 'row', flexGrow: 1 },
      h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' }, children),
      h(Scrollbar, { total, top, height, theme }),
    ),
  )
}

const Lines = ({ lines, top, height }) =>
  lines.slice(top, top + height).map((line, i) =>
    h(
      Text,
      { key: top + i, wrap: 'truncate' },
      line.length === 0
        ? ' '
        : line.map((segment, j) =>
            h(
              Text,
              {
                key: j,
                color: segment.color,
                backgroundColor: segment.bg,
                bold: segment.bold,
                dimColor: segment.dim,
                italic: segment.italic,
                underline: segment.underline,
              },
              segment.text,
            ),
          ),
    ),
  )

function App({ review: initialReview, reviewPath, repoRoot, ink, ui, analysisPromise }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { theme, layout } = ui

  // Seeded from the bare diff and replaced once analysisPromise resolves, so
  // the viewer is on screen before the analysis has said anything at all.
  const [review, setReview] = useState(initialReview)

  const [size, setSize] = useState({ cols: stdout.columns || 120, rows: stdout.rows || 40 })
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)
    return () => stdout.off('resize', onResize)
  }, [stdout])

  const tree = useMemo(() => buildTree(review), [review])

  const [treeIndex, setTreeIndex] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [hOffset, setHOffset] = useState(0)
  const [findingIndex, setFindingIndex] = useState(0)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState(() => loadDrafts(reviewPath))
  const [reviewed, setReviewed] = useState(() => loadReviewed(reviewPath, initialReview))
  const [status, setStatus] = useState(() =>
    // Longer than the default: this one is on screen before you are looking at
    // it, and it is the only report of what the analysis got wrong.
    ui.warnings.length ? { tone: theme.risk.medium, text: ui.warnings.join(' · '), ms: 6000 } : null,
  )
  const [focus, setFocus] = useState('tree')
  const [findScroll, setFindScroll] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const [split, setSplit] = useState(layout.diffView === 'split')
  // Which column of a split row `c` and the cursor mark mean. Additions by
  // default: the right-hand side is the code that will exist after the merge,
  // and that is what a review comment is usually about.
  const [side, setSide] = useState('right')

  /**
   * A status message sits where the shortcut line goes, so it has to give it
   * back on its own — otherwise one refused keystroke costs you the shortcuts
   * for the rest of the session, and there is no key to dismiss it.
   *
   * A caller whose message must outlive the timer says so: `ms` sets its own
   * lifetime, and `ms: null` keeps it up until something replaces it, which is
   * what an operation still in flight wants.
   */
  useEffect(() => {
    if (!status || status.ms === null) return
    const timer = setTimeout(() => setStatus(null), status.ms ?? 2500)
    return () => clearTimeout(timer)
  }, [status])

  // While analysisPromise is outstanding, a persistent counter replaces the
  // shortcut line the way a `status` message does — but a `status` is a
  // one-off with its own timer, and this has to stay up for as long as the
  // analysis is running, then hand off to a status once it says how that went.
  const [analyzing, setAnalyzing] = useState(Boolean(analysisPromise))
  const [analyzingFor, setAnalyzingFor] = useState(0)

  useEffect(() => {
    if (!analysisPromise) return
    let live = true
    const startedAt = Date.now()
    const ticker = setInterval(() => live && setAnalyzingFor(Math.round((Date.now() - startedAt) / 1000)), 1000)

    analysisPromise.then((result) => {
      clearInterval(ticker)
      if (!live) return
      setAnalyzing(false)
      if (!result) {
        setStatus({
          tone: theme.risk.medium,
          text: 'Analysis failed — still just the diff. Details print once you quit.',
          ms: 8000,
        })
        return
      }
      setReview(result.review)
      setStatus(
        result.warnings.length
          ? {
              tone: theme.risk.medium,
              text: `Analysis finished — ${result.warnings.length} correction(s) applied.`,
              ms: 6000,
            }
          : { tone: theme.ui.draft, text: 'Analysis finished.', ms: 3000 },
      )
    })

    return () => {
      live = false
      clearInterval(ticker)
    }
    // analysisPromise is created once, for the life of this run, so this
    // effect is meant to fire exactly once rather than track a changing prop.
  }, [])

  /**
   * Put the viewer back on screen after $EDITOR has had it.
   *
   * `clear()` erases and writes nothing back — it only tells Ink to forget the
   * frame it thinks is up. Something has to commit before anything is drawn
   * again, and every caller here happens to set state on the way out, so in
   * practice it repaints. Not worth depending on: the contract is that the
   * screen comes back, not that the caller remembered to change something.
   *
   * A resize is the one event Ink answers with a repaint whether or not React
   * has anything new to say, and the viewer's own handler reads the same
   * dimensions back and changes nothing.
   */
  const redraw = () => {
    ink.instance?.clear()
    stdout.emit('resize')
  }

  const current = tree[treeIndex]
  const path = current?.type === 'file' ? current.path : null
  const slice = current?.sliceIndex != null ? review.slices[current.sliceIndex] : null

  // A file shows its own findings; a slice header shows every finding it
  // covers, so the card doubles as the slice's triage list.
  const findings = useMemo(() => {
    if (path) return findingsFor(review, path)
    if (current?.type === 'slice') return review.findings.filter((f) => slice.paths.includes(f.path))
    return review.findings
  }, [review, path, current, slice])

  const active = Math.min(findingIndex, Math.max(0, findings.length - 1))

  // Rebuild the highlighted diff whenever the selected file changes. Guarded
  // against out-of-order resolution so fast j/k can't land stale rows.
  const pendingLine = useRef(null)

  // Read through a ref rather than a dependency: which view is on screen has no
  // bearing on how the diff is parsed, and listing it here would re-highlight
  // the whole file every time `v` is pressed.
  const splitRef = useRef(split)
  splitRef.current = split

  useEffect(() => {
    if (!path) return setRows([])
    let live = true
    setLoading(true)
    buildRows(review.files[path], { theme: ui.syntax, tabWidth: layout.tabWidth })
      .then((next) => {
        if (!live) return
        setRows(next)
        setScroll(0)
        setHOffset(0)
        // Landing here from n/p should put the cursor on the finding's line,
        // not the top of the file — otherwise you have to hunt for it.
        const shown = splitRef.current ? splitRows(next) : next
        const at = pendingLine.current ? shown.findIndex((r) => rowHasLine(r, pendingLine.current)) : -1
        setCursor(at >= 0 ? at : 0)
        pendingLine.current = null
        setLoading(false)
      })
      .catch(
        (error) =>
          live &&
          (setRows([{ kind: 'ctx', line: null, segments: [{ text: `error: ${error.message}` }], text: '' }]),
          setLoading(false)),
      )
    return () => {
      live = false
    }
  }, [review, path, ui.syntax, layout.tabWidth])

  // Chrome: header 2, footer 1, pane border 2 + title 1, and one spare row.
  //
  // The spare row is load-bearing. Ink only does an in-place diff while the
  // frame fits the terminal; one row over and it falls back to clear+redraw,
  // which leaves torn text from the previous frame behind.
  const bodyHeight = Math.max(6, size.rows - 7)

  // Zoom hides the side panes rather than shrinking them. A diff is the one
  // thing here with an irreducible width — wrapping it would be a lie about
  // the code, so the way to see more of it is to give it the whole terminal.
  // The configured widths are honoured outright when they fit, and scaled down
  // together when they do not. Clamping each one separately against the
  // terminal made the setting look broken — a request for a wider tree simply
  // vanished — while ignoring the terminal entirely let two fixed side panes
  // starve the diff, which is the one pane whose width is not negotiable.
  const budget = Math.floor(size.cols * 0.62)
  const wanted = layout.treeWidth + layout.findingsWidth
  const shrink = wanted > budget ? budget / wanted : 1
  const treeWidth = Math.max(16, Math.round(layout.treeWidth * shrink))
  const findWidth = Math.max(20, Math.round(layout.findingsWidth * shrink))

  // A file or slice with nothing to say gets no findings pane at all, not an
  // empty one — the diff takes the width back instead of framing silence.
  const findingsVisible = !zoomed && findings.length > 0
  const diffWidth = zoomed ? size.cols : Math.max(20, size.cols - treeWidth - (findingsVisible ? findWidth : 0))

  // Moving to a file or slice with no findings can pull the rug out from
  // under a focused findings pane — send focus somewhere still on screen.
  useEffect(() => {
    if (!findingsVisible && focus === 'findings') setFocus('diff')
  }, [findingsVisible, focus])

  // Border 2 + paddingX 2 + the scrollbar column.
  const inner = (width) => Math.max(8, width - 5)

  // Paired lazily, and off the same row objects the unified view uses, so the
  // two views cannot disagree and toggling costs no re-highlight.
  const paired = useMemo(() => splitRows(rows), [rows])
  const view = split ? paired : rows

  // A gutter is the cursor mark, a five-column line number and its space, and
  // the +/- sign: eight columns before any code. Split pays that twice, plus a
  // column for the divider between the halves.
  const halfWidth = Math.floor((inner(diffWidth) - 1) / 2)
  const codeWidth = Math.max(8, (split ? halfWidth : inner(diffWidth)) - 8)

  const centre = useMemo(() => {
    if (current?.type === 'overview') return overviewCard(review, inner(diffWidth), ui)
    if (current?.type === 'slice') return sliceCard(review, slice, reviewed, inner(diffWidth), ui)
    if (current?.type === 'drafts') return draftsCard(review, drafts, inner(diffWidth), ui)
    return null
  }, [review, current, slice, drafts, reviewed, diffWidth, ui])

  const draftAt = useMemo(() => {
    const index = new Map()
    for (const draft of drafts) index.set(draftKey(draft.path, draft.side, draft.line), draft)
    return index
  }, [drafts])

  const persist = (next) => {
    setDrafts(next)
    saveDrafts(reviewPath, next)
  }

  /**
   * Mark the selected file — or every file in the selected slice — as read,
   * and move on to the next thing that is not.
   *
   * Advancing is what makes this the "done, next" key rather than a checkbox:
   * a review becomes one repeated keystroke, and files you already marked are
   * stepped over instead of visited again. Unmarking stays put, because
   * undoing something and then being moved away from it is how you lose track
   * of what you just undid.
   */
  const toggleRead = () => {
    const paths = pathsForRow(current, review)
    if (paths.length === 0) {
      return setStatus({ tone: theme.risk.medium, text: 'Only a file or a slice can be marked read.' })
    }

    const next = toggleReviewed(reviewed, paths)
    setReviewed(next)
    saveReviewed(reviewPath, next, review)

    if (next.size < reviewed.size) {
      return setStatus({ tone: theme.ui.muted, text: `Marked unread: ${paths.length === 1 ? paths[0] : 'the slice'}.` })
    }

    const at = nextUnreviewed(tree, treeIndex, next)
    if (at >= 0) return setTreeIndex(at)
    setStatus({ tone: theme.ui.reviewed, text: 'Every file in this review is marked read.' })
  }

  /** Write or edit the draft on the cursor's line; an empty body deletes it. */
  const commentOnCursor = async () => {
    const row = cellAt(view[cursor], side)
    if (!path || !row || !row.line) {
      return setStatus({ tone: theme.risk.medium, text: 'Put the cursor on a diff line first (↑/↓).' })
    }

    // Which file GitHub anchors the comment to, which is a property of the line
    // itself and not of the column it happens to be drawn in. A context line
    // exists in both files and belongs on the addition side either way.
    const anchorSide = row.kind === 'del' ? 'deletions' : 'additions'
    const key = draftKey(path, anchorSide, row.line)
    const existing = draftAt.get(key)
    const anchored = review.findings.find((f) => f.path === path && f.line === row.line)

    // A window of the diff around the target, marked so the line being
    // commented on is unmistakable once the TUI is off screen. Always unified,
    // whichever view is on screen — two columns of code do not survive being
    // squeezed into an editor's comment lines, and the point of carrying it in
    // is to read the code, not to mirror the layout.
    const at = rows.indexOf(row)
    const from = Math.max(0, at - 8)
    const context = [
      `─── ${path} ───`,
      ...rows.slice(from, at + 9).map((r, i) => {
        if (r.kind === 'hunk') return `        ${r.text ?? '@@'}`
        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
        return `${from + i === at ? '  >' : '   '} ${String(r.line ?? '').padStart(5)} ${sign} ${r.text ?? ''}`
      }),
    ]

    const body = await composeInEditor({
      seed: existing?.body ?? seedFromFinding(anchored),
      hint: `# Comment on ${path}:${row.line}${anchorSide === 'deletions' ? ' (a removed line)' : ''}`,
      context,
      redraw,
    })

    const without = drafts.filter((d) => draftKey(d.path, d.side, d.line) !== key)
    if (!body) {
      persist(without)
      return setStatus(existing ? { tone: theme.ui.muted, text: 'Draft discarded.' } : null)
    }
    persist([...without, { path, line: row.line, side: anchorSide, body }])
    setStatus({ tone: theme.ui.draft, text: `Draft saved on ${path}:${row.line}.` })
  }

  const submit = async (event) => {
    const { repo, number, viewerIsAuthor } = review.target
    if (review.target.kind !== 'pr' || !number) {
      return setStatus({ tone: theme.risk.medium, text: 'This is a branch diff, not a PR — nothing to post to.' })
    }

    const verb =
      event === 'APPROVE' ? 'Approving' : event === 'REQUEST_CHANGES' ? 'Requesting changes on' : 'Commenting on'
    const { comments, orphans } = partitionDrafts(drafts)
    const context = [
      `─── ${drafts.length} draft comment(s) will be posted with this ───`,
      ...comments.map((c) => `  ${c.path}:${c.line}  ${c.body.split('\n')[0].slice(0, 60)}`),
      ...orphans.map((o) => `  ${o.path} (no line anchor, appended to this body)`),
      ...(viewerIsAuthor && event !== 'COMMENT'
        ? ['', '  Note: this is your own PR, so it will post as a plain comment.']
        : []),
    ]

    const body = await composeInEditor({
      seed: '',
      hint: `# ${verb} ${repo}#${number}.`,
      context,
      redraw,
      onEmpty: 'cancel',
    })

    // `s`, `A` and `R` are single unmodified keystrokes that publish to
    // somebody else's pull request, and there is no unsend. The editor is the
    // confirmation step, and an empty buffer aborts — the same bargain `git
    // commit` makes. Posting line comments with no covering note therefore
    // costs you one word, which is a fair price for not posting by accident.
    if (!body) return setStatus({ tone: theme.ui.muted, text: 'Submit cancelled — the review body was empty.' })

    // Still in flight, so it stays until the result replaces it.
    setStatus({ tone: theme.ui.muted, text: 'Posting…', ms: null })
    const result = await postReview({
      repo,
      number,
      event,
      body,
      drafts,
      viewerIsAuthor,
      cwd: repoRoot,
    })

    if (!result.ok) return setStatus({ tone: theme.risk.high, text: result.error })

    // The drafts are on GitHub now; keeping them would re-post on the next
    // submit.
    persist([])
    const notes = [
      `Posted ${result.count} comment(s)`,
      result.downgraded ? 'downgraded to a plain comment (your own PR)' : null,
      result.orphanCount ? `${result.orphanCount} appended to the body` : null,
    ].filter(Boolean)
    // Carries the URL of the posted review, which is worth long enough to read.
    setStatus({ tone: theme.ui.draft, text: `${notes.join(' · ')}. ${result.url ?? ''}`.trim(), ms: 10000 })
  }

  const found = useMemo(() => findingLines(findings, active, inner(findWidth), ui), [findings, active, findWidth, ui])

  // moveIn needs these at keypress time, after render has computed them.
  const foundLength = useRef(0)
  const foundStarts = useRef([])
  foundLength.current = found.lines.length
  foundStarts.current = found.starts

  // Picking a different finding parks the pane at that finding's first line;
  // j/k then scrolls freely from there.
  useEffect(() => {
    setFindScroll(foundStarts.current[active] ?? 0)
  }, [active, findings])

  const selectFinding = (finding) => {
    const at = tree.findIndex((r) => r.type === 'file' && r.path === finding.path)
    pendingLine.current = finding.line ?? null
    if (at >= 0) setTreeIndex(at)
    const within = findingsFor(review, finding.path).indexOf(finding)
    setFindingIndex(Math.max(0, within))
    setFocus('findings')
  }

  const moveTree = (delta) => setTreeIndex((i) => Math.max(0, Math.min(tree.length - 1, i + delta)))

  /**
   * j/k and the arrows move within whatever pane has focus.
   *
   * In the diff that means a line cursor, because commenting needs a target.
   * On a card and in the findings pane there is nothing to point at, so the
   * body scrolls instead — which is what makes a finding longer than the pane
   * readable at all.
   */
  const moveIn = (delta) => {
    if (focus === 'tree') return moveTree(delta)

    if (focus === 'diff') {
      if (centre) {
        const max = Math.max(0, centre.length - bodyHeight)
        return setScroll((s) => Math.max(0, Math.min(max, s + delta)))
      }
      return setCursor((c) => Math.max(0, Math.min(view.length - 1, c + delta)))
    }

    const max = Math.max(0, foundLength.current - bodyHeight)
    setFindScroll((s) => Math.max(0, Math.min(max, s + delta)))
  }

  /**
   * Switch views without losing your place.
   *
   * A pair holds the very row objects the unified list holds, so the line under
   * the cursor can be carried across by identity rather than by re-deriving an
   * index — which would land somewhere else entirely, since a run of five
   * changed lines is five unified rows but only three pairs.
   */
  const toggleSplit = () => {
    const anchor = cellAt(view[cursor], side)
    const next = split ? rows : paired
    const at = anchor
      ? next.findIndex((r) => (r.kind === 'pair' ? r.left === anchor || r.right === anchor : r === anchor))
      : -1
    setSplit(!split)
    setCursor(at >= 0 ? at : 0)
  }

  // The widest line in the file, so sideways scrolling stops at the end of the
  // content instead of running off into empty space.
  const widest = useMemo(() => rows.reduce((max, row) => Math.max(max, row.text?.length ?? 0), 0), [rows])
  const scrollSide = (delta) =>
    setHOffset((x) => Math.max(0, Math.min(Math.max(0, widest - codeWidth + 2), x + delta * layout.hScrollStep)))

  // Key repeat arrives coalesced — holding j delivers "jjjj" as one input, and
  // matching on the whole string would drop all but the first. Split plain
  // input into characters; escape sequences come through `key` and are passed
  // straight down.
  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !/[^\x20-\x7e]/.test(input)) {
      for (const char of input) handleKey(char, key)
      return
    }
    handleKey(input, key)
  })

  function handleKey(input, key) {
    // Escape used to quit, sharing that with `q`. It is the key people press to
    // back out of something, and here it threw away a session with unposted
    // drafts in it — so it dismisses the status line and nothing more.
    if (key.escape) return setStatus(null)
    if (input === 'q' || (key.ctrl && input === 'c')) return exit()

    if (input === 'c') return void commentOnCursor().catch((e) => setStatus({ tone: theme.risk.high, text: e.message }))
    // Bound regardless of which pane has focus: it acts on what the tree has
    // selected, which is the same thing panes 2 and 3 are already showing.
    if (input === 'x') return toggleRead()
    if (input === 's' || input === 'A' || input === 'R') {
      const event = input === 'A' ? 'APPROVE' : input === 'R' ? 'REQUEST_CHANGES' : 'COMMENT'
      return void submit(event).catch((e) => setStatus({ tone: theme.risk.high, text: e.message }))
    }

    // Asking for a hidden pane means you want it back, so a number key unzooms
    // rather than doing nothing — except pane 3, which stays inert when there
    // are no findings to show, because there is nothing to bring back.
    if (input === '1') return (setZoomed(false), setFocus('tree'))
    if (input === '2') return setFocus('diff')
    if (input === '3' && findingsVisible) return (setZoomed(false), setFocus('findings'))
    if (input === 'v') return toggleSplit()
    // Uppercase, because h/l are already the diff's sideways scroll and split
    // view needs that more than unified does — half the width means twice the
    // reaching for the end of a line.
    if (input === 'H') return setSide('left')
    if (input === 'L') return setSide('right')
    if (input === 'z') {
      const next = !zoomed
      setZoomed(next)
      if (next) setFocus('diff')
      return
    }
    if (key.tab) {
      if (zoomed) return setFocus('diff')
      const visible = findingsVisible ? PANES : ['tree', 'diff']
      const at = Math.max(0, visible.indexOf(focus))
      return setFocus(visible[(at + (key.shift ? -1 : 1) + visible.length) % visible.length])
    }

    if (input === 'j' || key.downArrow) return moveIn(1)
    if (input === 'k' || key.upArrow) return moveIn(-1)
    if (key.pageDown || input === ' ') return moveIn(bodyHeight - 2)
    if (key.pageUp || input === 'b') return moveIn(-(bodyHeight - 2))

    // Sideways only means something over a diff; a card is already wrapped to
    // the pane, so there is nothing off screen to reach.
    if (!centre) {
      if (input === 'l' || key.rightArrow) return scrollSide(1)
      if (input === 'h' || key.leftArrow) return scrollSide(-1)
      if (input === '0') return setHOffset(0)
    }

    // [ and ] land on the slice *header*, not its first file — the point is to
    // read what the slice is before reading its diffs.
    if (input === '[' || input === ']') {
      const here = current?.sliceIndex ?? -1
      const target = Math.max(0, Math.min(review.slices.length - 1, here + (input === ']' ? 1 : -1)))
      const at = tree.findIndex((r) => r.type === 'slice' && r.sliceIndex === target)
      if (at >= 0) (setTreeIndex(at), setZoomed(false), setFocus('tree'))
      return
    }

    if (input === 'n' || input === 'p') {
      const all = review.findings
      if (all.length === 0) return
      const here = all.indexOf(findings[active])
      const next = (Math.max(0, here) + (input === 'n' ? 1 : -1) + all.length) % all.length
      setZoomed(false)
      selectFinding(all[next])
    }
  }

  const treeTop = windowFor(treeIndex, tree.length, bodyHeight)
  const centreTop = centre
    ? Math.min(scroll, Math.max(0, centre.length - bodyHeight))
    : windowFor(cursor, view.length, bodyHeight)

  const foundTop = Math.max(0, Math.min(findScroll, Math.max(0, found.lines.length - bodyHeight)))

  const centreTitle =
    current?.type === 'overview'
      ? 'OVERVIEW'
      : current?.type === 'drafts'
        ? `DRAFT REVIEW${drafts.length ? ` (${drafts.length})` : ''}`
        : current?.type === 'slice'
          ? `SLICE ${current.sliceIndex + 1}/${review.slices.length}`
          : [
              path,
              view.length ? `L${cellAt(view[cursor], side)?.line ?? '–'}` : '',
              view.length ? `${centreTop + 1}-${Math.min(view.length, centreTop + bodyHeight)}/${view.length}` : '',
              hOffset > 0 ? `→${hOffset}` : '',
              split ? 'split' : '',
              zoomed ? 'zoom' : '',
              reviewed.has(path) ? 'read' : '',
            ]
              .filter(Boolean)
              .join('  ')

  /** The seam between hunks: a rule rather than a bare @@, so it spans the pane. */
  const hunkRow = (row, index) => {
    const label = ` ${row.text} `
    return h(
      Text,
      { key: index, wrap: 'truncate', color: theme.diff.hunk, dimColor: true },
      `  ${label}${'─'.repeat(Math.max(0, inner(diffWidth) - label.length - 3))}`,
    )
  }

  /**
   * One column of a diff: cursor mark, line number, sign, then the visible
   * window of code.
   *
   * `line` is passed rather than read off the row because split view numbers
   * its two columns differently — a context line has a number in the old file
   * and another in the new one, and putting the new one on the left would
   * misreport the pre-image.
   *
   * A missing row is a column's worth of blank. Half-empty pairs are ordinary
   * — that is what an insert or a delete looks like side by side — and the
   * emptiness is the information.
   */
  const diffCell = (row, { line, selected, prefix }) => {
    if (!row) return [h(Text, { key: `${prefix}gap` }, ' '.repeat(codeWidth + 8))]

    const drafted = row.line && draftAt.has(draftKey(path, row.kind === 'del' ? 'deletions' : 'additions', row.line))
    const lineBg = row.kind === 'add' ? theme.diff.addBg : row.kind === 'del' ? theme.diff.delBg : theme.diff.contextBg
    const wordBg = row.kind === 'add' ? theme.diff.addWordBg : theme.diff.delWordBg
    const mark = row.kind === 'add' ? theme.diff.addMark : row.kind === 'del' ? theme.diff.delMark : undefined

    const clipped = segmentsWidth(row.segments) > hOffset + codeWidth
    const visible = sliceSegments(row.segments, hOffset, clipped ? codeWidth - 1 : codeWidth).map((segment) => ({
      ...segment,
      bg: segment.word ? wordBg : lineBg,
    }))
    const code = padSegments(
      clipped ? [...visible, { text: '›', color: theme.ui.muted, bg: lineBg }] : visible,
      codeWidth,
      {
        bg: lineBg,
      },
    )

    return [
      h(
        Text,
        { key: `${prefix}mark`, color: drafted ? theme.ui.draft : theme.ui.cursor, bold: true },
        drafted ? '▌' : selected ? '▸' : ' ',
      ),
      h(
        Text,
        {
          key: `${prefix}no`,
          color: theme.diff.lineNumber,
          backgroundColor: lineBg,
          inverse: selected,
          dimColor: !selected,
        },
        String(line ?? '').padStart(5) + ' ',
      ),
      h(
        Text,
        { key: `${prefix}sign`, color: mark, backgroundColor: lineBg },
        row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ',
      ),
      ...code.map((segment, j) =>
        h(Text, { key: `${prefix}${j}`, color: segment.color, backgroundColor: segment.bg }, segment.text),
      ),
    ]
  }

  const diffRow = (row, index) =>
    row.kind === 'hunk'
      ? hunkRow(row, index)
      : h(
          Text,
          { key: index, wrap: 'truncate' },
          ...diffCell(row, { line: row.line, selected: index === cursor, prefix: 'u' }),
        )

  /** A pair drawn as two columns, old on the left and new on the right. */
  const splitRow = (row, index) => {
    if (row.kind === 'hunk') return hunkRow(row, index)

    const selected = index === cursor ? sideAt(row, side) : null
    // A context row is one row in both columns, so its left-hand number is the
    // one the deletion side recorded — the only place the old numbering exists.
    const leftLine = row.left?.kind === 'ctx' ? row.left.lineBefore : row.left?.line

    return h(
      Text,
      { key: index, wrap: 'truncate' },
      ...diffCell(row.left, { line: leftLine, selected: selected === 'left', prefix: 'l' }),
      h(Text, { color: theme.ui.border, dimColor: true }, '│'),
      ...diffCell(row.right, { line: row.right?.line, selected: selected === 'right', prefix: 'r' }),
    )
  }

  const counts = useMemo(() => {
    const tally = new Map()
    for (const finding of review.findings) tally.set(finding.severity, (tally.get(finding.severity) ?? 0) + 1)
    return [...tally.entries()]
  }, [review])

  // The diff line names the view `v` will switch *to*, not the one you are in —
  // which one you are looking at is already obvious, and what the key does is
  // not. Split spends its spare room teaching H/L, since two columns are the
  // only place a side to choose exists.
  const KEYS = {
    tree: '[j/k] move  [[/]] slice  [x] read  [tab] pane  [n/p] finding  [q] quit',
    diff: split
      ? '[j/k] line  [H/L] side  [h/l] scroll  [v] unified  [c] comment  [x] read  [s/A/R] submit'
      : '[j/k] line  [h/l] scroll  [v] split  [z] zoom  [c] comment  [x] read  [s/A/R] submit',
    findings: '[j/k] scroll  [n/p] finding  [c] comment  [x] read  [tab] pane  [q] quit',
  }

  return h(
    Box,
    { flexDirection: 'column', width: size.cols, height: size.rows },

    h(
      Box,
      { paddingX: 1, flexDirection: 'column' },
      h(
        Text,
        { wrap: 'truncate' },
        h(Text, { bold: true }, review.target.title),
        h(
          Text,
          { color: theme.ui.muted },
          `  ${review.target.kind === 'pr' ? `#${review.target.number}` : review.target.headRef} · ${review.target.author}`,
        ),
      ),
      h(
        Text,
        { wrap: 'truncate' },
        h(
          Text,
          { color: theme.ui.muted },
          `${review.slices.length} slices · ${Object.keys(review.files).length} files · `,
        ),
        // Only once there is progress to report. "0 read" on a review you have
        // not started is a line of chrome that says nothing.
        ...(reviewed.size > 0
          ? [
              h(Text, { key: 'read', color: theme.ui.reviewed }, `${reviewed.size} read `),
              h(Text, { key: 'readsep', color: theme.ui.muted }, '· '),
            ]
          : []),
        // The severity mix, not just a total: eight findings that are all nits
        // and eight that are all bugs are different reviews.
        ...(counts.length
          ? counts.flatMap(([severity, count], i) => [
              h(Text, { key: `g${i}`, color: ui.severity(severity).color }, `${ui.severity(severity).glyph} `),
              h(Text, { key: `c${i}`, color: theme.ui.muted }, `${count}${i === counts.length - 1 ? ' ' : '  '}`),
            ])
          : [h(Text, { key: 'none', color: theme.ui.muted }, 'no findings ')]),
        h(Text, { color: theme.ui.muted }, '· risk '),
        h(Text, { color: theme.risk[review.overview.risk] ?? theme.ui.muted }, review.overview.risk),
      ),
    ),

    h(
      Box,
      { flexDirection: 'row', flexGrow: 1 },

      zoomed
        ? null
        : h(
            Pane,
            {
              title: 'SLICES',
              number: 1,
              focused: focus === 'tree',
              width: treeWidth,
              theme,
              total: tree.length,
              top: treeTop,
              height: bodyHeight,
            },
            ...tree.slice(treeTop, treeTop + bodyHeight).map((row, i) => {
              const index = treeTop + i
              const selected = index === treeIndex
              const base = { key: index, inverse: selected, wrap: 'truncate' }

              if (row.type === 'overview') {
                return h(Text, { ...base, bold: true, color: selected ? theme.ui.accent : undefined }, 'Overview')
              }
              if (row.type === 'drafts') {
                return h(
                  Text,
                  {
                    ...base,
                    bold: true,
                    color: selected ? theme.ui.accent : drafts.length ? theme.ui.draft : theme.ui.muted,
                  },
                  `Draft review${drafts.length ? ` (${drafts.length})` : ''}`,
                )
              }
              if (row.type === 'slice') {
                const s = review.slices[row.sliceIndex]
                // The separator doubles as the slice's own read mark, so a
                // finished slice reads as done without spending a column the
                // titles need.
                const done = sliceReviewed(review, row.sliceIndex, reviewed)
                return h(
                  Text,
                  {
                    ...base,
                    bold: true,
                    color: selected ? theme.ui.accent : (ui.sliceKind(s.kind).color ?? undefined),
                  },
                  `${row.sliceIndex + 1} `,
                  h(Text, { color: done ? theme.ui.reviewed : undefined }, done ? '✓' : '·'),
                  ` ${s.title}`,
                )
              }

              const fileFindings = findingsFor(review, row.path)
              const read = reviewed.has(row.path)
              const status = ui.fileStatus(review.files[row.path]?.status)
              return h(
                Text,
                base,
                // A leading mark column, the way the diff pane carries one for
                // the cursor: a check has to sit where the eye can run down it,
                // not after a filename of unpredictable length.
                h(Text, { color: theme.ui.reviewed, bold: true }, read ? '✓' : ' '),
                h(Text, { color: theme.ui.border, dimColor: true }, row.last ? '└ ' : '├ '),
                h(Text, { color: status.color }, `${status.glyph} `),
                // Read files recede, but their findings do not — a file you
                // have already looked at can still be the one with the bug.
                h(
                  Text,
                  { color: selected ? theme.ui.accent : undefined, dimColor: read && !selected },
                  row.path.split('/').pop(),
                ),
                ...severityGlyphs(fileFindings, ui, 3).map((segment, j) =>
                  h(Text, { key: j, color: segment.color }, j === 0 ? ` ${segment.text}` : segment.text),
                ),
              )
            }),
          ),

      h(
        Pane,
        {
          title: centreTitle,
          number: 2,
          focused: focus === 'diff',
          width: diffWidth,
          theme,
          total: centre ? centre.length : view.length,
          top: centreTop,
          height: bodyHeight,
        },
        centre
          ? h(Lines, { lines: centre, top: centreTop, height: bodyHeight })
          : loading
            ? h(Text, { color: theme.ui.muted }, 'highlighting…')
            : view
                .slice(centreTop, centreTop + bodyHeight)
                .map((row, i) => (split ? splitRow(row, centreTop + i) : diffRow(row, centreTop + i))),
      ),

      !findingsVisible
        ? null
        : h(
            Pane,
            {
              title: `FINDINGS ${Math.min(active + 1, findings.length)}/${findings.length}`,
              number: 3,
              focused: focus === 'findings',
              width: findWidth,
              theme,
              total: found.lines.length,
              top: foundTop,
              height: bodyHeight,
            },
            h(Lines, { lines: found.lines, top: foundTop, height: bodyHeight }),
          ),
    ),

    h(
      Box,
      { paddingX: 1 },
      status
        ? h(Text, { color: status.tone, wrap: 'truncate' }, status.text)
        : analyzing
          ? h(Text, { color: theme.ui.muted, wrap: 'truncate' }, `analyzing in the background… ${analyzingFor}s`)
          : h(Text, { color: theme.ui.muted, wrap: 'truncate' }, KEYS[focus]),
    ),
  )
}

/**
 * Run the viewer and resolve when the user quits.
 *
 * An exported function rather than a second executable: the pipeline and the
 * viewer used to be separate packages and had to hand off over a subprocess,
 * which cost an extra node startup and a round of env-var marshalling to say
 * "here is a file path".
 */
export async function runViewer({
  review,
  reviewPath,
  repoRoot = process.cwd(),
  config = null,
  warnings = [],
  analysisPromise = null,
}) {
  // Ink needs raw mode on a real terminal. Without this guard, piping the
  // output or running under CI ends in a wall of React reconciler stack trace
  // that says nothing about what actually went wrong. The analysis is the
  // expensive part and it is already written, so this is a note, not a failure.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      [
        '',
        '  not a terminal, so there is nothing to draw on.',
        `  the review is saved at ${reviewPath}`,
        `  open it any time with:  slice --open ${reviewPath}`,
        '',
      ].join('\n'),
    )
    return
  }

  const ui = viewerConfig({ review, cwd: repoRoot, config, warnings })
  ui.syntax = await resolveSyntaxTheme(ui.theme.syntax)
  setMarkdownTheme(ui.theme.markdown)

  // Warm Shiki before first paint: markdown renders inside a useMemo, so there
  // is no opportunity to await a highlighter once the app is running.
  setCodeHighlighter(await codeHighlighter(ui.syntax))

  // Alternate screen buffer, so quitting restores the shell's scrollback.
  process.stdout.write('\x1b[?1049h')

  // The holder exists so the app can force a full repaint after $EDITOR has
  // drawn over the screen — only the render instance can do that, and it does
  // not exist until render() returns.
  const ink = {}
  try {
    ink.instance = render(h(App, { review, reviewPath, repoRoot, ink, ui, analysisPromise }), { exitOnCtrlC: false })
    await ink.instance.waitUntilExit()
  } finally {
    // Leaving the alternate screen has to happen even if the render threw, or
    // the shell is left drawing over a frozen copy of the UI.
    process.stdout.write('\x1b[?1049l')
  }
}
