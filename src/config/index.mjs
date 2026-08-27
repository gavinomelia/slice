/**
 * Finding, reading, and merging slice configuration.
 *
 * Config is JSON with comments allowed, not JavaScript. That is a deliberate
 * limit: reviewing a pull request means having its branch checked out, and a
 * config format that executes would let a branch you are reviewing run code
 * the moment you open it. JSONC gets the commentable config file without the
 * arbitrary execution.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from './defaults.mjs'
import { DEFAULT_THEME_NAME, THEMES } from './themes.mjs'

export { DEFAULT_CONFIG, DEFAULT_SEVERITIES, DEFAULT_SLICE_KINDS } from './defaults.mjs'
export { THEMES } from './themes.mjs'

const REPO_NAMES = ['.slice.jsonc', '.slice.json']
const USER_NAMES = ['config.jsonc', 'config.json']

/**
 * JSON, plus comments and trailing commas.
 *
 * Comments are replaced rather than removed where they span lines, so a parse
 * error still points at roughly the right line of the file the user wrote.
 */
export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      continue
    }

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i++
      } else if (char === '\n') {
        out += char
      }
      continue
    }

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && next === '/') {
      inLine = true
      i++
    } else if (char === '/' && next === '*') {
      inBlock = true
      i++
    } else {
      out += char
    }
  }

  return out.replace(/,(\s*[}\]])/g, '$1')
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * JSON Merge Patch (RFC 7386): objects merge key by key, everything else
 * replaces, and an explicit `null` deletes.
 *
 * The `null` rule is what makes the taxonomies editable rather than
 * all-or-nothing. `{"severities": {"nit": null}}` drops nits from the review
 * without forcing you to restate the other four.
 *
 * Key order is the base's, then any new keys in the order the patch wrote
 * them — so nulling out every default and adding your own gives you full
 * control of order, which matters because both taxonomies are ordered.
 */
export function mergePatch(base, patch) {
  if (!isPlainObject(patch)) return patch
  const out = {}

  for (const [key, value] of Object.entries(isPlainObject(base) ? base : {})) {
    if (!(key in patch)) out[key] = value
    else if (patch[key] !== null) out[key] = mergePatch(value, patch[key])
  }
  for (const [key, value] of Object.entries(patch)) {
    if (key in out || value === null) continue
    out[key] = isPlainObject(value) ? mergePatch({}, value) : value
  }

  return out
}

function readConfigFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    throw new Error(`could not read config at ${path}: ${cause.message}`)
  }
  try {
    const parsed = JSON.parse(stripJsonComments(raw))
    if (!isPlainObject(parsed)) throw new Error('the top level must be an object')
    return parsed
  } catch (cause) {
    throw new Error(`could not parse config at ${path}: ${cause.message}`)
  }
}

const firstExisting = (dir, names) => names.map((name) => join(dir, name)).find((path) => existsSync(path)) ?? null

export const userConfigDir = () =>
  process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'slice') : join(homedir(), '.config', 'slice')

/** Where a `--init-config` file should be written for each scope. */
export const configTargets = (repoRoot) => ({
  repo: join(repoRoot, REPO_NAMES[0]),
  user: join(userConfigDir(), USER_NAMES[0]),
})

/**
 * Resolve the config for a repo.
 *
 * Layers, weakest first: built-in defaults, the user's file, the repo's file.
 * That ordering is the whole point — a repo states how it wants to be
 * reviewed, and a person states how they want it to look, and the repo does
 * not get to override somebody's colour scheme unless it says so explicitly.
 *
 * `explicit` (from --config or $SLICE_CONFIG) replaces both discovered
 * layers rather than stacking on them, so a one-off file is exactly what you
 * get.
 */
export function loadConfig({ cwd = process.cwd(), explicit = null } = {}) {
  const chosen = explicit ?? process.env.SLICE_CONFIG ?? null
  const sources = []
  const warnings = []

  if (chosen) {
    if (!existsSync(chosen)) throw new Error(`config file not found: ${chosen}`)
    sources.push(chosen)
  } else {
    const user = firstExisting(userConfigDir(), USER_NAMES)
    const repo = firstExisting(cwd, REPO_NAMES)
    if (user) sources.push(user)
    if (repo) sources.push(repo)
  }

  let config = DEFAULT_CONFIG
  for (const path of sources) {
    const patch = readConfigFile(path)
    warnings.push(...unknownKeys(patch, path))
    config = mergePatch(config, patch)
  }

  return { config, sources, warnings }
}

/**
 * A typo in a config file is silently a no-op, which is the worst way for
 * config to fail. Only the top two levels are checked — below that the values
 * are free-form colours and prose.
 */
function unknownKeys(patch, path) {
  const found = []
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_CONFIG)) {
      found.push(`${path}: unknown setting "${key}"`)
      continue
    }
    // theme accepts a preset name as a bare string, so it has no fixed keys.
    if (key === 'theme' || !isPlainObject(value) || !isPlainObject(DEFAULT_CONFIG[key])) continue
    for (const inner of Object.keys(value)) {
      if (!(inner in DEFAULT_CONFIG[key])) found.push(`${path}: unknown setting "${key}.${inner}"`)
    }
  }
  return found
}

/**
 * Turn the `theme` setting into a full theme object.
 *
 * Accepts a preset name, a bare object, or a preset plus overrides via
 * `{ preset: "light", ui: { accent: "magenta" } }` — the last of which is what
 * almost everyone actually wants.
 */
export function resolveTheme(theme) {
  if (typeof theme === 'string') return THEMES[theme] ?? THEMES[DEFAULT_THEME_NAME]
  if (!isPlainObject(theme)) return THEMES[DEFAULT_THEME_NAME]

  const { preset, ...overrides } = theme
  const base = THEMES[preset] ?? THEMES[DEFAULT_THEME_NAME]
  return mergePatch(base, overrides)
}

/**
 * Apply a per-section prompt override.
 *
 * A bare string appends, because adding a house rule to a section is the
 * common case and should not need a wrapper object. `{ replace }` swaps the
 * section out; `{ append }` is the explicit spelling of the default.
 */
export function promptSection(override, builtin) {
  if (!override) return builtin
  if (typeof override === 'string') return `${builtin}\n${override.trim()}\n`
  if (typeof override.replace === 'string') return `${override.replace.trim()}\n`
  if (typeof override.append === 'string') return `${builtin}\n${override.append.trim()}\n`
  return builtin
}

/** Severity and slice-kind keys, in the order the config defines them. */
export const severityNames = (config) => Object.keys(config.review.severities ?? {})
export const sliceKindNames = (config) => Object.keys(config.review.sliceKinds ?? {})
