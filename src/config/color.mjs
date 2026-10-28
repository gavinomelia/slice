export function parseHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? ''))
  if (!match) return null
  const n = parseInt(match[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export const toHex = ({ r, g, b }) =>
  `#${[r, g, b]
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`

export const blend = (under, over, alpha) => ({
  r: under.r + (over.r - under.r) * alpha,
  g: under.g + (over.g - under.g) * alpha,
  b: under.b + (over.b - under.b) * alpha,
})

export function luminance({ r, g, b }) {
  const linear = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export const isLight = (color) => luminance(color) > 0.4

export function adaptToBackground(theme, background, foreground = null) {
  if (!background) return theme
  const text = foreground ?? (isLight(background) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 })
  const diff = { ...theme.diff }
  const markdown = { ...theme.markdown }
  const opacity = diff.opacity
  const add = parseHex(diff.addTint)
  const del = parseHex(diff.delTint)

  if (opacity && add && del) {
    const tint = (color, alpha) => toHex(blend(background, color, alpha))
    diff.addBg = tint(add, opacity.line)
    diff.delBg = tint(del, opacity.line)
    diff.addWordBg = tint(add, opacity.word)
    diff.delWordBg = tint(del, opacity.word)
  }

  if (markdown.codeBgOpacity) {
    markdown.codeBg = toHex(blend(background, text, markdown.codeBgOpacity))
  }

  return { ...theme, diff, markdown }
}
