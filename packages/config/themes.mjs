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
  syntax: 'pierre-dark',

  diff: {
    addBg: '#0b2c18',
    delBg: '#3a1114',
    contextBg: null,
    /** Intra-line word changes, tinted harder than the line they sit on. */
    addWordBg: '#1c5c31',
    delWordBg: '#6b1f26',
    addMark: '#3fb950',
    delMark: '#f85149',
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
    heading: 'gray',
    scrollTrack: 'gray',
    scrollThumb: 'gray',
  },

  risk: { low: 'green', medium: 'yellow', high: 'red' },

  markdown: {
    code: 'cyan',
    codeBg: '#2c2f36',
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
  syntax: 'pierre-light',

  diff: {
    addBg: '#dafbe1',
    delBg: '#ffebe9',
    contextBg: null,
    addWordBg: '#aceebb',
    delWordBg: '#ffc1bc',
    addMark: '#1a7f37',
    delMark: '#cf222e',
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
    heading: 'gray',
    scrollTrack: 'gray',
    scrollThumb: 'gray',
  },

  risk: { low: 'green', medium: 'yellow', high: 'red' },

  markdown: {
    code: 'blue',
    codeBg: '#eaeef2',
    link: 'blue',
    fence: 'green',
    quote: 'gray',
    rule: 'gray',
  },
}

export const THEMES = { dark, light }

export const DEFAULT_THEME_NAME = 'dark'
