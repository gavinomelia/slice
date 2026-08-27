#!/usr/bin/env node
/**
 * SPIKE — terminal viewer for a review.json produced by pr-review.
 *
 * Usage: pr-review-tui [<path-to-review.json>]
 *        PR_REVIEW_FILE=… pr-review-tui
 *
 * Deliberately no JSX: this runs straight off node with no build step, so the
 * layout is written with createElement. If the spike graduates, add esbuild.
 */
import { readFileSync } from 'node:fs'
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'

import { buildRows, codeHighlighter } from '../src/render.mjs'
import { indentLines, markdownLines, parseInline, plain, setCodeHighlighter, wrapSegments } from '../src/markdown.mjs'
import { composeInEditor, loadDrafts, saveDrafts, seedFromFinding } from '../src/compose.mjs'
import { partitionDrafts, postReview } from '../src/github.mjs'

const SEVERITY = {
  bug: { glyph: '●', color: 'red' },
  risk: { glyph: '◆', color: 'yellow' },
  cleanup: { glyph: '▲', color: 'cyan' },
  nit: { glyph: '▪', color: 'gray' },
  question: { glyph: '?', color: 'magenta' },
}

const RISK = { low: 'green', medium: 'yellow', high: 'red' }

/** Slices flattened into one selectable list. Headers are selectable too. */
function buildTree(review) {
  const rows = [{ type: 'overview' }]
  for (const [index, slice] of review.slices.entries()) {
    rows.push({ type: 'slice', sliceIndex: index })
    for (const path of slice.paths) {
      if (review.files[path]) rows.push({ type: 'file', sliceIndex: index, path })
    }
  }
  // Only a PR can receive a review, so a branch diff gets no drafts row.
  if (review.target.kind === 'pr' && review.target.number) rows.push({ type: 'drafts' })
  return rows
}

const countFor = (review, path) => review.findings.filter((f) => f.path === path).length

const draftKey = (path, side, line) => `${path}:${side}:${line ?? 'file'}`

