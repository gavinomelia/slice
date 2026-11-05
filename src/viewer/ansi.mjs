import { registerCustomTheme } from '@pierre/diffs'

const PALETTE = {
  '#a00000': undefined,
  '#a00001': 'red',
  '#a00002': 'green',
  '#a00003': 'yellow',
  '#a00004': 'blue',
  '#a00005': 'magenta',
  '#a00006': 'cyan',
  '#a00007': 'gray',
}

const slot = (name) => Object.keys(PALETTE).find((hex) => PALETTE[hex] === name)

const paint = (color, scopes) => scopes.map((scope) => [scope, { color: slot(color) }])

export const ANSI_THEME = {
  name: 'ansi',
  appearance: 'dark',
  style: {
    'editor.foreground': '#a00000',
    'editor.background': '#000000',
    syntax: Object.fromEntries([
      ...paint('gray', ['comment']),
      ...paint('magenta', ['keyword', 'variable.special', 'type.builtin']),
      ...paint('green', ['string', 'diff.plus']),
      ...paint('cyan', ['string.special.symbol', 'string.regex', 'string.escape', 'constant.builtin']),
      ...paint('yellow', [
        'number',
        'boolean',
        'constant',
        'type',
        'constructor',
        'enum',
        'attribute',
        'property.json_key',
      ]),
      ...paint('blue', ['function']),
      ...paint('red', ['tag', 'property', 'diff.minus']),
    ]),
  },
}

registerCustomTheme('ansi', () => Promise.resolve(ANSI_THEME), 'zed')

export const terminalColor = (color) => {
  if (typeof color !== 'string') return color
  const key = color.toLowerCase()
  return key in PALETTE ? PALETTE[key] : color
}
