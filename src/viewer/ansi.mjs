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

const rule = (color, scope) => ({ scope, settings: { foreground: slot(color) } })

export const ANSI_THEME = {
  name: 'ansi',
  type: 'dark',
  fg: '#a00000',
  bg: '#000000',
  colors: { 'editor.foreground': '#a00000', 'editor.background': '#000000' },
  tokenColors: [
    { settings: { foreground: '#a00000' } },
    rule('gray', ['comment', 'punctuation.definition.comment', 'string.comment']),
    rule('magenta', [
      'keyword',
      'storage',
      'storage.type',
      'storage.modifier',
      'keyword.control',
      'variable.language',
      'support.type.primitive',
    ]),
    rule('green', ['string', 'string.quoted', 'string.template', 'markup.inserted', 'constant.other.symbol.hashkey']),
    rule('cyan', [
      'constant.other.symbol',
      'constant.language.symbol',
      'string.regexp',
      'constant.character.escape',
      'support.constant',
      'keyword.operator.regexp',
    ]),
    rule('yellow', [
      'constant.numeric',
      'constant.language',
      'constant.character',
      'entity.name.type',
      'entity.name.class',
      'entity.other.inherited-class',
      'support.class',
      'support.type',
      'entity.other.attribute-name',
    ]),
    rule('blue', [
      'entity.name.function',
      'support.function',
      'meta.function-call entity.name.function',
      'variable.function',
      'entity.name.method',
    ]),
    rule('red', [
      'entity.name.tag',
      'variable.other.readwrite.instance',
      'variable.other.object.property',
      'markup.deleted',
      'invalid',
    ]),
  ],
}

registerCustomTheme('ansi', () => Promise.resolve(ANSI_THEME))

export const terminalColor = (color) => {
  if (typeof color !== 'string') return color
  const key = color.toLowerCase()
  return key in PALETTE ? PALETTE[key] : color
}
