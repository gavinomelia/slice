const FILE_HEADER = /^diff --git .*$/gm

function unquote(path) {
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      return JSON.parse(path)
    } catch {
      return path.slice(1, -1)
    }
  }
  return path
}

function stripPrefix(path) {
  const bare = unquote(path)
  if (bare === '/dev/null') return null
  return bare.replace(/^[ab]\//, '')
}

/** Paths from the ---/+++ lines when present; they survive spaces and quoting
 *  better than splitting the `diff --git` line, which is ambiguous by design. */
function pathsFromBody(lines) {
  let oldPath = null
  let newPath = null
  for (const line of lines) {
    if (line.startsWith('@@')) break
    if (line.startsWith('--- ')) oldPath = stripPrefix(line.slice(4).trim())
    else if (line.startsWith('+++ ')) newPath = stripPrefix(line.slice(4).trim())
  }
  return { oldPath, newPath }
}

/** Fallback for headers with no ---/+++ (pure renames, mode changes, binaries).
 *  Relies on the a/ b/ prefixes, so it only has to handle the common case. */
function pathsFromHeader(headerLine) {
  const rest = headerLine.slice('diff --git '.length)
  const quoted = rest.match(/^"(.*)" "(.*)"$/)
  if (quoted) {
    return { oldPath: stripPrefix(`"${quoted[1]}"`), newPath: stripPrefix(`"${quoted[2]}"`) }
  }
  const midpoint = rest.indexOf(' b/')
  if (midpoint === -1) return { oldPath: null, newPath: null }
  return {
    oldPath: stripPrefix(rest.slice(0, midpoint)),
    newPath: stripPrefix(rest.slice(midpoint + 1)),
  }
}

function countChanges(lines) {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function parseFile(chunk) {
  const lines = chunk.split('\n')
  const header = lines[0]

  const body = pathsFromBody(lines)
  const fallback = pathsFromHeader(header)
  const oldPath = body.oldPath ?? fallback.oldPath
  const newPath = body.newPath ?? fallback.newPath

  const isBinary = lines.some((l) => l.startsWith('Binary files ') || l.startsWith('GIT binary patch'))
  const renamed = lines.some((l) => l.startsWith('rename from '))

  let status
  if (isBinary) status = 'binary'
  else if (lines.some((l) => l.startsWith('new file mode'))) status = 'added'
  else if (lines.some((l) => l.startsWith('deleted file mode'))) status = 'deleted'
  else if (renamed) status = 'renamed'
  else status = 'modified'

  // A deletion has no new path; everything else is keyed by where the file
  // lives after the change.
  const path = newPath ?? oldPath
  if (!path) return null

  const { additions, deletions } = countChanges(lines)

  return {
    path,
    prevPath: renamed ? oldPath : null,
    status,
    additions,
    deletions,
    patch: chunk.endsWith('\n') ? chunk : `${chunk}\n`,
  }
}

/**
 * Split a multi-file unified diff into self-contained per-file patches.
 * Each returned `patch` is independently parseable by @pierre/diffs, which
 * lets the viewer render one file at a time without re-parsing the whole PR.
 */
export function splitPatch(raw) {
  if (!raw || !raw.trim()) return []

  const starts = []
  FILE_HEADER.lastIndex = 0
  let match
  while ((match = FILE_HEADER.exec(raw)) !== null) starts.push(match.index)
  if (starts.length === 0) return []

  const files = []
  for (let i = 0; i < starts.length; i++) {
    const chunk = raw.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined)
    const parsed = parseFile(chunk)
    if (parsed) files.push(parsed)
  }
  return files
}
