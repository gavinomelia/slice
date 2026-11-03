const SGR_MOUSE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/

export function parseMouse(input) {
  const match = SGR_MOUSE.exec(input)
  if (!match) return null

  const code = Number(match[1])
  const at = { x: Number(match[2]), y: Number(match[3]) }
  if (code & 64) return { type: code & 2 ? 'other' : 'wheel', delta: code & 1 ? 1 : -1, ...at }
  if ((code & 3) !== 0) return { type: 'other', ...at }
  if (match[4] === 'm') return { type: 'release', ...at }
  return { type: code & 32 ? 'drag' : 'press', ...at }
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.col <= b.col)

const ordered = ({ anchor, head }) => (before(anchor, head) ? [anchor, head] : [head, anchor])

export const isEmptySelection = ({ anchor, head }) => anchor.line === head.line && anchor.col === head.col

export function rangeOn(selection, line) {
  const [start, end] = ordered(selection)
  if (line < start.line || line > end.line) return null
  return [line === start.line ? start.col : 0, line === end.line ? end.col + 1 : Infinity]
}

export function selectedText(selection, textAt) {
  const [start, end] = ordered(selection)
  const out = []
  for (let line = start.line; line <= end.line; line++) {
    const text = textAt(line)
    if (text == null) continue
    const [from, to] = rangeOn(selection, line)
    out.push(text.slice(from, to))
  }
  return out.join('\n')
}

export function markRange(segments, from, to) {
  let at = 0
  return segments.flatMap((segment) => {
    const start = at
    const end = at + segment.text.length
    at = end
    const lo = Math.max(from, start)
    const hi = Math.min(to, end)
    if (lo >= hi) return [segment]
    return [
      { ...segment, text: segment.text.slice(0, lo - start) },
      { ...segment, text: segment.text.slice(lo - start, hi - start), selected: true },
      { ...segment, text: segment.text.slice(hi - start) },
    ].filter((part) => part.text.length > 0)
  })
}
