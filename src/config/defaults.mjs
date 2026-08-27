/**
 * Everything slice does that is a judgment call rather than a fact, in one
 * place.
 *
 * Two halves, and the split matters:
 *
 * - `review` shapes the analysis. It belongs to the repo, because how a change
 *   should be sliced and what counts as a finding are properties of a codebase
 *   and its team.
 * - `theme` and `layout` shape the terminal viewer. They belong to a person,
 *   because a colour scheme is a property of whoever is looking at it.
 *
 * Both can be set in either place; this is a note on where each one usually
 * wants to live, not a restriction.
 */

/**
 * The finding taxonomy.
 *
 * One entry defines a severity everywhere at once: `description` is what the
 * model is told the severity means and what evidence it demands, `glyph` and
 * `colour` are how the viewer draws it. Delete a key and that severity stops
 * existing — the prompt stops offering it and `merge.mjs` stops accepting it.
 *
 * Order is significant. Severities run most to least serious, and an
 * unrecognised severity from the model falls back to the *last* one, so the
 * bottom entry should always be the one it is safest to be wrong about.
 */
export const DEFAULT_SEVERITIES = {
  bug: {
    description: 'wrong behavior now, on a reachable path. You can name the input that breaks it.',
    glyph: '●',
    color: 'red',
  },
  risk: {
    description:
      'breaks callers, data, or performance under load. You have read the callers or considered the row count.',
    glyph: '◆',
    color: 'yellow',
  },
  cleanup: {
    description:
      'correct but poorly built: antipattern, duplication, logic at the wrong altitude, business logic in a template. You can point at the local pattern it should have followed.',
    glyph: '▲',
    color: 'cyan',
  },
  nit: {
    description: 'taste. At most two or three in the entire review.',
    glyph: '▪',
    color: 'gray',
  },
  question: {
    description: 'you cannot resolve it without author intent, and you looked first.',
    glyph: '?',
    color: 'magenta',
  },
}

/**
 * The kinds a slice can be.
 *
 * Same deal as severities, except the fallback is the *first* entry — an
 * unrecognised kind is treated as ordinary behavior rather than as something
 * special, which is the safe direction to be wrong in.
 */
export const DEFAULT_SLICE_KINDS = {
  behavior: {
    description: 'a real behavioral change. The default, and most slices.',
    color: null,
  },
  skim: {
    description: 'lockfiles, generated output, vendored assets, bulk translation dumps. One slice, reviewed as a lump.',
    color: 'gray',
  },
  unaccounted: {
    description:
      'files that fit no behavioral slice, or that the PR description does not explain. Scope creep and leftover debugging live here, so surface them rather than burying them in a related slice.',
    color: 'yellow',
  },
}

export const DEFAULT_CONFIG = {
  review: {
    /** `claude --model`. null uses whatever the CLI is configured to. */
    model: null,

    /**
     * Tools the analysis may use.
     *
     * Read-only by design: the run is non-interactive, so a tool that triggers
     * a permission prompt hangs forever with nobody to answer it. Add an MCP
     * server here (`mcp__linear__*`) if your conventions ask the review to
     * check a ticket — without it, that instruction is silently a no-op.
     */
    allowedTools: ['Read', 'Grep', 'Glob'],

    /**
     * Files stating the standards to judge against.
     *
     * null auto-discovers `.github/instructions/*.md` and `docs/CONVENTIONS.md`.
     * An array uses exactly those paths, relative to the repo root.
     */
    conventionFiles: null,

    severities: DEFAULT_SEVERITIES,
    sliceKinds: DEFAULT_SLICE_KINDS,

    /**
     * Per-section prompt overrides.
     *
     * A string, or `{ append }`, adds to the built-in section. `{ replace }`
     * swaps it out entirely. The sections are the parts of the review that are
     * a matter of taste; the output schema is not among them, because the
     * viewer and the validator both depend on its shape.
     */
    conventions: '',
    slicing: '',
    summaries: '',
    findings: '',
    anchoring: '',

    /** Free text appended to the very end of the prompt. The catch-all. */
    instructions: '',

    /**
     * Path to a file that replaces the whole prompt, relative to the repo root.
     *
     * The escape hatch when the sections aren't enough. Placeholders are
     * substituted before it is sent — see the template for the list. You are
     * responsible for asking for the output schema; nothing else will.
     */
    promptFile: null,
  },

  /** A preset name, or an object, or a preset with overrides. See themes.mjs. */
  theme: 'dark',

  layout: {
    /** Columns, clamped to a share of the terminal so a narrow window still works. */
    treeWidth: 38,
    findingsWidth: 58,
    /** Columns a tab expands to in a diff. */
    tabWidth: 4,
    /** Columns `h`/`l` scroll the diff sideways by. */
    hScrollStep: 8,
  },
}
