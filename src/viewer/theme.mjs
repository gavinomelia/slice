/**
 * What the viewer needs from config, resolved once at startup.
 *
 * Two sources, split by what each one is the authority on:
 *
 * - The **config file** owns appearance. It is a live preference, so a colour
 *   change should show up the next time you open any review, including old
 *   ones.
 * - The **review manifest** owns the taxonomy. Severities are baked into the
 *   review when the analysis runs, so reading them from config instead would
 *   mean a review re-opened after a config change renders severities it was
 *   never allowed to emit — or worse, silently drops the glyph for ones it did.
 */
import { DEFAULT_CONFIG, DEFAULT_SEVERITIES, DEFAULT_SLICE_KINDS, loadConfig, resolveTheme } from '../config/index.mjs'

/** Drawn for a severity the manifest carries no definition for. */
const UNKNOWN_SEVERITY = { glyph: '·', color: 'gray' }

/** A status no theme names draws as blank, the way `modified` does. */
const UNKNOWN_STATUS = { glyph: ' ', color: null }

export function viewerConfig({
  review,
  cwd = process.cwd(),
  config: resolved = null,
  warnings: given = [],
  background = null,
  foreground = null,
}) {
  let config = resolved
  // Anything the CLI printed before the viewer started is gone the moment the
  // alternate screen opens, so its warnings are carried in and shown here
  // instead — a repo trying to grant itself tools is worth actually seeing.
  let warnings = [...given]

  // The CLI has almost always resolved the config already, and it is the only
  // one that knows about --config. Re-discovering here instead is what made
  // `slice --config mine.jsonc` apply the review settings from that file and
  // then silently ignore its theme.
  if (!config) {
    try {
      const loaded = loadConfig({ cwd })
      config = loaded.config
      warnings = [...warnings, ...loaded.warnings]
    } catch (error) {
      // A broken config file is not worth refusing to show the review over.
      // Fall all the way back to the built-in defaults — retrying discovery
      // could hit the same bad file again — and surface the reason in the
      // status line.
      config = DEFAULT_CONFIG
      warnings = [...warnings, error.message]
    }
  }

  const severities = review.taxonomy?.severities ?? config.review.severities ?? DEFAULT_SEVERITIES
  const sliceKinds = review.taxonomy?.sliceKinds ?? config.review.sliceKinds ?? DEFAULT_SLICE_KINDS

  // Unlike the taxonomies, a file's status comes from the patch rather than the
  // analysis, so it is appearance all the way down and belongs to the theme.
  const theme = resolveTheme(config.theme, background, foreground)

  return {
    theme,
    layout: config.layout,
    severities,
    sliceKinds,
    severity: (name) => severities[name] ?? UNKNOWN_SEVERITY,
    sliceKind: (name) => sliceKinds[name] ?? {},
    fileStatus: (name) => theme.fileStatus?.[name] ?? UNKNOWN_STATUS,
    warnings,
  }
}
