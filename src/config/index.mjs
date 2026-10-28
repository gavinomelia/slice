/**
 * Finding, reading, and merging slice configuration.
 *
 * Config is JSON with comments allowed, not JavaScript. That is a deliberate
 * limit: reviewing a pull request means having its branch checked out, and a
 * config format that executes would let a branch you are reviewing run code
 * the moment you open it. JSONC gets the commentable config file without the
 * arbitrary execution.
 *
 * The same reasoning governs which layer may set what. A repo's `.slice.jsonc`
 * arrives with the branch under review, so it is attacker-controlled input in
 * exactly the case this tool exists for. It may say how the code should be
 * reviewed; it may not say what the analysis is allowed to *do*.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

import { DEFAULT_CONFIG } from './defaults.mjs'
import { DEFAULT_THEME_NAME, THEMES } from './themes.mjs'
import { adaptToBackground, isLight } from './color.mjs'

export { DEFAULT_CONFIG, DEFAULT_SEVERITIES, DEFAULT_SLICE_KINDS } from './defaults.mjs'
export { THEMES } from './themes.mjs'

const REPO_NAMES = ['.slice.jsonc', '.slice.json']
const USER_NAMES = ['config.jsonc', 'config.json']

/**
 * Settings that decide what the analysis may do, rather than what it should
 * look for. Only a config you own may set these.
 *
 * `allowedTools` is the whole toolset handed to a non-interactive agent, so a
 * repo that could add `Bash` or `Write` would be running code on the machine of
 * anyone who reviewed it. `promptFile` names a file whose contents go into the
 * prompt, which is the same hole pointed the other way — it reads. `provider`
 * decides which program gets spawned at all; the registry means it can only
 * ever name one slice ships, but which one is still not a branch's call.
 * `model` and `effort` only spend your money, but they are the same kind of
 * decision and belong on the same side of the line.
 */
export const PRIVILEGED_REVIEW_KEYS = ['provider', 'model', 'effort', 'allowedTools', 'promptFile']

/** Settings about how the viewer draws, as opposed to how the review is made. */
export const APPEARANCE_KEYS = ['theme', 'layout']

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

const pick = (patch, keys) => Object.fromEntries(Object.entries(patch).filter(([key]) => keys.includes(key)))
const omit = (patch, keys) => Object.fromEntries(Object.entries(patch).filter(([key]) => !keys.includes(key)))

/** Does this relative path stay inside the repo once resolved? */
function insideRepo(repoRoot, candidate) {
  if (typeof candidate !== 'string' || isAbsolute(candidate)) return false
  const full = resolve(repoRoot, candidate)
  return full === repoRoot || full.startsWith(repoRoot + sep)
}

/**
 * Strip from a repo's config everything a repo is not allowed to decide.
 *
 * Dropped rather than rejected: refusing to run because a repo asked for
 * something it cannot have would let any branch break the tool for everyone
 * reviewing it. The warning is printed, the setting is ignored, the review
 * proceeds.
 */
function trustRepoConfig(patch, { path, repoRoot, warnings }) {
  if (!isPlainObject(patch.review)) return patch
  const review = { ...patch.review }
  const yours = join(userConfigDir(), USER_NAMES[0])

  for (const key of PRIVILEGED_REVIEW_KEYS) {
    if (!(key in review)) continue
    delete review[key]
    warnings.push(
      `${path}: ignoring "review.${key}" — a repo cannot change how the analysis is run. Set it in ${yours} if you want it.`,
    )
  }

  if (Array.isArray(review.conventionFiles)) {
    const kept = review.conventionFiles.filter((candidate) => insideRepo(repoRoot, candidate))
    for (const candidate of review.conventionFiles) {
      if (!kept.includes(candidate)) {
        warnings.push(`${path}: ignoring convention file ${JSON.stringify(candidate)} — it points outside the repo`)
      }
    }
    review.conventionFiles = kept
  }

  return { ...patch, review }
}

/**
 * Resolve the config for a repo.
 *
 * Two layers, and which one wins depends on what is being decided:
 *
 * - **How the code is reviewed** — the repo wins. A project states its own
 *   conventions, and someone reviewing it should get them.
 * - **How the viewer looks** — you win. A repo may suggest a theme for someone
 *   who has no preference, but it does not get to repaint your terminal.
 * - **What the analysis is allowed to do** — only you, ever. See
 *   `PRIVILEGED_REVIEW_KEYS`.
 *
 * `explicit` (from --config or $SLICE_CONFIG) replaces both discovered layers
 * rather than stacking on them, and is trusted in full: you named the file, so
 * nothing in it is withheld.
 */
export function loadConfig({ cwd = process.cwd(), explicit = null } = {}) {
  const chosen = explicit ?? process.env.SLICE_CONFIG ?? null
  const warnings = []

  if (chosen) {
    if (!existsSync(chosen)) throw new Error(`config file not found: ${chosen}`)
    const patch = readConfigFile(chosen)
    warnings.push(...unknownKeys(patch, chosen))
    return { config: mergePatch(DEFAULT_CONFIG, patch), sources: [chosen], warnings }
  }

  const userPath = firstExisting(userConfigDir(), USER_NAMES)
  const repoPath = firstExisting(cwd, REPO_NAMES)
  const sources = [userPath, repoPath].filter(Boolean)

  const user = userPath ? readConfigFile(userPath) : {}
  const repoRaw = repoPath ? readConfigFile(repoPath) : {}
  for (const [patch, path] of [
    [user, userPath],
    [repoRaw, repoPath],
  ]) {
    if (path) warnings.push(...unknownKeys(patch, path))
  }

  const repo = repoPath ? trustRepoConfig(repoRaw, { path: repoPath, repoRoot: cwd, warnings }) : {}

  let config = DEFAULT_CONFIG
  config = mergePatch(config, pick(repo, APPEARANCE_KEYS))
  config = mergePatch(config, pick(user, APPEARANCE_KEYS))
  config = mergePatch(config, omit(user, APPEARANCE_KEYS))
  config = mergePatch(config, omit(repo, APPEARANCE_KEYS))

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
export function resolveTheme(theme, background = null) {
  const presetFor = (name) =>
    name === 'auto' ? THEMES[background && isLight(background) ? 'light' : 'dark'] : THEMES[name]

  if (typeof theme === 'string') return adaptToBackground(presetFor(theme) ?? THEMES[DEFAULT_THEME_NAME], background)
  if (!isPlainObject(theme)) return adaptToBackground(THEMES[DEFAULT_THEME_NAME], background)

  const { preset, ...overrides } = theme
  const base = presetFor(preset) ?? THEMES[DEFAULT_THEME_NAME]
  return adaptToBackground(mergePatch(base, overrides), background)
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
