/**
 * Markdown -> styled line segments, for panes that are windowed to a fixed
 * height.
 *
 * Ink can style nested <Text>, but it cannot tell us how many rows something
 * wrapped to — and every pane here scrolls, so the row count has to be known
 * before render. So wrapping happens here, on segments, and the result is a
 * line array the caller can slice.
 *
 * A line is `Segment[]`; an empty array is a blank line.
 * A segment is `{ text, color?, bg?, bold?, dim?, italic?, underline?, strikethrough? }`.
 */

import { MarkdownExit } from 'markdown-exit'

const parser = new MarkdownExit()

/**
 * Colours, replaced wholesale by the app once config is resolved.
 *
 * A module-level setting rather than a parameter because `markdownLines` is
 * called from a dozen places that have a width and a string and no business
 * knowing about themes. The built-in values keep this module renderable on its
 * own, which matters for testing it away from Ink.
 */
let colors = { code: 'cyan', codeBg: '#2c2f36', link: 'blue', fence: 'green', quote: 'gray', rule: 'gray' }
export const setMarkdownTheme = (next) => {
  colors = { ...colors, ...next }
}

/**
 * Set by the app once Shiki is warm. `(code, lang) => Segment[][] | null`, one
 * entry per line. A hook rather than an import, so this module stays pure and
 * a fenced block still renders if Shiki never loads.
 */
let highlightCode = null
export const setCodeHighlighter = (fn) => {
  highlightCode = fn
}

/** Total printable width of a line. */
export const segmentsWidth = (segments) => segments.reduce((total, segment) => total + segment.text.length, 0)

/**
 * Take the `[from, from + width)` column window of a line, keeping each
 * surviving piece's styling.
 *
 * This is what horizontal scrolling is: the pane truncates, so a line wider
 * than the pane is unreadable past the edge unless the window can move.
 */
export function sliceSegments(segments, from, width) {
  const out = []
  const until = from + width
  let at = 0

  for (const segment of segments) {
    const end = at + segment.text.length
    if (end > from && at < until) {
      out.push({
        ...segment,
        text: segment.text.slice(Math.max(0, from - at), Math.min(segment.text.length, until - at)),
      })
    }
    at = end
    if (at >= until) break
  }

  return out
}

/**
 * Pad a line out to `width` with a styled run of spaces.
 *
 * Diff rows need this: a background that stops where the code stops leaves the
 * add/delete tint as a ragged right edge instead of a band, and the eye reads
 * the ragged edge as meaningful.
 */
export function padSegments(segments, width, style) {
  const short = width - segmentsWidth(segments)
  return short > 0 ? [...segments, { ...style, text: ' '.repeat(short) }] : segments
}

function inlineSegments(children, base) {
  const out = []
  const stack = []
  let style = base

  const open = (extra) => {
    stack.push(style)
    style = { ...style, ...extra }
  }

  for (const token of children) {
    switch (token.type) {
      case 'strong_open':
        open({ bold: true })
        break
      case 'em_open':
        open({ italic: true })
        break
      case 's_open':
        open({ strikethrough: true })
        break
      case 'link_open':
        open({ color: colors.link, underline: true })
        break
      case 'strong_close':
      case 'em_close':
      case 's_close':
      case 'link_close':
        style = stack.pop()
        break
      case 'code_inline':
        // Code spans drop the surrounding dim: a greyed-out identifier is the
        // one thing in a finding you most want to be able to read.
        out.push({ ...style, text: token.content, color: colors.code, bg: colors.codeBg, dim: false })
        break
      case 'softbreak':
        out.push({ ...style, text: ' ' })
        break
      case 'hardbreak':
        out.push({ ...style, text: '\n' })
        break
      default:
        if (token.content) out.push({ ...style, text: token.content })
    }
  }

  return out
}

/** Split one line of markdown into styled segments. */
export function parseInline(text, base = {}) {
  const [inline] = parser.parseInline(String(text ?? ''), {})
  return inlineSegments(inline?.children ?? [], base)
}

/**
 * Greedy word wrap that carries each word's style with it.
 *
 * `hanging` is prepended to the first line and replaced by equivalent
 * whitespace on the rest, so a bullet's continuation lines stay aligned under
 * its text rather than under its marker.
 */
export function wrapSegments(segments, width, hanging = '') {
  const inner = Math.max(8, width - hanging.length)
  const lines = []
  let line = []
  let length = 0

  const flush = () => {
    if (line.length) lines.push(line)
    line = []
    length = 0
  }

  for (const segment of segments) {
    for (const part of segment.text.split(/(\s+)/)) {
      if (!part) continue

      if (/^\s+$/.test(part)) {
        if (part.includes('\n')) {
          flush()
          continue
        }
        if (length > 0 && length < inner) {
          line.push({ ...segment, text: ' ' })
          length++
        }
        continue
      }

      let word = part
      while (word.length > inner) {
        flush()
        lines.push([{ ...segment, text: word.slice(0, inner) }])
        word = word.slice(inner)
      }
      if (length + word.length > inner) flush()
      line.push({ ...segment, text: word })
      length += word.length
    }
  }
  flush()

  if (!hanging) return lines
  const pad = ' '.repeat(hanging.length)
  return lines.map((l, i) => [{ text: i === 0 ? hanging : pad, dim: true }, ...l])
}

const closingIndex = (tokens, start) => {
  let depth = 0
  for (let i = start; ; i++) {
    depth += tokens[i].nesting
    if (depth === 0) return i
  }
}

