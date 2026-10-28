/**
 * Starter config files for `--init-config`.
 *
 * Written commented-out rather than empty. A config file you have to read the
 * README to fill in is one most people never fill in, and the two scopes hold
 * genuinely different settings — which is the thing worth teaching at the
 * moment somebody creates one.
 */

const REPO = `// How this repo is reviewed. Commit it: everyone reviewing this project
// gets these rules.
//
// This file CANNOT set review.provider, review.model, review.effort,
// review.allowedTools or review.promptFile. Those decide what the analysis is
// allowed to do, on the machine of whoever is reviewing a branch — so they live
// in your own config (slice --init-config user), never in a repo's.
{
  "review": {
    // Added to the built-in prompt. A bare string appends; use
    // { "replace": "..." } to swap a section out entirely.
    // "slicing": "Treat anything under db/migrate as its own slice, always.",
    // "findings": "A controller action with no policy check is a bug, not a risk.",

    // The catch-all, and where slice -p lands too.
    // "instructions": "Ignore anything under vendor/.",

    // Files the review should judge against. Relative to this repo only.
    // "conventionFiles": ["docs/CONVENTIONS.md"],

    // Deep-merged with the defaults: null removes one, a new key invents one.
    // "severities": { "nit": null }
  }
}
`

const USER = `// How slice looks and runs, for you, in every repo.
{
  // "auto" (dark or light to match your terminal), "dark", "light", or a preset plus overrides.
  "theme": {
    "preset": "auto"
    // Asked of the terminal at startup; this is only used if it does not answer.
    // "background": "#1e1e2e",
    // Diff highlights are your add/remove colours laid over the background.
    // "diff": { "opacity": { "line": 0.14, "word": 0.3 } },
    // "syntax": "tokyo-night",
    // "ui": { "accent": "magenta", "borderFocus": "magenta" }
  },

  // "layout": {
  //   "diffView": "unified",   // or "split" — v switches either way
  //   "treeWidth": 38,
  //   "findingsWidth": 58
  // },

  // These five can only be set here, never by a repo you are reviewing.
  // "review": {
  //   "provider": "claude",     // the program that produces the analysis
  //   "model": "sonnet",
  //   "effort": "low",          // "medium" reasons more, and takes ~3x as long
  //
  //   // The ENTIRE toolset given to the analysis, which runs non-interactively
  //   // — a tool that would prompt for permission instead hangs. Read-only by
  //   // default. Adding Bash really does let a review run your test suite.
  //   "allowedTools": ["Read", "Grep", "Glob"]
  // }
}
`

export const configTemplate = (scope) => (scope === 'user' ? USER : REPO)
