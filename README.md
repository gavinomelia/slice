# slice

[![CI](https://github.com/gavinomelia/slice/actions/workflows/ci.yml/badge.svg)](https://github.com/gavinomelia/slice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A pull request is not a pile of files. It is a few behavioral changes that
happen to touch many directories. slice reads it that way: the diff in your
terminal, with the changed files grouped by behavioral slice instead of by
path.

```
slice 1679        # browse the diff for PR #1679
slice my-branch   # that branch's PR, or diff the branch if it has none
slice             # the PR for the current branch, or the branch diff
slice --branch    # local branch vs its base, before a PR exists
slice 1679 --ai   # add the AI-analyzed review: slices, summaries, findings
slice -p "..."    # analyze, with something extra to say about how
```

The positional argument is a PR number or a branch name. `gh` resolves
either, so `slice ccc-642-implement-posts-on-portal` finds that branch's PR,
or diffs the branch if there isn't one. A branch you have fetched but never
checked out works too.

By default slice just opens the diff. No model runs. Pass `--ai` for the
analyzed review. Without it, files are not grouped into slices, but they are
still ordered by when they were first committed, not alphabetically, which is
usually close to the order the change was built in.

## Saying something about this review

`-p` adds a note to the review prompt for one run, and implies `--ai`:

```
slice -p "Group things by file type alphabetically, and review for security in particular"
slice 1679 -p "The migration is the risky part, check it against the backfill job"
slice -p "Ignore the CSS" -p "Be harsh about the API contract"
```

It lands at the end of the prompt, after the sections that decide slicing,
summaries, and findings. It adds to the repo's own config rather than
replacing it, so a one-off note never drops your team's standing rules.
Repeat the flag to add more than one note.

A prompted run is cached separately from a plain one, so the two never
overwrite each other.

If a rule should apply every time, put it in `.slice.jsonc` instead, under
`review.instructions` or the section it belongs to.

## Slices

A slice is the set of files that together deliver one behavioral change. The
migration, the model, the controller, the view, and the spec that make
"admins can archive a form" work are one slice, not five files in five
directories.

Instead of reviewing `app/models/`, then `app/controllers/`, then `spec/`,
and reassembling the feature in your head, you read one complete change at a
time, in an order that makes each one make sense.

## Install

```
npm install -g @gavinomelia/slice
```

Requires Node 20+, macOS or Linux, the [GitHub CLI](https://cli.github.com)
(`gh`, authenticated), and [Claude Code](https://claude.com/claude-code)
(`claude`). There is no API key to manage; analysis runs through your
existing Claude Code session. `claude` is only needed for `--ai`; without it
slice is a diff viewer.

Windows is not supported: `gh` and `claude` are spawned without a shell, so
the `.cmd` shims npm installs there do not resolve. It works under WSL.

## How it works

Claude Code produces the analysis by reading your repo, not by an API call
against the diff alone. It can read the callers of a changed method, the
sibling implementation a new file should match, and your own conventions.

slice finds convention files per repo and names them in the prompt:
`.github/instructions/*.md` (the Copilot convention; `claude` does not load
these on its own, unlike `AGENTS.md`) and `docs/CONVENTIONS.md`. Each run
prints what it judged against, and findings cite the convention by name.

```
gh pr diff → split per file (deterministic, in JS)
                  │
                  ├─→ claude -p → analysis.json   (slices, summaries, findings)
                  │
                  └─→ merge + validate → review.json → viewer
```

The model never reproduces diff text. It only refers to files by path and
lines by number. Diff content comes from `git`, so the code you review is
always exactly what the PR contains.

`src/pipeline/merge.mjs` checks everything the model returns against the
patch:

- A finding on a path outside the diff is dropped.
- A finding on a line outside the diff is demoted to file level, not
  discarded, so a real bug with a bad anchor still reaches you.
- Files the analysis forgot to slice go into their own `Unsliced` bucket.

Each run prints its corrections. Many corrections mean the analysis was
sloppy.

## What the analysis is trusted with

`--ai` runs an agent inside a checkout of code somebody else wrote, so it is
worth being precise about limits.

Its tools are `Read`, `Grep`, and `Glob`: read-only, which is the default
because the run is non-interactive. A tool that asks permission would hang
forever with nobody to answer. Only your own config can widen that set,
never the repo's (see [What a repo may not decide](#what-a-repo-may-not-decide)).

The diff itself is untrusted text read by a model whose output you are about
to trust. A pull request can contain prose aimed at the review rather than
at you, and nothing here detects that. What the design does instead is
bound the damage:

- The model never reproduces diff text, so it cannot alter the code you
  read. Every line in the viewer comes from `git`.
- Every path and line number it emits is checked against the patch, so it
  cannot point you at a file outside the diff.
- It cannot write, run commands, or reach the network with the default
  toolset.

So the worst case is a quiet review, not a false one. Absence of findings is
not evidence. That is true of any review tool, which is why slice opens the
diff by default and treats the analysis as an optional second opinion.

## Keys

`1` `2` `3` jump to a panel and `tab` cycles between them; the focused one
has a heavy border. `j` `k` move within it: the tree's selection, the diff's
line cursor, or the findings pane's scroll.

| | |
|---|---|
| `1` `2` `3` `tab` | focus slices / diff / findings |
| `j` `k` `↑` `↓` | move within the focused panel |
| `space` `b` | page within the focused panel |
| `h` `l` `←` `→` | scroll the diff sideways, `0` back to the left |
| `v` | switch the diff between unified and split |
| `H` `L` | in split, which column `c` comments on |
| `z` | zoom the diff to the full terminal |
| `[` `]` | previous / next slice |
| `n` `p` | next / previous finding, anywhere in the review |
| `x` | mark the selected file — or whole slice — read, and move on |
| `c` | comment on the diff's cursor line |
| `s` `A` `R` | submit as comment / approve / request changes |
| `q` `ctrl-c` | quit |

`escape` dismisses the status line rather than quitting: it is the key you
press to back out of something, and quitting would throw away unposted
drafts.

Code is never wrapped, so long lines are truncated with a `›` at the edge
and reached with `h` `l`. `z` hides the side panels and gives the diff the
whole terminal.

`v` switches between unified and split. Split pairs each run of deletions
with the additions that follow, old on the left, new on the right: the same
guess every side-by-side viewer makes, since a diff records that three lines
became two, not which became which. It costs half the width per column, so
`z` and `v` go together on anything but a wide terminal. `H` and `L` pick the
column `c` comments on; a line that exists in only one of them takes the
cursor regardless.

Selecting a slice shows its card: the walkthrough, its files, and every
finding it covers, instead of a diff. The tree's last row is the draft
review: what is staged and what will happen to it on submit.

## Keeping your place

The tree says what happened to each file — `+` added, `-` deleted, `→`
renamed, `◆` binary. Modified files get no glyph, because they are nearly
every row and marking them would bury the few worth noticing.

`x` marks the selected file read and moves to the next one that is not, so a
review is one repeated keystroke and files you have already done are stepped
over rather than visited again. On a slice header it marks every file in the
slice. A read file gets a `✓` in the tree's left margin and its name recedes;
its findings do not, because a file you have already looked at can still be
the one with the bug. A slice header shows a `✓` in place of its `·` once
every file under it is read.

Pressing `x` on something already read unmarks it and stays put — undoing
something and then being moved away from it is how you lose track of what you
just undid. A part-read slice marks the rest rather than clearing what is
done, so unmarking a whole slice takes two presses.

Read state persists between sessions, beside the review in the cache. It is
stored against a digest of each file's diff, so pushing a fix to a PR and
re-opening it brings that file back unread rather than claiming you have seen
a change that did not exist yet. Nothing else in the review is disturbed.

## Commenting and posting back to GitHub

`c` opens `$EDITOR`, seeded with any finding anchored to that line and the
surrounding diff carried in as comment lines, the way `git commit --verbose`
does. Save to stage the draft, save it empty to discard. Drafts persist
beside the review in the cache, and drafted lines carry a bar in the gutter.

`s` `A` `R` post the whole batch as one PR review. `gh pr review` cannot
attach line comments, so this goes through
`POST /repos/{owner}/{repo}/pulls/{n}/reviews` with all comments in one
request.

Each of those three opens `$EDITOR` for the review body first, and saving it
empty cancels the submit, the way `git commit` treats an empty message. They
are single keystrokes that publish to somebody else's pull request, with no
unsend, so the editor is also the confirmation step.

Two constraints worth knowing:

- GitHub rejects a comment on any line outside the diff, and returns a 422
  for the whole batch without saying which comment caused it. Drafts with no
  valid line anchor go into the review body instead.
- GitHub rejects `APPROVE` and `REQUEST_CHANGES` on your own PR. Both are
  downgraded to a plain comment instead of failing the post.

## Configuration

Two things are configurable, and they belong in different places.

```
slice --init-config        # .slice.jsonc in the repo, how it reviews
slice --init-config user   # ~/.config/slice/config.jsonc, how it looks
slice --print-config       # the resolved result, and which files produced it
```

| | decided by | because |
|---|---|---|
| how the code is reviewed | the repo | a project states its own conventions |
| how the viewer looks | you | a repo may suggest a theme; it does not repaint your terminal |
| what the analysis may do | you, only | see below |

`--config <path>` replaces both discovered layers instead of stacking on
them, and is trusted in full since you named the file.

The format is JSON with comments and trailing commas allowed, not
JavaScript. Reviewing a PR means checking out its branch, and a config
format that executes would let that branch run code the moment you open it.

### What a repo may not decide

A repo's `.slice.jsonc` arrives with the branch under review, so it is
attacker-controlled input in exactly the case this tool exists for. slice
ignores five settings anywhere but your own config, with a warning:

```
review.allowedTools    the entire toolset handed to the analysis
review.promptFile      a file whose contents go into the prompt
review.provider        which program the analysis runs in
review.model
review.effort
```

Without that rule, a pull request could hand itself `Bash` and `Write` on
the machine of anyone who reviewed it. `review.conventionFiles` follows a
weaker version of the same rule: a repo may only name paths inside itself.

Set any of these in `~/.config/slice/config.jsonc` to apply them to every
repo you review.

### Reviewing

Every section of the prompt can be overridden. A plain string appends to the
built-in instructions; `{ "replace": "..." }` swaps the section out.

In `.slice.jsonc`, committed to the repo:

```jsonc
{
  "review": {
    "slicing": "Treat anything under db/migrate as its own slice, always.",
    "findings": { "append": "A controller action with no Pundit policy check is a bug, not a risk." },
    "instructions": "Ignore anything under vendor/.",   // slice -p adds to this

    "severities": { "nit": null },        // stop reporting nits entirely
    "conventionFiles": ["docs/CONVENTIONS.md"]
  }
}
```

In `~/.config/slice/config.jsonc`, where settings that decide what the
analysis may do must live:

```jsonc
{
  "review": {
    "allowedTools": ["Read", "Grep", "Glob", "mcp__linear__get_issue"],
    "provider": "claude",                 // the only one today
    "model": "opus",
    "effort": "medium"                    // more reasoning, about 3x the wall-clock
  }
}
```

`severities` and `sliceKinds` define a taxonomy in one place, and it flows
into the prompt, the output schema, the validator, and the viewer's glyphs
together, so they cannot drift apart. They merge with the defaults: set a
field to recolor it, set a key to `null` to remove it, add a key to invent
one. An unrecognized severity becomes the least serious one; an unrecognized
slice kind becomes ordinary behavior.

slice writes the taxonomy into `review.json`, so a cached review keeps the
severities it was produced under, not whatever the config says today.

`promptFile`, also user-config-only since it names a file to read, replaces
the prompt entirely, with `{{patchPath}}`, `{{outputSchema}}`, and similar
placeholders substituted in. The output schema cannot be changed:
`merge.mjs` and the viewer are both built against its shape.
`{{instructions}}` places `review.instructions` and anything from `-p`;
leave it out and they are appended at the end, so the flag still works
against a replaced prompt.

`allowedTools` is one of the five settings a repo cannot set. It is
read-only by default because the analysis runs non-interactively, so a tool
that triggers a permission prompt hangs forever with nobody to answer it.
That also means an instruction file asking the review to check a ticket is a
silent no-op until you add the MCP server to your own config. It names the
entire toolset rather than a list of pre-approved tools, so adding `Bash`
really does mean the review can run your test suite, and given the chance it
will. That is why a branch under review does not get a vote on it.

`effort` is the speed dial, and `low` is the default. On a seven-file diff,
`low` takes 46 seconds against 166 at `medium`, because the extra thinking
widens the search rather than sharpens the verdict; the slower runs wander
into the CI config and the README. Raise it for a diff whose correctness
turns on reasoning rather than reading.

`provider` names the program that produces the analysis. `claude` is the
only one implemented today. Everything downstream stays indifferent to who
was asked: `prompt.mjs` builds a string, `reply.mjs` finds an object in
whatever came back, and `merge.mjs` validates it against the patch. What is
specific to a provider (its binary, its flags, where its reply hides in what
it printed) lives in one descriptor under `src/pipeline/providers/`, so
adding a provider means adding a file and a registry line, not editing the
CLI.

A provider must be an agentic CLI with the repo checked out, since the
prompt hands it a path to the diff and tells it to read from there; a plain
completion API would need a different prompt. And a provider is always
selected by id from the registry, never described in config: a config key
holding a command would be arbitrary code execution wearing a config file,
which is the hole the trust boundary above exists to close.

### Appearance

```jsonc
{
  "theme": {
    "preset": "dark",          // or "light", or just "theme": "light"
    "syntax": "tokyo-night",   // any Shiki theme, plus pierre-dark / pierre-light
    "ui": { "accent": "magenta", "borderFocus": "magenta" },
    "diff": { "addBg": "#0b2c18", "delBg": "#3a1114" },
    "fileStatus": { "renamed": { "glyph": "»", "color": "magenta" } }
  },
  "layout": {
    "diffView": "unified",   // or "split", which one a diff opens in; v switches
    "treeWidth": 38, "findingsWidth": 58, "tabWidth": 4, "hScrollStep": 8
  }
}
```

Colors are terminal palette names or hex. Palette names follow your
terminal theme; hex does not. Both downsample automatically where
truecolor is missing.

`fileStatus` is the glyph and colour each file's fate gets in the tree —
`added`, `deleted`, `renamed`, `binary`, `modified` — so a terminal font
without `→` can say something else. It is merged key by key, so naming one
status leaves the other four alone.

## Caching

Artifacts are cached in `$XDG_CACHE_HOME/slice/<repo>/`, or
`~/.cache/slice/` if that is unset, outside the repo either way, so
reviewing never dirties your working tree. Re-run with `--ai --refresh` to
redo the analysis; plain `--ai` reuses a cached one if there is one. A run
with `-p` gets its own entry, keyed by a hash of the instructions, so it
neither reads nor overwrites the plain review of the same diff.

Your unposted drafts and your read marks live there too, keyed to the same
review, which is what lets both survive closing the terminal.

`slice --clear-cache` drops the whole thing, read marks and unposted drafts
included.

Re-open a cached review without touching git, `gh`, or the model:

```
slice --open ~/.cache/slice/<repo>/pr-1692.review.json
```

## Layout

```
bin/slice.mjs           resolve target, capture patch, run analysis, open the viewer
src/pipeline/           the only code that talks to gh, git, or the model
  patch.mjs             split a unified diff into per-file patches
  prompt.mjs            the analysis prompt, assembled from overridable sections
  reply.mjs             find the analysis in whatever the model actually said
  merge.mjs             validate model output against the patch
  providers/            which program produces the analysis, and how it is driven
    claude.mjs           Claude Code: flags, and where its reply hides
src/viewer/             the terminal UI (ink)
  app.mjs               layout, keys, state
  tree.mjs              the tree, and which diff cell the cursor is on
  render.mjs            @pierre/diffs hast -> styled segments
  markdown.mjs          markdown -> styled, pre-wrapped line segments
  compose.mjs           $EDITOR composition and draft persistence
  progress.mjs          which files are marked read, and what invalidates that
  github.mjs            posting a review back
  theme.mjs             config + manifest -> what the viewer draws with
src/config/             defaults, presets, and the JSONC loader
test/                   node:test, no dependencies
```

`review.json` is the contract between the pipeline and the viewer, which is
why `--open` works at all.

## Development

```
npm install
npm test                       # node:test, no dependencies
npm run format                 # prettier
node bin/slice.mjs --open <review.json>
```

`SLICE_DEBUG=1` keeps the stack trace on an unexpected failure. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how the pieces are tested and the one
rule about config that is not a matter of taste.

## License

MIT, see [LICENSE](LICENSE).