// Code keeps its own line breaks and indentation; wrapping it would be a lie
// about the code, so over-wide lines are left for the pane to truncate.
function codeLines(token) {
  if (!token.content) return []
  const code = token.content.replace(/\n$/, '')
  const lang = token.info.trim().split(/\s+/)[0]
  const highlighted = highlightCode?.(code, lang)
  return code.split('\n').map((raw, i) => {
    const segments = highlighted?.[i]?.length ? highlighted[i] : [{ text: raw, color: colors.fence }]
    return [{ text: '│ ', dim: true }, ...segments]
  })
}

function hanging(lines, marker) {
  if (lines.length === 0) return [[{ text: marker, dim: true }]]
  const pad = ' '.repeat(marker.length)
  return lines.map((line, i) => (line.length === 0 ? [] : [{ text: i === 0 ? marker : pad, dim: true }, ...line]))
}

function tableColumns(rows, width) {
  const natural = rows[0].map((_, c) => Math.max(...rows.map((row) => segmentsWidth(row[c].segments))))
  const available = width - 3 * (natural.length - 1)
  const total = (cap) => natural.reduce((sum, w) => sum + Math.min(w, cap), 0)
  let cap = Math.max(...natural)
  while (cap > 8 && total(cap) > available) cap--
  let spare = Math.max(0, available - total(cap))
  return natural.map((w) => {
    const extra = Math.min(spare, Math.max(0, w - cap))
    spare -= extra
    return Math.min(w, cap) + extra
  })
}

function alignedCell(line, width, align) {
  const short = Math.max(0, width - segmentsWidth(line))
  const left = align === 'right' ? short : align === 'center' ? short >> 1 : 0
  return [{ text: ' '.repeat(left) }, ...line, { text: ' '.repeat(short - left) }]
}

function tableLines(tokens, width, base) {
  const rows = []
  let align
  let cellBase = base

  for (const token of tokens) {
    if (token.type === 'tr_open') {
      rows.push([])
    } else if (token.type === 'th_open' || token.type === 'td_open') {
      align = /text-align:(\w+)/.exec(token.attrGet('style') ?? '')?.[1]
      cellBase = token.type === 'th_open' ? { ...base, bold: true } : base
    } else if (token.type === 'inline') {
      rows.at(-1).push({ align, segments: inlineSegments(token.children, cellBase) })
    }
  }

  const columns = tableColumns(rows, width)
  const separator = { text: ' │ ', color: colors.rule, dim: true }
  const lines = []

  rows.forEach((row, r) => {
    const wrapped = row.map((cell, c) => wrapSegments(cell.segments, columns[c]))
    const height = Math.max(1, ...wrapped.map((cell) => cell.length))
    for (let y = 0; y < height; y++) {
      lines.push(
        wrapped.flatMap((cell, c) => [
          ...(c > 0 ? [separator] : []),
          ...alignedCell(cell[y] ?? [], columns[c], row[c].align),
        ]),
      )
    }
    if (r === 0) {
      lines.push([{ text: columns.map((w) => '─'.repeat(w)).join('─┼─'), color: colors.rule, dim: true }])
    }
  })

  return lines
}

function blockLines(tokens, width, base, cursor) {
  const lines = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.map) continue

    if (token.map[0] > cursor.line) lines.push([])
    cursor.line = token.map[0]

    const end = token.nesting === 1 ? closingIndex(tokens, i) : i
    const inner = tokens.slice(i + 1, end)

    switch (token.type) {
      case 'paragraph_open':
        lines.push(...wrapSegments(inlineSegments(inner[0].children, base), width))
        cursor.line = token.map[1]
        break
      case 'heading_open':
        lines.push(...wrapSegments(inlineSegments(inner[0].children, { ...base, bold: true }), width))
        cursor.line = token.map[1]
        break
      case 'hr':
        lines.push([{ text: '─'.repeat(Math.max(4, Math.min(width, 24))), color: colors.rule, dim: true }])
        cursor.line = token.map[1]
        break
      case 'fence':
      case 'code_block':
        lines.push(...codeLines(token))
        cursor.line = token.map[1]
        break
      case 'table_open':
        lines.push(...tableLines(inner, width, base))
        cursor.line = token.map[1]
        break
      case 'bullet_list_open':
      case 'ordered_list_open':
        lines.push(...blockLines(inner, width, base, cursor))
        break
      case 'list_item_open': {
        const marker = token.info ? `${token.info}. ` : '• '
        lines.push(...hanging(blockLines(inner, width - marker.length, base, cursor), marker))
        cursor.line = Math.max(cursor.line, token.map[0] + 1)
        break
      }
      case 'blockquote_open': {
        const quoted = blockLines(inner, width - 2, { ...base, color: colors.quote, dim: true }, cursor)
        lines.push(...quoted.map((line) => [{ text: '▏ ', dim: true }, ...line]))
        cursor.line = Math.max(cursor.line, token.map[0] + 1)
        break
      }
    }

    i = end
  }

  return lines
}

/**
 * Render markdown to wrapped, styled lines.
 *
 * Consecutive plain lines are joined into one paragraph before wrapping — a
 * `fix` field hard-wrapped by the model would otherwise re-wrap raggedly
 * against the pane width.
 */
export function markdownLines(text, width) {
  return blockLines(parser.parse(String(text ?? ''), {}), width, {}, { line: Infinity })
}

/** Shift rendered lines right, e.g. to sit under a finding's title. */
export const indentLines = (lines, by) =>
  lines.map((line) => (line.length === 0 ? [] : [{ text: ' '.repeat(by) }, ...line]))

/** A one-line, style-carrying convenience for non-markdown rows. */
export const plain = (text, style = {}) => [{ text, ...style }]