/** The submit surface: what is staged, and what will happen to it. */
function draftsCard(review, drafts, width) {
  const { comments, orphans } = partitionDrafts(drafts)
  const lines = [
    ...wrapSegments(parseInline('Draft review', { bold: true }), width),
    plain(
      `${drafts.length} draft(s) · ${comments.length} as line comments${orphans.length ? ` · ${orphans.length} appended to the body` : ''}`,
      { color: 'gray' },
    ),
    [],
  ]

  if (drafts.length === 0) {
    lines.push(...markdownLines('Nothing staged yet. Press `c` on a line in a diff to write a comment.', width))
  }

  for (const draft of drafts) {
    lines.push([
      { text: '▌ ', color: 'green' },
      { text: draft.path, bold: true },
      { text: draft.line ? `:${draft.line}` : '  (no line anchor — goes in the body)', color: draft.line ? 'gray' : 'yellow' },
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

  lines.push(plain('SUBMIT', { color: 'gray', bold: true }))
  lines.push(...markdownLines('`s` comment · `A` approve · `R` request changes — each opens $EDITOR for the review body first.', width))
  return lines
}

/** The card shown in the centre pane when a slice header is selected. */
function sliceCard(review, slice, width) {
  const lines = [
    ...wrapSegments(parseInline(slice.title, { bold: true }), width),
    plain(`${slice.kind} · ${slice.paths.length} file(s)`, { color: 'gray' }),
    [],
    ...markdownLines(slice.summary, width),
    [],
    plain('FILES', { color: 'gray', bold: true }),
  ]
  for (const path of slice.paths) {
    const count = countFor(review, path)
    lines.push([
      { text: `  ${path}`, color: count ? 'yellow' : undefined },
      ...(count ? [{ text: `  (${count})`, color: 'yellow', dim: true }] : []),
    ])
  }
  return lines
}

function overviewCard(review, width) {
  const { overview, target } = review
  return [
    ...wrapSegments(parseInline(target.title, { bold: true }), width),
    plain(
      `${target.kind === 'pr' ? `#${target.number}` : target.headRef} · ${target.author} · ${target.baseRef} ← ${target.headRef}`,
      { color: 'gray' },
    ),
    [],
    plain('INTENT', { color: 'gray', bold: true }),
    ...markdownLines(overview.intent, width),
    [],
    plain('ASSESSMENT', { color: 'gray', bold: true }),
    ...markdownLines(overview.assessment, width),
    [],
    plain(`risk: ${overview.risk}`, { color: RISK[overview.risk] ?? 'gray', bold: true }),
  ]
}

/**
 * Findings as display lines, with the active one expanded in place.
 *
 * `starts` records where each finding begins so the pane can scroll the active
 * one to the top — a finding whose body runs past the pane is useless if you
 * can only ever see its first line.
 */
function findingLines(findings, active, width) {
  const lines = []
  const starts = []

  findings.forEach((finding, index) => {
    starts.push(lines.length)
    const meta = SEVERITY[finding.severity] ?? SEVERITY.nit
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
      lines.push(plain(`   ${anchor} · ${finding.severity} · ${finding.confidence}`, { color: 'gray' }))
      lines.push([])
      lines.push(...indentLines(markdownLines(finding.why, width - 6), 3))
      if (finding.fix?.trim()) {
        lines.push([], plain('   FIX', { color: 'green', bold: true }))
        lines.push(...indentLines(markdownLines(finding.fix, width - 6), 3))
      }
    } else {
      const [first] = markdownLines(finding.why, width - 6)
      if (first) lines.push([{ text: '   ' }, ...first.map((s) => ({ ...s, dim: true }))])
    }
    lines.push([])
  })

  return { lines, starts }
}

function Pane({ title, width, children }) {
  return h(
    Box,
    { flexDirection: 'column', width, flexShrink: 0, borderStyle: 'round', borderColor: 'gray', overflow: 'hidden', paddingX: 1 },
    h(Text, { bold: true, color: 'gray', wrap: 'truncate' }, title),
    children,
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

function App({ review, reviewPath, ink }) {
  const { exit } = useApp()
  const { stdout } = useStdout()

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
  const [findingIndex, setFindingIndex] = useState(0)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [drafts, setDrafts] = useState(() => loadDrafts(reviewPath))
  const [status, setStatus] = useState(null)

  const current = tree[treeIndex]
  const path = current?.type === 'file' ? current.path : null
  const slice = current?.sliceIndex != null ? review.slices[current.sliceIndex] : null

  // A file shows its own findings; a slice header shows every finding it
  // covers, so the card doubles as the slice's triage list.
  const findings = useMemo(() => {
    if (path) return review.findings.filter((f) => f.path === path)
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
    buildRows(review.files[path])
      .then((next) => {
        if (!live) return
        setRows(next)
        setScroll(0)
        // Landing here from n/p should put the cursor on the finding's line,
        // not the top of the file — otherwise you have to hunt for it.
        const at = pendingLine.current
          ? next.findIndex((r) => r.kind !== 'hunk' && r.line === pendingLine.current)
          : -1
        setCursor(at >= 0 ? at : 0)
        pendingLine.current = null
        setLoading(false)
      })
      .catch((error) => live && (setRows([{ kind: 'ctx', gutter: ' ', ansi: `error: ${error.message}` }]), setLoading(false)))
    return () => {
      live = false
    }
  }, [review, path])

  // Chrome: header 2, footer 1, pane border 2 + title 1, and one spare row.
  //
  // The spare row is load-bearing. Ink only does an in-place diff while the
  // frame fits the terminal; one row over and it falls back to clear+redraw,
  // which leaves torn text from the previous frame behind.
  const bodyHeight = Math.max(6, size.rows - 7)

  const treeWidth = Math.min(38, Math.max(24, Math.floor(size.cols * 0.22)))
  const findWidth = Math.min(58, Math.max(32, Math.floor(size.cols * 0.3)))
  const diffWidth = Math.max(20, size.cols - treeWidth - findWidth)

  const centre = useMemo(() => {
    if (current?.type === 'overview') return overviewCard(review, diffWidth - 4)
    if (current?.type === 'slice') return sliceCard(review, slice, diffWidth - 4)
    if (current?.type === 'drafts') return draftsCard(review, drafts, diffWidth - 4)
    return null
  }, [review, current, slice, drafts, diffWidth])

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
      return setStatus({ tone: 'yellow', text: 'Put the cursor on a diff line first (↑/↓).' })
    }

    const side = row.kind === 'del' ? 'deletions' : 'additions'
    const key = draftKey(path, side, row.line)
    const existing = draftAt.get(key)
    const anchored = review.findings.find((f) => f.path === path && f.line === row.line)

    const body = await composeInEditor({
      seed: existing?.body ?? seedFromFinding(anchored),
      hint: `# Comment on ${path}:${row.line}${side === 'deletions' ? ' (removed line)' : ''}`,
      redraw: () => ink.instance?.clear(),
    })

    const without = drafts.filter((d) => draftKey(d.path, d.side, d.line) !== key)
    if (!body) {
      persist(without)
      return setStatus(existing ? { tone: 'gray', text: 'Draft discarded.' } : null)
    }
    persist([...without, { path, line: row.line, side, body }])
    setStatus({ tone: 'green', text: `Draft saved on ${path}:${row.line}.` })
  }

  const submit = async (event) => {
    const { repo, number, viewerIsAuthor } = review.target
    if (review.target.kind !== 'pr' || !number) {
      return setStatus({ tone: 'yellow', text: 'This is a branch diff, not a PR — nothing to post to.' })
    }

    const body = await composeInEditor({
      seed: '',
      hint: `# ${event === 'APPROVE' ? 'Approving' : event === 'REQUEST_CHANGES' ? 'Requesting changes on' : 'Commenting on'} ${repo}#${number} with ${drafts.length} draft comment(s).`,
      redraw: () => ink.instance?.clear(),
    })

    setStatus({ tone: 'gray', text: 'Posting…' })
    const result = await postReview({
      repo,
      number,
      event,
      body,
      drafts,
      viewerIsAuthor,
      cwd: process.env.PR_REVIEW_REPO ?? process.cwd(),
    })

    if (!result.ok) return setStatus({ tone: 'red', text: result.error })

    // The drafts are on GitHub now; keeping them would re-post on the next
    // submit.
    persist([])
    const notes = [
      `Posted ${result.count} comment(s)`,
      result.downgraded ? 'downgraded to a plain comment (your own PR)' : null,
      result.orphanCount ? `${result.orphanCount} appended to the body` : null,
    ].filter(Boolean)
    setStatus({ tone: 'green', text: `${notes.join(' · ')}. ${result.url ?? ''}`.trim() })
  }

  const found = useMemo(() => findingLines(findings, active, findWidth - 4), [findings, active, findWidth])

  const selectFinding = (finding) => {
    const at = tree.findIndex((r) => r.type === 'file' && r.path === finding.path)
    pendingLine.current = finding.line ?? null
    if (at >= 0) setTreeIndex(at)
    const within = review.findings.filter((f) => f.path === finding.path).indexOf(finding)
    setFindingIndex(Math.max(0, within))
  }

  const moveTree = (delta) => setTreeIndex((i) => Math.max(0, Math.min(tree.length - 1, i + delta)))

  // On a card there is nothing to point at, so the body scrolls. On a diff the
  // cursor moves and the window follows it — commenting needs a target line.
  const scrollBody = (delta) => {
    if (centre) {
      const max = Math.max(0, centre.length - bodyHeight)
      return setScroll((s) => Math.max(0, Math.min(max, s + delta)))
    }
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + delta)))
  }

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

  // Every key means exactly one thing, everywhere. There is no focused pane
  // and no mode: j/k always walks the tree, arrows always scroll the body,
  // n/p always walks findings. Nothing on screen changes what a key does.
  function handleKey(input, key) {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) return exit()

    if (input === 'c') return void commentOnCursor().catch((e) => setStatus({ tone: 'red', text: e.message }))
    if (input === 's' || input === 'A' || input === 'R') {
      const event = input === 'A' ? 'APPROVE' : input === 'R' ? 'REQUEST_CHANGES' : 'COMMENT'
      return void submit(event).catch((e) => setStatus({ tone: 'red', text: e.message }))
    }

    if (input === 'j') return moveTree(1)
    if (input === 'k') return moveTree(-1)

    if (key.downArrow) return scrollBody(1)
    if (key.upArrow) return scrollBody(-1)
    if (key.pageDown || input === ' ') return scrollBody(bodyHeight - 2)
    if (key.pageUp || input === 'b') return scrollBody(-(bodyHeight - 2))

    // [ and ] land on the slice *header*, not its first file — the point is to
    // read what the slice is before reading its diffs.
    if (input === '[' || input === ']') {
      const here = current?.sliceIndex ?? -1
      const target = Math.max(0, Math.min(review.slices.length - 1, here + (input === ']' ? 1 : -1)))
      const at = tree.findIndex((r) => r.type === 'slice' && r.sliceIndex === target)
      if (at >= 0) setTreeIndex(at)
      return
    }

    if (input === 'n' || input === 'p') {
      const all = review.findings
      if (all.length === 0) return
      const here = all.indexOf(findings[active])
      const next = (Math.max(0, here) + (input === 'n' ? 1 : -1) + all.length) % all.length
      selectFinding(all[next])
    }
  }

  const treeTop = windowFor(treeIndex, tree.length, bodyHeight)
  const centreTop = centre
    ? Math.min(scroll, Math.max(0, centre.length - bodyHeight))
    : windowFor(cursor, rows.length, bodyHeight)

  // The active finding scrolls to the top of the pane so its whole expanded
  // body is on screen, rather than being centred and clipped at the bottom.
  const foundTop = Math.max(0, Math.min(found.starts[active] ?? 0, Math.max(0, found.lines.length - bodyHeight)))

  const centreTitle = current?.type === 'overview'
    ? 'OVERVIEW'
    : current?.type === 'drafts'
      ? `DRAFT REVIEW${drafts.length ? ` (${drafts.length})` : ''}`
      : current?.type === 'slice'
        ? `SLICE ${current.sliceIndex + 1}/${review.slices.length}`
        : `${path}${rows.length ? `  L${rows[cursor]?.line ?? '–'}  ${centreTop + 1}-${Math.min(rows.length, centreTop + bodyHeight)}/${rows.length}` : ''}`

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
        h(Text, { color: 'gray' }, `  ${review.target.kind === 'pr' ? `#${review.target.number}` : review.target.headRef} · ${review.target.author}`),
      ),
      h(
        Text,
        { color: 'gray', wrap: 'truncate' },
        `${review.slices.length} slices · ${Object.keys(review.files).length} files · ${review.findings.length} findings · risk `,
        h(Text, { color: RISK[review.overview.risk] ?? 'gray' }, review.overview.risk),
      ),
    ),

    h(
      Box,
      { flexDirection: 'row', flexGrow: 1 },

      h(
        Pane,
        { title: 'SLICES', width: treeWidth },
        ...tree.slice(treeTop, treeTop + bodyHeight).map((row, i) => {
          const index = treeTop + i
          const selected = index === treeIndex
          if (row.type === 'overview') {
            return h(Text, { key: index, bold: true, inverse: selected, color: selected ? 'cyan' : 'white', wrap: 'truncate' }, 'Overview')
          }
          if (row.type === 'drafts') {
            return h(
              Text,
              { key: index, bold: true, inverse: selected, color: selected ? 'cyan' : drafts.length ? 'green' : 'gray', wrap: 'truncate' },
              `Draft review${drafts.length ? ` (${drafts.length})` : ''}`,
            )
          }
          if (row.type === 'slice') {
            const s = review.slices[row.sliceIndex]
            return h(
              Text,
              { key: index, bold: true, inverse: selected, color: selected ? 'cyan' : s.kind === 'unaccounted' ? 'yellow' : 'white', wrap: 'truncate' },
              `${row.sliceIndex + 1} · ${s.title}`,
            )
          }
          const count = countFor(review, row.path)
          return h(
            Text,
            { key: index, inverse: selected, color: selected ? 'cyan' : undefined, wrap: 'truncate' },
            `  ${row.path.split('/').pop()}${count ? ` (${count})` : ''}`,
          )
        }),
      ),

      h(
        Pane,
        { title: centreTitle, width: diffWidth },
        centre
          ? h(Lines, { lines: centre, top: centreTop, height: bodyHeight })
          : loading
            ? h(Text, { color: 'gray' }, 'highlighting…')
            : rows.slice(centreTop, centreTop + bodyHeight).map((row, i) => {
                const index = centreTop + i
                const drafted =
                  row.line && draftAt.has(draftKey(path, row.kind === 'del' ? 'deletions' : 'additions', row.line))
                return h(
                  Text,
                  { key: index, wrap: 'truncate' },
                  h(Text, { color: drafted ? 'green' : 'cyan', bold: true }, drafted ? '▌' : index === cursor ? '▸' : ' '),
                  h(Text, { color: 'gray', inverse: index === cursor }, String(row.line ?? '').padStart(5) + ' '),
                  row.gutter,
                  row.ansi,
                )
              }),
      ),

      h(
        Pane,
        {
          title: `FINDINGS${findings.length ? ` ${Math.min(active + 1, findings.length)}/${findings.length}` : ''}`,
          width: findWidth,
        },
        findings.length === 0
          ? h(Text, { color: 'gray' }, path ? 'none for this file' : 'none')
          : h(Lines, { lines: found.lines, top: foundTop, height: bodyHeight }),
      ),
    ),

    h(
      Box,
      { paddingX: 1 },
      status
        ? h(Text, { color: status.tone, wrap: 'truncate' }, status.text)
        : h(
            Text,
            { color: 'gray', wrap: 'truncate' },
            `[j/k] file  [[/]] slice  [n/p] finding  [↑↓] line  [c] comment  [s/A/R] submit  [q] quit`,
          ),
    ),
  )
}

const file = process.argv[2] ?? process.env.PR_REVIEW_FILE
if (!file) {
  console.error('pr-review-tui: pass a review.json path or set PR_REVIEW_FILE')
  process.exit(1)
}

const review = JSON.parse(readFileSync(file, 'utf8'))

// Warm Shiki before first paint: markdown renders inside a useMemo, so there
// is no opportunity to await a highlighter once the app is running.
setCodeHighlighter(await codeHighlighter())

// Alternate screen buffer, so quitting restores the shell's scrollback.
process.stdout.write('\x1b[?1049h')

// The app needs to force a full repaint after $EDITOR has drawn over the
// screen, and only the render instance can do that — which does not exist
// until render() returns. Hence the holder.
const ink = {}
ink.instance = render(h(App, { review, reviewPath: file, ink }), { exitOnCtrlC: false })
await ink.instance.waitUntilExit()
process.stdout.write('\x1b[?1049l')
