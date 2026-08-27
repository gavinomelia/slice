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

import { buildRows, codeHighlighter, resolveSyntaxTheme } from './render.mjs'
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
import { viewerConfig } from './theme.mjs'

const PANES = ['tree', 'diff', 'findings']

/**
 * Slices flattened into one selectable list. Headers are selectable too.
 *
 * `last` marks the final file of a slice so the tree can close the group with
 * a corner rather than a tee — the one cue that tells you where a slice ends
 * without counting.
 */
function buildTree(review) {
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

const findingsFor = (review, path) => review.findings.filter((f) => f.path === path)

const draftKey = (path, side, line) => `${path}:${side}:${line ?? 'file'}`

/** A row of severity glyphs, so a count reads as "what kind" not just "how many". */
function severityGlyphs(findings, ui, limit = 4) {
  const shown = findings.slice(0, limit)
  const segments = shown.map((finding) => ({ text: ui.severity(finding.severity).glyph, color: ui.severity(finding.severity).color }))
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
  lines.push(...markdownLines('`s` comment · `A` approve · `R` request changes — each opens $EDITOR for the review body first.', width))
  return lines
}

/** The card shown in the centre pane when a slice header is selected. */
function sliceCard(review, slice, width, ui) {
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
  for (const path of slice.paths) {
    const findings = findingsFor(review, path)
    lines.push([
      { text: `  ${path}` },
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

/** Keep `index` visible inside a window of `height` rows. */
function windowFor(index, total, height) {
  if (total <= height) return 0
  return Math.max(0, Math.min(index - Math.floor(height / 2), total - height))
}

function App({ review, reviewPath, repoRoot, ink, ui }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { theme, layout } = ui

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
  const [status, setStatus] = useState(() =>
    ui.warnings.length ? { tone: theme.risk.medium, text: ui.warnings.join(' · ') } : null,
  )
  const [focus, setFocus] = useState('tree')
  const [findScroll, setFindScroll] = useState(0)
  const [zoomed, setZoomed] = useState(false)

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
        const at = pendingLine.current
          ? next.findIndex((r) => r.kind !== 'hunk' && r.line === pendingLine.current)
          : -1
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
  const diffWidth = zoomed ? size.cols : Math.max(20, size.cols - treeWidth - findWidth)

  // Border 2 + paddingX 2 + the scrollbar column.
  const inner = (width) => Math.max(8, width - 5)

  const centre = useMemo(() => {
    if (current?.type === 'overview') return overviewCard(review, inner(diffWidth), ui)
    if (current?.type === 'slice') return sliceCard(review, slice, inner(diffWidth), ui)
    if (current?.type === 'drafts') return draftsCard(review, drafts, inner(diffWidth), ui)
    return null
  }, [review, current, slice, drafts, diffWidth, ui])

  const draftAt = useMemo(() => {
    const index = new Map()
    for (const draft of drafts) index.set(draftKey(draft.path, draft.side, draft.line), draft)
    return index
  }, [drafts])

  const persist = (next) => {
    setDrafts(next)
    saveDrafts(reviewPath, next)
  }

  /** Write or edit the draft on the cursor's line; an empty body deletes it. */
  const commentOnCursor = async () => {
    const row = rows[cursor]
    if (!path || !row || row.kind === 'hunk' || !row.line) {
      return setStatus({ tone: theme.risk.medium, text: 'Put the cursor on a diff line first (↑/↓).' })
    }

    const side = row.kind === 'del' ? 'deletions' : 'additions'
    const key = draftKey(path, side, row.line)
    const existing = draftAt.get(key)
    const anchored = review.findings.find((f) => f.path === path && f.line === row.line)

    // A window of the diff around the target, marked so the line being
    // commented on is unmistakable once the TUI is off screen.
    const from = Math.max(0, cursor - 8)
    const context = [
      `─── ${path} ───`,
      ...rows.slice(from, cursor + 9).map((r, i) => {
        const at = from + i
        if (r.kind === 'hunk') return `        ${r.text ?? '@@'}`
        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' '
        return `${at === cursor ? '  >' : '   '} ${String(r.line ?? '').padStart(5)} ${sign} ${r.text ?? ''}`
      }),
    ]

    const body = await composeInEditor({
      seed: existing?.body ?? seedFromFinding(anchored),
      hint: `# Comment on ${path}:${row.line}${side === 'deletions' ? ' (a removed line)' : ''}`,
      context,
      redraw: () => ink.instance?.clear(),
    })

    const without = drafts.filter((d) => draftKey(d.path, d.side, d.line) !== key)
    if (!body) {
      persist(without)
      return setStatus(existing ? { tone: theme.ui.muted, text: 'Draft discarded.' } : null)
    }
    persist([...without, { path, line: row.line, side, body }])
    setStatus({ tone: theme.ui.draft, text: `Draft saved on ${path}:${row.line}.` })
  }

  const submit = async (event) => {
    const { repo, number, viewerIsAuthor } = review.target
    if (review.target.kind !== 'pr' || !number) {
      return setStatus({ tone: theme.risk.medium, text: 'This is a branch diff, not a PR — nothing to post to.' })
    }

    const verb = event === 'APPROVE' ? 'Approving' : event === 'REQUEST_CHANGES' ? 'Requesting changes on' : 'Commenting on'
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
      redraw: () => ink.instance?.clear(),
    })

    setStatus({ tone: theme.ui.muted, text: 'Posting…' })
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
    setStatus({ tone: theme.ui.draft, text: `${notes.join(' · ')}. ${result.url ?? ''}`.trim() })
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
      return setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + delta)))
    }

    const max = Math.max(0, foundLength.current - bodyHeight)
    setFindScroll((s) => Math.max(0, Math.min(max, s + delta)))
  }

  // The widest line in the file, so sideways scrolling stops at the end of the
  // content instead of running off into empty space.
  const widest = useMemo(() => rows.reduce((max, row) => Math.max(max, row.text?.length ?? 0), 0), [rows])
  const codeWidth = Math.max(8, inner(diffWidth) - 8)
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
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) return exit()

    if (input === 'c') return void commentOnCursor().catch((e) => setStatus({ tone: theme.risk.high, text: e.message }))
    if (input === 's' || input === 'A' || input === 'R') {
      const event = input === 'A' ? 'APPROVE' : input === 'R' ? 'REQUEST_CHANGES' : 'COMMENT'
      return void submit(event).catch((e) => setStatus({ tone: theme.risk.high, text: e.message }))
    }

    // Asking for a hidden pane means you want it back, so a number key unzooms
    // rather than doing nothing.
    if (input === '1') return setZoomed(false), setFocus('tree')
    if (input === '2') return setFocus('diff')
    if (input === '3') return setZoomed(false), setFocus('findings')
    if (input === 'z') {
      const next = !zoomed
      setZoomed(next)
      if (next) setFocus('diff')
      return
    }
    if (key.tab) {
      if (zoomed) return setFocus('diff')
      return setFocus(PANES[(PANES.indexOf(focus) + (key.shift ? 2 : 1)) % 3])
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
      if (at >= 0) setTreeIndex(at), setZoomed(false), setFocus('tree')
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
    : windowFor(cursor, rows.length, bodyHeight)

  const foundTop = Math.max(0, Math.min(findScroll, Math.max(0, found.lines.length - bodyHeight)))

  const centreTitle = current?.type === 'overview'
    ? 'OVERVIEW'
    : current?.type === 'drafts'
      ? `DRAFT REVIEW${drafts.length ? ` (${drafts.length})` : ''}`
      : current?.type === 'slice'
        ? `SLICE ${current.sliceIndex + 1}/${review.slices.length}`
        : [
            path,
            rows.length ? `L${rows[cursor]?.line ?? '–'}` : '',
            rows.length ? `${centreTop + 1}-${Math.min(rows.length, centreTop + bodyHeight)}/${rows.length}` : '',
            hOffset > 0 ? `→${hOffset}` : '',
            zoomed ? 'zoom' : '',
          ]
            .filter(Boolean)
            .join('  ')

  /** One diff row: cursor mark, line number, gutter, then the visible window of code. */
  const diffRow = (row, index) => {
    const drafted = row.line && draftAt.has(draftKey(path, row.kind === 'del' ? 'deletions' : 'additions', row.line))
    const selected = index === cursor

    if (row.kind === 'hunk') {
      // A rule rather than a bare @@ — it is a seam in the file, and reads as
      // one only if it spans the pane.
      const label = ` ${row.text} `
      return h(
        Text,
        { key: index, wrap: 'truncate', color: theme.diff.hunk, dimColor: true },
        `  ${label}${'─'.repeat(Math.max(0, inner(diffWidth) - label.length - 3))}`,
      )
    }

    const lineBg = row.kind === 'add' ? theme.diff.addBg : row.kind === 'del' ? theme.diff.delBg : theme.diff.contextBg
    const wordBg = row.kind === 'add' ? theme.diff.addWordBg : theme.diff.delWordBg
    const mark = row.kind === 'add' ? theme.diff.addMark : row.kind === 'del' ? theme.diff.delMark : undefined

    const clipped = segmentsWidth(row.segments) > hOffset + codeWidth
    const visible = sliceSegments(row.segments, hOffset, clipped ? codeWidth - 1 : codeWidth).map((segment) => ({
      ...segment,
      bg: segment.word ? wordBg : lineBg,
    }))
    const code = padSegments(clipped ? [...visible, { text: '›', color: theme.ui.muted, bg: lineBg }] : visible, codeWidth, {
      bg: lineBg,
    })

    return h(
      Text,
      { key: index, wrap: 'truncate' },
      h(Text, { color: drafted ? theme.ui.draft : theme.ui.cursor, bold: true }, drafted ? '▌' : selected ? '▸' : ' '),
      h(
        Text,
        { color: theme.diff.lineNumber, backgroundColor: lineBg, inverse: selected, dimColor: !selected },
        String(row.line ?? '').padStart(5) + ' ',
      ),
      h(Text, { color: mark, backgroundColor: lineBg }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
      ...code.map((segment, j) =>
        h(Text, { key: j, color: segment.color, backgroundColor: segment.bg }, segment.text),
      ),
    )
  }

  const counts = useMemo(() => {
    const tally = new Map()
    for (const finding of review.findings) tally.set(finding.severity, (tally.get(finding.severity) ?? 0) + 1)
    return [...tally.entries()]
  }, [review])

  const KEYS = {
    tree: '[j/k] move  [[/]] slice  [tab] pane  [n/p] finding  [q] quit',
    diff: '[j/k] line  [h/l] scroll  [0] reset  [z] zoom  [c] comment  [s/A/R] submit',
    findings: '[j/k] scroll  [n/p] finding  [c] comment  [tab] pane  [q] quit',
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
                return h(
                  Text,
                  { ...base, bold: true, color: selected ? theme.ui.accent : (ui.sliceKind(s.kind).color ?? undefined) },
                  `${row.sliceIndex + 1} · ${s.title}`,
                )
              }

              const fileFindings = findingsFor(review, row.path)
              return h(
                Text,
                base,
                h(Text, { color: theme.ui.border, dimColor: true }, row.last ? ' └ ' : ' ├ '),
                h(Text, { color: selected ? theme.ui.accent : undefined }, row.path.split('/').pop()),
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
          total: centre ? centre.length : rows.length,
          top: centreTop,
          height: bodyHeight,
        },
        centre
          ? h(Lines, { lines: centre, top: centreTop, height: bodyHeight })
          : loading
            ? h(Text, { color: theme.ui.muted }, 'highlighting…')
            : rows.slice(centreTop, centreTop + bodyHeight).map((row, i) => diffRow(row, centreTop + i)),
      ),

      zoomed
        ? null
        : h(
            Pane,
            {
              title: `FINDINGS${findings.length ? ` ${Math.min(active + 1, findings.length)}/${findings.length}` : ''}`,
              number: 3,
              focused: focus === 'findings',
              width: findWidth,
              theme,
              total: found.lines.length,
              top: foundTop,
              height: bodyHeight,
            },
            findings.length === 0
              ? h(Text, { color: theme.ui.muted }, path ? 'none for this file' : 'none')
              : h(Lines, { lines: found.lines, top: foundTop, height: bodyHeight }),
          ),
    ),

    h(
      Box,
      { paddingX: 1 },
      status
        ? h(Text, { color: status.tone, wrap: 'truncate' }, status.text)
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
export async function runViewer({ review, reviewPath, repoRoot = process.cwd() }) {
  const ui = viewerConfig({ review, cwd: repoRoot })
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
    ink.instance = render(h(App, { review, reviewPath, repoRoot, ink, ui }), { exitOnCtrlC: false })
    await ink.instance.waitUntilExit()
  } finally {
    // Leaving the alternate screen has to happen even if the render threw, or
    // the shell is left drawing over a frozen copy of the UI.
    process.stdout.write('\x1b[?1049l')
  }
}
