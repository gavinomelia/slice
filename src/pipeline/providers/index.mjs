/**
 * Which program produces the analysis.
 *
 * Only Claude Code is implemented. The registry exists so that adding another
 * is a new file and one line here, rather than an edit threaded through the
 * CLI — and so that the parts of slice that are already provider-agnostic stay
 * that way. `analysisPrompt` builds a string, `extractJson` finds an object in
 * whatever came back, and `mergeReview` validates it against the patch; none of
 * those three care who was asked.
 *
 * A provider is a plain object:
 *
 * - `id`          — the value `review.provider` is matched against
 * - `name`        — what a person is told is missing, e.g. "Claude Code"
 * - `command`     — the binary, spawned without a shell
 * - `docsUrl`     — where to go and install it
 * - `versionArgs` — argv that proves it is on the PATH
 * - `buildArgs({ prompt, review })` — the full argv for one analysis run
 * - `extractReply(stdout)`          — the model's text, out of whatever the
 *                                     command printed
 *
 * The contract assumes an agentic CLI with the repo checked out, because the
 * prompt hands over a *path to the diff* rather than the diff itself and tells
 * the model to read beyond it. A provider that cannot read files would need the
 * prompt to change too, not just this descriptor.
 *
 * Note what is deliberately absent: a provider cannot be described by config.
 * `review.provider` selects an id from this registry, so the set of binaries
 * slice will ever spawn is fixed at build time. A config key holding a command
 * would be arbitrary code execution wearing a config file, which is the exact
 * hole the trust boundary in `src/config/index.mjs` exists to close.
 */
import { claude } from './claude.mjs'

const PROVIDERS = { [claude.id]: claude }

export const PROVIDER_IDS = Object.keys(PROVIDERS)

export const DEFAULT_PROVIDER_ID = claude.id

/**
 * The provider for a configured id.
 *
 * Throws rather than falling back to the default: a config that names a
 * provider slice does not have is a typo or a downgrade, and silently reviewing
 * with something other than what was asked for is worse than stopping.
 */
export function resolveProvider(id = DEFAULT_PROVIDER_ID) {
  const provider = PROVIDERS[id]
  if (!provider) {
    throw new Error(`unknown review.provider ${JSON.stringify(id)} — slice knows: ${PROVIDER_IDS.join(', ')}`)
  }
  return provider
}
