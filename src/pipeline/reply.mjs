/**
 * Getting an analysis out of whatever the model actually said.
 *
 * The prompt asks for a single JSON object and nothing else, and that is mostly
 * what comes back — but "mostly" is the whole problem. A reply that opens with
 * a sentence, wraps the object in a code fence, or gets cut off halfway is a
 * bad run, not a crash, and the difference between those two is this file.
 *
 * Kept apart from the CLI because it is the one piece of the analysis path that
 * is pure: given a string, it either finds the payload or it doesn't, and that
 * is testable without gh, git, or a model.
 */

/**
 * Every complete JSON object in a string, preferring one that looks like an
 * analysis.
 *
 * Scanning for balanced braces rather than reaching for the first `{` and the
 * last `}`: a reply that mentions `{}` in prose before the real object would
 * defeat the naive version, and a truncated reply would take the whole thing
 * down with it. String state is tracked so a brace inside a string literal —
 * ordinary in a `fix` field containing code — doesn't unbalance the count.
 *
 * The `slices` key is the tell. A reply may legitimately contain several
 * objects (a fenced example, a tool result), and the analysis is the one shaped
 * like an analysis rather than merely the first one to parse.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null

  const objects = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue

    let depth = 0
    let inString = false
    let escaped = false

    for (let j = i; j < text.length; j++) {
      const char = text[j]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = !inString
      else if (inString) continue
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) {
        try {
          objects.push(JSON.parse(text.slice(i, j + 1)))
        } catch {
          // Not JSON, or truncated mid-reply; keep looking.
        }
        i = j
        break
      }
    }
  }

  return objects.find((object) => object?.slices) ?? objects[0] ?? null
}

/**
 * The line in which the model said it had run out of budget, if it did.
 *
 * A usage limit is the one failure worth telling apart from the rest: nothing
 * about the diff or the config is wrong, the answer is "wait", and saving the
 * partial reply to retry-parse later would be pointless. Heuristic by
 * necessity — the wording is not ours to pin down — so it errs toward not
 * matching, and a miss only costs the nicer message.
 */
export function limitNotice(...texts) {
  for (const text of texts) {
    if (typeof text !== 'string') continue
    const match = text.match(/[^\n]*\b(?:hit your|usage|rate|session|weekly|quota)\b[^\n]*\blimit\b[^\n]*/i)
    if (match) return match[0].trim()
  }
  return null
}
