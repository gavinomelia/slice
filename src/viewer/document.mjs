import { createElement as h, useEffect, useMemo, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'

import { Scrollbar } from './app.mjs'
import { codeHighlighter, resolveSyntaxTheme } from './render.mjs'
import { markdownLines, segmentsWidth, setCodeHighlighter, setMarkdownTheme, sliceSegments } from './markdown.mjs'
import { parseHex } from '../config/color.mjs'
import { queryColors } from './terminal.mjs'
import { viewerConfig } from './theme.mjs'

const MAX_WIDTH = 100
const CHROME_ROWS = 2
const H_SCROLL_STEP = 8

export const plainDocument = (text, width) =>
  markdownLines(text, width)
    .map((line) =>
      line
        .map((segment) => segment.text)
        .join('')
        .trimEnd(),
    )
    .join('\n')

const DocumentLine = ({ line, width }) =>
  h(
    Text,
    { wrap: 'truncate' },
    line.length === 0
      ? ' '
      : sliceSegments(line.segments, line.offset, width).map((segment, j) =>
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
              strikethrough: segment.strikethrough,
            },
            segment.text,
          ),
        ),
  )

function DocumentView({ path, text, ui }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const { theme } = ui

  const [size, setSize] = useState({ cols: stdout.columns || 120, rows: stdout.rows || 40 })
  useEffect(() => {
    const onResize = () => setSize({ cols: stdout.columns, rows: stdout.rows })
    stdout.on('resize', onResize)
    return () => stdout.off('resize', onResize)
  }, [stdout])

  const width = Math.max(20, Math.min(size.cols - 3, MAX_WIDTH))
  const height = Math.max(1, size.rows - CHROME_ROWS)
  const lines = useMemo(() => markdownLines(text, width), [text, width])
  const widest = useMemo(() => lines.reduce((most, line) => Math.max(most, segmentsWidth(line)), 0), [lines])

  const maxTop = Math.max(0, lines.length - height)
  const maxOffset = Math.max(0, widest - width)
  const [storedTop, setTop] = useState(0)
  const [storedOffset, setOffset] = useState(0)
  const top = Math.min(storedTop, maxTop)
  const offset = Math.min(storedOffset, maxOffset)

  const scrollTo = (next) => setTop(Math.max(0, Math.min(maxTop, next)))
  const panTo = (next) => setOffset(Math.max(0, Math.min(maxOffset, next)))

  const handleKey = (input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit()
    else if (input === 'j' || key.downArrow) scrollTo(top + 1)
    else if (input === 'k' || key.upArrow) scrollTo(top - 1)
    else if (input === ' ' || key.pageDown) scrollTo(top + height)
    else if (input === 'b' || key.pageUp) scrollTo(top - height)
    else if (input === 'd') scrollTo(top + (height >> 1))
    else if (input === 'u') scrollTo(top - (height >> 1))
    else if (input === 'g' || key.home) scrollTo(0)
    else if (input === 'G' || key.end) scrollTo(maxTop)
    else if (input === 'l' || key.rightArrow) panTo(offset + H_SCROLL_STEP)
    else if (input === 'h' || key.leftArrow) panTo(offset - H_SCROLL_STEP)
    else if (input === '0') panTo(0)
  }

  useInput((input, key) => {
    if (input.length > 1 && !key.ctrl && !key.meta && !/[^\x20-\x7e]/.test(input)) {
      for (const char of input) handleKey(char, key)
      return
    }
    handleKey(input, key)
  })

  const visible = lines.slice(top, top + height)
  const position = lines.length === 0 ? 'empty' : `${top + 1}-${top + visible.length}/${lines.length}`
  const footer = ui.warnings[0] ?? '[j/k] line  [space/b] page  [d/u] half  [g/G] ends  [h/l] sideways  [q] quit'

  return h(
    Box,
    { flexDirection: 'column', height: size.rows, width: size.cols },
    h(
      Text,
      { wrap: 'truncate-middle' },
      h(Text, { bold: true, color: theme.ui.accent }, path),
      h(Text, { color: theme.ui.muted }, `  ${position}`),
    ),
    h(
      Box,
      { flexDirection: 'row', height },
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, paddingLeft: 1, overflow: 'hidden' },
        visible.map((line, i) =>
          h(DocumentLine, {
            key: top + i,
            line: line.length === 0 ? line : { segments: line, offset },
            width,
          }),
        ),
      ),
      h(Scrollbar, { total: lines.length, top, height, theme }),
    ),
    h(Text, { color: theme.ui.muted, wrap: 'truncate' }, footer),
  )
}

export async function runDocument({ path, text, repoRoot = process.cwd(), config = null, warnings = [] }) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.log(plainDocument(text, process.stdout.columns || 80))
    return
  }

  const answered = await queryColors()
  const background = answered.background ?? parseHex(config?.theme?.background)
  const foreground = answered.foreground ?? parseHex(config?.theme?.foreground)
  const ui = viewerConfig({ review: {}, cwd: repoRoot, config, warnings, background, foreground })
  setMarkdownTheme({ ...ui.theme.markdown, heading: ui.theme.ui.accent })
  setCodeHighlighter(await codeHighlighter(await resolveSyntaxTheme(ui.theme.syntax)))

  process.stdout.write('\x1b[?1049h')
  try {
    const instance = render(h(DocumentView, { path, text, ui }), { exitOnCtrlC: false })
    await instance.waitUntilExit()
  } finally {
    process.stdout.write('\x1b[?1049l')
  }
}
