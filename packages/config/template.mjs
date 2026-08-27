/**
 * Starter config files for `pr-review --init-config`.
 *
 * Everything is commented out. A config that ships with values already set
 * makes people delete things to get back to the default; a config that ships
 * with nothing set makes them uncomment what they actually want, and leaves
 * the default visible next to it either way.
 */

const REPO = `{
  // How this repo gets reviewed. Checked in, because slicing and what counts
  // as a finding are properties of a codebase, not of whoever is reviewing.
  //
  // Every section below is optional. Delete what you do not use.
  "review": {
    // A bare string ADDS to the built-in instructions for that section.
    // { "replace": "..." } swaps the built-in section out entirely.

    // How the change is grouped into behavioral slices.
    // "slicing": "Treat anything under db/migrate as its own slice, always.",

    // How the walkthrough and per-file notes are written.
    // "summaries": "Name the Rails engine a slice lives in, in the first line.",

    // What is worth reporting, and what is noise.
    // "findings": {
    //   "append": "We use Pundit everywhere. A controller action with no policy check is a bug, not a risk."
    // },

    // How findings get anchored to lines. Rarely worth touching.
    // "anchoring": "",

    // How the repo's stated standards are weighed.
    // "conventions": "",

    // Appended to the very end of the prompt. The catch-all.
    // "instructions": "Ignore anything under vendor/.",

    // The finding taxonomy, defining what the model may report and how the
    // viewer draws it. Deep-merged with the defaults: set one field to
    // recolour, set a key to null to remove that severity entirely, add a key
    // to invent one. Ordered most to least serious.
    // "severities": {
    //   "nit": null,
    //   "security": {
    //     "description": "an exploitable hole. Name the attacker and what they get.",
    //     "glyph": "!",
    //     "color": "red"
    //   }
    // },

    // The kinds a slice can be, same merge rules.
    // "sliceKinds": {},

    // Files stating the standards to judge against. null auto-discovers
    // .github/instructions/*.md and docs/CONVENTIONS.md.
    // "conventionFiles": ["docs/REVIEW_STANDARDS.md"],

    // Tools the analysis may use. Read-only by default: the run is
    // non-interactive, so anything that asks permission hangs forever. Add an
    // MCP server here if your conventions tell the review to check a ticket.
    // "allowedTools": ["Read", "Grep", "Glob", "mcp__linear__get_issue"],

    // Passed to \`claude --model\`. null uses your CLI default.
    // "model": "opus",

    // Replace the ENTIRE prompt with a file, relative to the repo root. The
    // escape hatch. Placeholders substituted before sending:
    //
    //   {{patchPath}} {{filesPath}} {{conventionFiles}}
    //   {{severities}} {{sliceKinds}} {{outputSchema}}
    //   {{target.title}} {{target.author}} {{target.repo}}
    //   {{target.number}} {{target.baseRef}} {{target.headRef}}
    //
    // Include {{outputSchema}} or the result will not parse.
    // "promptFile": ".github/pr-review-prompt.md"
  }
}
`

const USER = `{
  // How the terminal viewer looks. Yours, not any one repo's.

  // A preset name — "dark" or "light" — or an object, or both at once:
  // "theme": "light",
  "theme": {
    "preset": "dark",

    // Any Shiki theme id, plus "pierre-dark" and "pierre-light". This is the
    // one setting that recolours the code itself rather than the chrome.
    // "syntax": "tokyo-night",

    // "diff": {
    //   "addBg": "#0b2c18",
    //   "delBg": "#3a1114",
    //   "addWordBg": "#1c5c31",   // intra-line word changes, tinted harder
    //   "delWordBg": "#6b1f26",
    //   "addMark": "#3fb950",     // the + and - in the gutter
    //   "delMark": "#f85149",
    //   "lineNumber": "gray",
    //   "hunk": "gray"
    // },

    // "ui": {
    //   "accent": "cyan",
    //   "muted": "gray",
    //   "border": "gray",
    //   "borderFocus": "cyan",    // the focused pane's border
    //   "cursor": "cyan",
    //   "draft": "green",         // lines carrying an unposted comment
    //   "heading": "gray",
    //   "scrollTrack": "gray",
    //   "scrollThumb": "cyan"
    // },

    // "risk": { "low": "green", "medium": "yellow", "high": "red" },

    // "markdown": {
    //   "code": "cyan",
    //   "codeBg": "#2c2f36",
    //   "link": "blue",
    //   "fence": "green",         // fenced blocks with no known language
    //   "quote": "gray",
    //   "rule": "gray"
    // }
  }

  // Colours are terminal palette names ("cyan", "gray") or hex ("#1c5c31").
  // Palette names follow your terminal theme; hex does not. Both downsample
  // automatically on terminals without truecolour.

  // "layout": {
  //   "treeWidth": 38,        // columns, clamped to a share of the terminal
  //   "findingsWidth": 58,
  //   "tabWidth": 4,          // columns a tab expands to in a diff
  //   "hScrollStep": 8        // columns h/l scroll the diff sideways by
  // }
}
`

export const configTemplate = (scope) => (scope === 'user' ? USER : REPO)
