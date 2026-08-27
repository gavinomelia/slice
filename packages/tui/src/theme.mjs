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
import { DEFAULT_CONFIG, DEFAULT_SEVERITIES, DEFAULT_SLICE_KINDS, loadConfig, resolveTheme } from '@pr-review/config'

/** Drawn for a severity the manifest carries no definition for. */
const UNKNOWN_SEVERITY = { glyph: '·', color: 'gray' }

export function viewerConfig({ review, cwd = process.cwd() }) {
  let config
  let warnings = []
  try {
    ;({ config, warnings } = loadConfig({ cwd }))
  } catch (error) {
    // A broken config file is not worth refusing to show the review over. Fall
    // all the way back to the built-in defaults — retrying discovery could hit
    // the same bad file again — and surface the reason in the status line.
    config = DEFAULT_CONFIG
    warnings = [error.message]
  }

  const severities = review.taxonomy?.severities ?? config.review.severities ?? DEFAULT_SEVERITIES
  const sliceKinds = review.taxonomy?.sliceKinds ?? config.review.sliceKinds ?? DEFAULT_SLICE_KINDS

  return {
    theme: resolveTheme(config.theme),
    layout: config.layout,
    severities,
    sliceKinds,
    severity: (name) => severities[name] ?? UNKNOWN_SEVERITY,
    sliceKind: (name) => sliceKinds[name] ?? {},
    warnings,
  }
}
