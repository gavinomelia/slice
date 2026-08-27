/**
 * hast -> ANSI. The bridge that makes a TUI viewer possible at all.
 *
 * @pierre/diffs' components are web components, but everything under them is
 * headless: getSingularPatch parses, renderDiffWithHighlighter returns hast
 * with Shiki's hex colors inline. This walks that hast and emits truecolor
 * ANSI instead of DOM nodes, so the terminal and the browser render from the
 * exact same tokens.
 */
import {
  DEFAULT_THEMES,
  getFiletypeFromFileName,
  getSharedHighlighter,
  getSingularPatch,
  renderDiffWithHighlighter,
} from '@pierre/diffs'

const RESET = '\x1b[0m'
const FG_OFF = '\x1b[39m'

const rgb = (hex, layer) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `\x1b[${layer};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}

const fg = (hex) => rgb(hex, 38)
const bg = (hex) => rgb(hex, 48)

/** Line backgrounds, dark enough to sit under Shiki's foreground colors. */
const LINE_BG = { add: bg('#0b2c18'), del: bg('#3a1114'), ctx: '' }
/** Word-level intra-line changes get a stronger tint (jsdiff drives these). */
const WORD_BG = { add: bg('#1c5c31'), del: bg('#6b1f26'), ctx: '' }

const GUTTER = {
  add: fg('#3fb950') + '+' + FG_OFF,
  del: fg('#f85149') + '-' + FG_OFF,
  ctx: ' ',
}

/**
 * Walk one line's hast into ANSI.
 *
 * Text nodes emit `fg + text` and reset only the foreground, never the whole
 * SGR state — a full reset would drop the line background midway and leave the
 * add/del tint striped across the row.
 */
function lineToAnsi(node, kind) {
  const base = LINE_BG[kind]
  const out = []

  const walk = (n, color, bgNow) => {
    if (n.type === 'text') {
      out.push(bgNow + (color ? fg(color) : '') + n.value.replace(/\n$/, '') + FG_OFF)
      return
    }
    let nextColor = color
    let nextBg = bgNow
    const style = n.properties?.style
    if (typeof style === 'string') {
      const match = /color:\s*(#[0-9a-fA-F]{6})/.exec(style)
      if (match) nextColor = match[1]
    }
    if (n.properties?.['data-diff-span'] !== undefined) nextBg = WORD_BG[kind] || bgNow
    for (const child of n.children ?? []) walk(child, nextColor, nextBg)
  }

  for (const child of node.children ?? []) walk(child, null, base)
  return base + out.join('') + RESET
}

/** The same line as plain text, for seeding $EDITOR with diff context. */
function lineToText(node) {
  let out = ''
  const walk = (n) => {
    if (n.type === 'text') out += n.value
    else for (const child of n.children ?? []) walk(child)
  }
  walk(node)
  return out.replace(/\n$/, '')
}

/** Shared across files; passing `langs` loads incrementally into the same instance. */
export function highlighter(lang) {
  return getSharedHighlighter({ langs: lang ? [lang] : [], themes: [DEFAULT_THEMES.dark] })
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
export async function codeHighlighter() {
  const hl = await getSharedHighlighter({ langs: [], themes: [DEFAULT_THEMES.dark] })

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
      const { tokens } = hl.codeToTokens(code, { lang: use, theme: DEFAULT_THEMES.dark })
      return tokens.map((line) => line.map((token) => ({ text: token.content, color: token.color })))
    } catch {
      return null
    }
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
export async function buildRows(file) {
  const diff = getSingularPatch(file.patch)
  diff.lang ??= getFiletypeFromFileName(file.path)

  // An unknown extension is not fatal: renderDiffWithHighlighter falls back to
  // plain text, which still gives correct gutters and add/del tints.
  let hl
  try {
    hl = await highlighter(diff.lang)
  } catch {
    hl = await highlighter(null)
    diff.lang = undefined
  }

  const { code } = renderDiffWithHighlighter(diff, hl, {
    theme: DEFAULT_THEMES.dark,
    useTokenTransformer: false,
    tokenizeMaxLineLength: 2000,
    lineDiffType: 'word',
    maxLineDiffLength: 2000,
  })

  const rows = []
  const push = (kind, node) => {
    if (!node) return
    rows.push({
      kind,
      line: node.properties?.['data-line'] ?? null,
      gutter: GUTTER[kind],
      ansi: lineToAnsi(node, kind),
      text: lineToText(node),
    })
  }

  for (const hunk of diff.hunks) {
    rows.push({ kind: 'hunk', line: null, gutter: ' ', ansi: `\x1b[2m${hunk.hunkSpecs ?? '@@'}${RESET}` })
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
