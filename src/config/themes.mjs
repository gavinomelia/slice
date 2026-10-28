/**
 * Colour presets for the terminal viewer.
 *
 * Two kinds of colour appear here, deliberately:
 *
 * - Palette names (`cyan`, `gray`) resolve to whatever the user's terminal
 *   theme says they are, so chrome blends into their setup.
 * - Hex values are used where the exact shade matters — diff backgrounds have
 *   to be dark enough to sit under Shiki's foreground colours without drowning
 *   them, and no palette slot guarantees that.
 *
 * Chalk downsamples hex for terminals without truecolour, so both are safe.
 */

/** Ship-to-shore defaults, matching the browser viewer's dark appearance. */
const dark = {
  /**
   * Any Shiki theme id, plus `pierre-dark` and `pierre-light` from
   * @pierre/diffs. Both viewers highlight from the same tokens, so this is the
   * one setting that changes the code itself rather than the chrome.
   */
  syntax: 'ansi',

  diff: {
    addBg: '#0d1f15',
    delBg: '#261315',
    contextBg: null,
    /** Intra-line word changes, tinted harder than the line they sit on. */
    addWordBg: '#173a24',
    delWordBg: '#46201f',
    tint: { line: 0.035, word: 0.07 },
    addTint: '#3fb950',
    delTint: '#f85149',
    addMark: 'green',
    delMark: 'red',
    lineNumber: 'gray',
    hunk: 'gray',
  },

  ui: {
    accent: 'cyan',
    muted: 'gray',
    border: 'gray',
    borderFocus: 'cyan',
    cursor: 'cyan',
    draft: 'green',
    reviewed: 'green',
    heading: 'gray',
    scrollTrack: 'gray',
    scrollThumb: 'gray',
  },

  /**
   * What happened to a file, shown in the tree. Modified gets no glyph on
   * purpose: it is nearly every row, and marking it would drown the handful
   * that are worth noticing. The add/delete colours are the diff's own, so a
   * new file reads as new in both places.
   */
  fileStatus: {
    added: { glyph: '+', color: 'green' },
    deleted: { glyph: '-', color: 'red' },
    renamed: { glyph: '→', color: 'cyan' },
    binary: { glyph: '◆', color: 'gray' },
    modified: { glyph: ' ', color: null },
  },

  risk: { low: 'green', medium: 'yellow', high: 'red' },

  markdown: {
    code: 'cyan',
    codeBg: '#2c2f36',
    codeBgOpacity: 0.07,
    link: 'blue',
    fence: 'green',
    quote: 'gray',
    rule: 'gray',
  },
}

/**
 * For light terminals, where the dark preset's diff backgrounds turn the code
 * into a black hole. Tints come from GitHub's light diff palette, which is
 * tuned for exactly this.
 */
const light = {
  syntax: 'ansi',

  diff: {
    addBg: '#dafbe1',
    delBg: '#ffebe9',
    contextBg: null,
    addWordBg: '#aceebb',
    delWordBg: '#ffc1bc',
    tint: { line: 0.035, word: 0.07 },
    addTint: '#1a7f37',
    delTint: '#cf222e',
    addMark: 'green',
    delMark: 'red',
    lineNumber: 'gray',
    hunk: 'gray',
  },

  ui: {
    accent: 'blue',
    muted: 'gray',
    border: 'gray',
    borderFocus: 'blue',
    cursor: 'blue',
    draft: 'green',
    reviewed: 'green',
    heading: 'gray',
    scrollTrack: 'gray',
    scrollThumb: 'gray',
  },

  fileStatus: {
    added: { glyph: '+', color: 'green' },
    deleted: { glyph: '-', color: 'red' },
    renamed: { glyph: '→', color: 'blue' },
    binary: { glyph: '◆', color: 'gray' },
    modified: { glyph: ' ', color: null },
  },

  risk: { low: 'green', medium: 'yellow', high: 'red' },

  markdown: {
    code: 'blue',
    codeBg: '#eaeef2',
    codeBgOpacity: 0.06,
    link: 'blue',
    fence: 'green',
    quote: 'gray',
    rule: 'gray',
  },
}

export const THEMES = { dark, light }

export const DEFAULT_THEME_NAME = 'dark'
