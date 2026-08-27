/**
 * hast -> styled segments. The bridge that makes a TUI viewer possible at all.
 *
 * @pierre/diffs' components are web components, but everything under them is
 * headless: getSingularPatch parses, renderDiffWithHighlighter returns hast
 * with Shiki's hex colors inline. This walks that hast into the same
 * `{ text, color }` segment shape the markdown renderer uses, so the terminal
 * and the browser render from the exact same tokens.
 *
 * Segments rather than pre-baked ANSI, because a flat escape-laden string can
 * be printed but not manipulated. Keeping the pieces addressable is what lets
 * a line be sliced for horizontal scrolling, padded to the pane width so the
 * add/delete tint runs edge to edge, and recoloured from config without
 * re-parsing the diff.
 */
import {
  DEFAULT_THEMES,
  getFiletypeFromFileName,
  getSharedHighlighter,
  getSingularPatch,
  renderDiffWithHighlighter,
} from '@pierre/diffs'

/**
 * Expand tabs against the running column, not per-segment.
 *
 * A tab advances to the next multiple of `tabWidth` from wherever the line
 * currently is, so expanding each segment in isolation would misalign every
 * indented block. Terminals also render a raw tab as a jump the column
 * arithmetic behind horizontal scrolling cannot see, which is the real reason
 * this has to happen here rather than being left to the terminal.
 */
function expandTabs(text, column, tabWidth) {
  if (!text.includes('\t')) return text
  let out = ''
  let at = column
  for (const char of text) {
    if (char === '\t') {
      const width = tabWidth - (at % tabWidth)
      out += ' '.repeat(width)
      at += width
    } else {
      out += char
      at++
    }
  }
  return out
}

/**
 * Walk one line's hast into segments.
 *
 * `word` marks a span jsdiff flagged as an intra-line change, so the viewer
 * can tint just the characters that actually differ rather than the row.
 */
function lineToSegments(node, tabWidth) {
  const out = []
  let column = 0

  const walk = (n, color, word) => {
    if (n.type === 'text') {
      const text = expandTabs(n.value.replace(/\n$/, ''), column, tabWidth)
      if (!text) return
      column += text.length
      out.push(word ? { text, color, word } : { text, color })
      return
    }

    let nextColor = color
    let nextWord = word
    const style = n.properties?.style
    if (typeof style === 'string') {
      const match = /color:\s*(#[0-9a-fA-F]{6})/.exec(style)
      if (match) nextColor = match[1]
    }
    if (n.properties?.['data-diff-span'] !== undefined) nextWord = true

    for (const child of n.children ?? []) walk(child, nextColor, nextWord)
  }

  for (const child of node.children ?? []) walk(child, undefined, false)
  return out
}

const segmentsToText = (segments) => segments.map((segment) => segment.text).join('')

/** Shared across files; passing `langs` loads incrementally into the same instance. */
export function highlighter(lang, theme = DEFAULT_THEMES.dark) {
  return getSharedHighlighter({ langs: lang ? [lang] : [], themes: [theme] })
}

/** Languages worth having warm for fenced blocks inside a finding's `fix`. */
const FIX_LANGS = ['ruby', 'javascript', 'typescript', 'erb', 'html', 'css', 'scss', 'json', 'yaml', 'shellscript', 'sql', 'diff']

/**
 * A synchronous `(code, lang) => Segment[][]` for the markdown renderer.
 *
 * Loading is done up front because markdown rendering happens inside a
 * useMemo — there is nowhere to await. Languages are loaded one at a time so
 * one unsupported id doesn't take the whole set down with it.
 */
export async function codeHighlighter(theme = DEFAULT_THEMES.dark) {
  const hl = await getSharedHighlighter({ langs: [], themes: [theme] })

  for (const lang of FIX_LANGS) {
    try {
      await hl.loadLanguage(lang)
    } catch {
      // Not bundled in this Shiki build; blocks in it fall back to plain.
    }
  }

  const loaded = new Set(hl.getLoadedLanguages())

  return (code, lang) => {
    const use = loaded.has(lang) ? lang : null
    if (!use) return null
    try {
      const { tokens } = hl.codeToTokens(code, { lang: use, theme })
      return tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color })))
    } catch {
      return null
    }
  }
}

/**
 * Resolve a configured syntax theme, falling back rather than failing.
 *
 * A typo in a theme name should cost you the theme, not the review — Shiki
 * throws on an unknown id, and there is nothing useful to do with that
 * exception three panes deep in a render.
 */
export async function resolveSyntaxTheme(name) {
  const wanted = name ?? DEFAULT_THEMES.dark
  try {
    await getSharedHighlighter({ langs: [], themes: [wanted] })
    return wanted
  } catch {
    return DEFAULT_THEMES.dark
  }
}

/**
 * Build unified rows for one file.
 *
 * hunkContent carries only counts and indices; the text lives in the flat
 * file-level additionLines/deletionLines arrays, so walking a hunk means
 * stepping those two cursors. Context lines appear in both arrays — we read
 * them from the addition side so the gutter shows post-change line numbers.
 */
export async function buildRows(file, { theme = DEFAULT_THEMES.dark, tabWidth = 4 } = {}) {
  const diff = getSingularPatch(file.patch)
  diff.lang ??= getFiletypeFromFileName(file.path)

  // An unknown extension is not fatal: renderDiffWithHighlighter falls back to
  // plain text, which still gives correct gutters and add/del tints.
  let hl
  try {
    hl = await highlighter(diff.lang, theme)
  } catch {
    hl = await highlighter(null, theme)
    diff.lang = undefined
  }

  const { code } = renderDiffWithHighlighter(diff, hl, {
    theme,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 2000,
    lineDiffType: 'word',
    maxLineDiffLength: 2000,
  })

  const rows = []
  const push = (kind, node) => {
    if (!node) return
    const segments = lineToSegments(node, tabWidth)
    rows.push({
      kind,
      line: node.properties?.['data-line'] ?? null,
      segments,
      // Plain text alongside, for seeding $EDITOR with diff context and for
      // measuring the widest line without re-walking segments.
      text: segmentsToText(segments),
    })
  }

  for (const hunk of diff.hunks) {
    // hunkSpecs keeps the newline it was parsed with. A newline inside an Ink
    // <Text> silently becomes an extra row, which overflows the frame and puts
    // Ink into clear-and-redraw — the torn-frame failure the height budget in
    // the viewer is guarding against.
    const text = (hunk.hunkSpecs ?? '@@').trim()
    rows.push({ kind: 'hunk', line: null, segments: [{ text }], text })
    for (const entry of hunk.hunkContent) {
      if (entry.type === 'context') {
        for (let i = 0; i < entry.lines; i++) push('ctx', code.additionLines[entry.additionLineIndex + i])
      } else {
        for (let i = 0; i < entry.deletions; i++) push('del', code.deletionLines[entry.deletionLineIndex + i])
        for (let i = 0; i < entry.additions; i++) push('add', code.additionLines[entry.additionLineIndex + i])
      }
    }
  }

  return rows
}
