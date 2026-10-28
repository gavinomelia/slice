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

const linear = (c) => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)

export const isLight = (color) => luminance(color) > 0.4

const gamma = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function toOklab({ r, g, b }) {
  const [R, G, B] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export function fromOklab({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: gamma(-0.0041960695 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

export function tintToward(background, color, chroma) {
  const base = toOklab(background)
  const hue = toOklab(color)
  const angle = Math.atan2(hue.b, hue.a)
  const lift = chroma * 0.5 * (base.L > 0.6 ? -1 : 1)
  return fromOklab({ L: base.L + lift, a: base.a + chroma * Math.cos(angle), b: base.b + chroma * Math.sin(angle) })
}

export function adaptToBackground(theme, background, foreground = null) {
  if (!background) return theme
  const text = foreground ?? (isLight(background) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 })
  const diff = { ...theme.diff }
  const markdown = { ...theme.markdown }
  const strength = diff.tint
  const add = parseHex(diff.addTint)
  const del = parseHex(diff.delTint)

  if (strength && add && del) {
    const tint = (color, chroma) => toHex(tintToward(background, color, chroma))
    diff.addBg = tint(add, strength.line)
    diff.delBg = tint(del, strength.line)
    diff.addWordBg = tint(add, strength.word)
    diff.delWordBg = tint(del, strength.word)
  }

  if (markdown.codeBgOpacity) {
    markdown.codeBg = toHex(blend(background, text, markdown.codeBgOpacity))
  }

  return { ...theme, diff, markdown }
}
