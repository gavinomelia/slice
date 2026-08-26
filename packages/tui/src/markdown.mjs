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
 * A segment is `{ text, color?, bg?, bold?, dim?, italic?, underline? }`.
 */

const INLINE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w])|\[[^\]\n]+\]\([^)\n]+\))/

/** Background for inline `code`, so a span reads as code without a fence. */
const CODE_BG = '#2c2f36'

/**
 * Set by the app once Shiki is warm. `(code, lang) => Segment[][] | null`, one
 * entry per line. A hook rather than an import, so this module stays pure and
 * a fenced block still renders if Shiki never loads.
 */
let highlightCode = null
export const setCodeHighlighter = (fn) => {
  highlightCode = fn
}

/** Split one line of markdown into styled segments. */
export function parseInline(text, base = {}) {
  const out = []
  let rest = String(text ?? '')

  while (rest) {
    const match = INLINE.exec(rest)
    if (!match) {
      if (rest) out.push({ ...base, text: rest })
      break
    }
    if (match.index > 0) out.push({ ...base, text: rest.slice(0, match.index) })

    const token = match[0]
    if (token.startsWith('`')) {
      // Code spans drop the surrounding dim: a greyed-out identifier is the
      // one thing in a finding you most want to be able to read.
      out.push({ ...base, text: token.slice(1, -1), color: 'cyan', bg: CODE_BG, dim: false })
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ ...base, text: token.slice(2, -2), bold: true })
    } else if (token.startsWith('[')) {
      out.push({ ...base, text: /\[([^\]]+)\]/.exec(token)[1], color: 'blue', underline: true })
    } else {
      out.push({ ...base, text: token.slice(1, -1), italic: true })
    }

    rest = rest.slice(match.index + token.length)
  }

  return out
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

const FENCE = /^\s*```(\w*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/

/**
 * Render markdown to wrapped, styled lines.
 *
 * Consecutive plain lines are joined into one paragraph before wrapping — a
 * `fix` field hard-wrapped by the model would otherwise re-wrap raggedly
 * against the pane width.
 */
export function markdownLines(text, width) {
  const lines = []
  let paragraph = []
  let fenced = false
  let lang = ''
  let code = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    lines.push(...wrapSegments(parseInline(paragraph.join(' ')), width))
    paragraph = []
  }

  // Code keeps its own line breaks and indentation; wrapping it would be a lie
  // about the code, so over-wide lines are left for the pane to truncate.
  const flushCode = () => {
    const highlighted = code.length > 0 ? highlightCode?.(code.join('\n'), lang) : null
    code.forEach((raw, i) => {
      const segments = highlighted?.[i]?.length ? highlighted[i] : [{ text: raw, color: 'green' }]
      lines.push([{ text: '│ ', dim: true }, ...segments])
    })
    code = []
  }

  for (const raw of String(text ?? '').split('\n')) {
    const fence = FENCE.exec(raw)
    if (fence) {
      if (fenced) flushCode()
      else flushParagraph()
      fenced = !fenced
      lang = fenced ? fence[1] : ''
      continue
    }

    if (fenced) {
      code.push(raw)
      continue
    }

    if (!raw.trim()) {
      flushParagraph()
      lines.push([])
      continue
    }

    if (RULE.test(raw)) {
      flushParagraph()
      lines.push([{ text: '─'.repeat(Math.max(4, Math.min(width, 24))), dim: true }])
      continue
    }

    const heading = HEADING.exec(raw)
    if (heading) {
      flushParagraph()
      lines.push(...wrapSegments(parseInline(heading[2], { bold: true }), width))
      continue
    }

    const bullet = BULLET.exec(raw)
    if (bullet) {
      flushParagraph()
      lines.push(...wrapSegments(parseInline(bullet[2]), width, `${' '.repeat(bullet[1].length)}• `))
      continue
    }

    const ordered = ORDERED.exec(raw)
    if (ordered) {
      flushParagraph()
      lines.push(...wrapSegments(parseInline(ordered[3]), width, `${' '.repeat(ordered[1].length)}${ordered[2]}. `))
      continue
    }

    const quote = QUOTE.exec(raw)
    if (quote) {
      flushParagraph()
      lines.push(...wrapSegments(parseInline(quote[1], { dim: true }), width, '▏ '))
      continue
    }

    paragraph.push(raw.trim())
  }

  // An unterminated fence is common in truncated model output; render what we
  // have rather than dropping it.
  if (fenced) flushCode()
  flushParagraph()
  return lines
}

/** Shift rendered lines right, e.g. to sit under a finding's title. */
export const indentLines = (lines, by) =>
  lines.map((line) => (line.length === 0 ? [] : [{ text: ' '.repeat(by) }, ...line]))

/** A one-line, style-carrying convenience for non-markdown rows. */
export const plain = (text, style = {}) => [{ text, ...style }]
