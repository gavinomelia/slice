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
import stringWidth from 'string-width'

const parser = new MarkdownExit()
const documentParser = new MarkdownExit({ html: true })
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
const ASCII = /^[\x20-\x7e]*$/
const TAB_WIDTH = 4
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const clean = (text) => String(text ?? '').replace(CONTROL, '')
const textWidth = (text) => (ASCII.test(text) ? text.length : stringWidth(text))

const takeWidth = (text, limit) => {
  let taken = ''
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    const next = stringWidth(segment)
    if (width + next > limit && taken) break
    taken += segment
    width += next
  }
  return [taken, text.slice(taken.length)]
}

const expandTabs = (line) => {
  if (!line.includes('\t')) return line
  let out = ''
  for (const char of line) out += char === '\t' ? ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH)) : char
  return out
}

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
export const segmentsWidth = (segments) => segments.reduce((total, segment) => total + textWidth(segment.text), 0)

function columnWindow(text, from, until) {
  if (ASCII.test(text)) return text.slice(from, until)
  let out = ''
  let at = 0
  for (const { segment } of graphemes.segment(text)) {
    const next = stringWidth(segment)
    if (at >= from && at + next <= until) out += segment
    at += next
    if (at >= until) break
  }
  return out
}

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
    const end = at + textWidth(segment.text)
    if (end > from && at < until) {
      out.push({ ...segment, text: columnWindow(segment.text, Math.max(0, from - at), until - at) })
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
      case 'html_inline':
        break
      case 'link_url':
        out.push({ ...style, text: token.content, color: undefined, underline: false, dim: true })
        break
      default:
        if (token.content) out.push({ ...style, text: token.content })
    }
  }

  return out
}

/** Split one line of markdown into styled segments. */
export function parseInline(text, base = {}) {
  const [inline] = parser.parseInline(clean(text), {})
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
      while (textWidth(word) > inner) {
        flush()
        const [head, rest] = takeWidth(word, inner)
        lines.push([{ ...segment, text: head }])
        word = rest
      }
      const wordWidth = textWidth(word)
      if (length + wordWidth > inner) flush()
      line.push({ ...segment, text: word })
      length += wordWidth
    }
  }
  flush()

  if (!hanging) return lines
  const pad = ' '.repeat(hanging.length)
  return lines.map((l, i) => [{ text: i === 0 ? hanging : pad, dim: true }, ...l])
}

const sources = new WeakMap()

export const sourceOf = (line) => sources.get(line)

const withSource = (lines, map) => {
  for (const line of lines) if (line.length > 0) sources.set(line, map)
  return lines
}

const prefixed = (line, prefix) => {
  const out = [prefix, ...line]
  if (sources.has(line)) sources.set(out, sources.get(line))
  return out
}

export const stripFrontmatter = (text) =>
  String(text ?? '').replace(/^---[ \t]*\r?\n(?=[\w-]+:)[\s\S]*?\n---[ \t]*(?:\r?\n|$)/, (match) =>
    match.replace(/[^\n]/g, ''),
  )

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
  const code = token.content.replace(/\n$/, '').split('\n').map(expandTabs).join('\n')
  const lang = token.info.trim().split(/\s+/)[0]
  const highlighted = highlightCode?.(code, lang)
  const raws = code.split('\n')
  const start = token.map[0] + (token.type === 'fence' ? 1 : 0)
  return raws.map((raw, i) => {
    const segments = highlighted?.[i]?.length ? highlighted[i] : [{ text: raw, color: colors.fence }]
    const row = [{ text: '│ ', dim: true }, ...segments]
    sources.set(row, [start + i, i === raws.length - 1 ? token.map[1] : start + i + 1])
    return row
  })
}

function diagramLines(token, diagrams) {
  if (!diagrams || token.type !== 'fence' || token.info.trim().split(/\s+/)[0] !== 'mermaid') return null
  const drawn = diagrams.get(token.content)
  if (drawn)
    return withSource(
      drawn.map((text) => [{ text }]),
      token.map,
    )
  const note = [{ text: 'This diagram could not be drawn, so here is its source.', color: colors.quote, dim: true }]
  return [...withSource([note], token.map), ...codeLines(token)]
}

