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
    provider: 'claude',

    model: 'sonnet',

    effort: 'low',

    allowedTools: ['Read', 'Grep', 'Glob'],

    conventionFiles: null,

    severities: DEFAULT_SEVERITIES,
    sliceKinds: DEFAULT_SLICE_KINDS,

    conventions: '',
    slicing: '',
    summaries: '',
    walkthrough: '',
    findings: '',
    anchoring: '',

    instructions: '',

    promptFile: null,
  },

  theme: 'auto',

  layout: {
    diffView: 'unified',

    treeWidth: 38,
    findingsWidth: 58,
    tabWidth: 4,
    hScrollStep: 8,
  },
}