function hanging(lines, marker) {
  if (lines.length === 0) return [[{ text: marker, dim: true }]]
  const pad = ' '.repeat(marker.length)
  return lines.map((line, i) => (line.length === 0 ? [] : prefixed(line, { text: i === 0 ? marker : pad, dim: true })))
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
  const rowSources = []
  let align
  let cellBase = base

  for (const token of tokens) {
    if (token.type === 'tr_open') {
      rows.push([])
      rowSources.push(token.map)
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
        ...withSource(
          [
            wrapped.flatMap((cell, c) => [
              ...(c > 0 ? [separator] : []),
              ...alignedCell(cell[y] ?? [], columns[c], row[c].align),
            ]),
          ],
          rowSources[r],
        ),
      )
    }
    if (r === 0) {
      lines.push([{ text: columns.map((w) => '─'.repeat(w)).join('─┼─'), color: colors.rule, dim: true }])
    }
  })

  return lines
}

const htmlText = (html) =>
  html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function takeTaskMarker(inner) {
  const first = inner[1]?.children?.[0]
  const task = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null
  if (!task) return null
  first.content = first.content.slice(task[0].length)
  return task[1] === ' ' ? '☐ ' : '☑ '
}

function headingStyle(tag) {
  if (tag === 'h1') return { bold: true, underline: true, color: colors.heading }
  if (tag === 'h2') return { bold: true, color: colors.heading }
  return { bold: true }
}

function blockLines(tokens, width, base, cursor) {
  const lines = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.map) continue
    if (token.type === 'html_block' && !htmlText(token.content)) continue

    if (token.map[0] > cursor.line) lines.push([])
    cursor.line = token.map[0]

    const end = token.nesting === 1 ? closingIndex(tokens, i) : i
    const inner = tokens.slice(i + 1, end)

    switch (token.type) {
      case 'paragraph_open':
        lines.push(...withSource(wrapSegments(inlineSegments(inner[0].children, base), width), token.map))
        cursor.line = token.map[1]
        break
      case 'heading_open':
        lines.push(
          ...withSource(
            wrapSegments(inlineSegments(inner[0].children, { ...base, ...headingStyle(token.tag) }), width),
            token.map,
          ),
        )
        cursor.line = token.map[1]
        break
      case 'hr':
        lines.push([{ text: '─'.repeat(Math.max(4, Math.min(width, 24))), color: colors.rule, dim: true }])
        cursor.line = token.map[1]
        break
      case 'fence':
      case 'code_block':
        lines.push(...(diagramLines(token, cursor.diagrams) ?? codeLines(token)))
        cursor.line = token.map[1]
        break
      case 'html_block':
        lines.push(...withSource(wrapSegments([{ ...base, text: htmlText(token.content) }], width), token.map))
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
        const marker = takeTaskMarker(inner) ?? (token.info ? `${token.info}. ` : '• ')
        lines.push(...hanging(blockLines(inner, width - marker.length, base, cursor), marker))
        cursor.line = Math.max(cursor.line, token.map[0] + 1)
        break
      }
      case 'blockquote_open': {
        const quoted = blockLines(inner, width - 2, { ...base, color: colors.quote, dim: true }, cursor)
        lines.push(...quoted.map((line) => prefixed(line, { text: '▏ ', dim: true })))
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
  return blockLines(parser.parse(clean(text), {}), width, {}, { line: Infinity })
}

const parseDocument = (text) => documentParser.parse(stripFrontmatter(clean(text)), {})

const isFence = (token) => token.type === 'fence' && token.info.trim().split(/\s+/)[0] === 'mermaid'

export const mermaidSources = (text) =>
  parseDocument(text)
    .filter(isFence)
    .map((token) => token.content)

function addLinkUrls(tokens) {
  for (const token of tokens) {
    if (token.type !== 'inline') continue
    const children = []
    let open = null
    let label = ''
    let hasImage = false
    for (const child of token.children) {
      children.push(child)
      if (child.type === 'link_open') {
        open = child
        label = ''
        hasImage = false
      } else if (child.type === 'link_close' && open) {
        const href = open.attrGet('href') ?? ''
        if (/^https?:/i.test(href) && !hasImage && label !== href) {
          children.push({ type: 'link_url', content: ` (${href})` })
        }
        open = null
      } else if (open) {
        if (child.type === 'image') hasImage = true
        label += child.content ?? ''
      }
    }
    token.children = children
  }
  return tokens
}

export const documentLines = (text, width, diagrams) =>
  blockLines(addLinkUrls(parseDocument(text)), width, {}, { line: Infinity, diagrams })

/** Shift rendered lines right, e.g. to sit under a finding's title. */
export const indentLines = (lines, by) =>
  lines.map((line) => (line.length === 0 ? [] : [{ text: ' '.repeat(by) }, ...line]))

/** A one-line, style-carrying convenience for non-markdown rows. */
export const plain = (text, style = {}) => [{ text, ...style }]
