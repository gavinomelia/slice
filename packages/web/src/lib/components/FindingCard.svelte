<script lang="ts">
  import type { Finding } from '$lib/types'
  import type { ReviewSession } from '$lib/state.svelte'
  import { SEVERITY_META } from '$lib/types'
  import { renderMarkdown } from '$lib/markdown'

  let {
    finding,
    session,
    showPath = false,
  }: { finding: Finding; session: ReviewSession; showPath?: boolean } = $props()

  const meta = $derived(SEVERITY_META[finding.severity])
  const drafted = $derived(Boolean(session.draftFor(finding.id)))
  const active = $derived(session.activeFindingId === finding.id)
</script>

<article class="finding" class:active style="--sev: {meta.color}">
  <header>
    <span class="sev">{meta.glyph} {meta.label}</span>
    {#if finding.confidence === 'suspected'}
      <span class="chip" title="The analysis did not verify this claim">unverified</span>
    {/if}
    {#if showPath}
      <button class="loc mono" onclick={() => session.focusFinding(finding)}>
        {finding.path.split('/').pop()}{finding.line ? `:${finding.line}` : ''}
      </button>
    {:else if finding.line}
      <span class="loc mono">:{finding.line}</span>
    {/if}
  </header>

  <h4>{finding.title}</h4>

  {#if finding.why}
    <div class="prose">{@html renderMarkdown(finding.why)}</div>
  {/if}

  {#if finding.fix}
    <div class="fix">
      <span class="fix-label">Fix</span>
      <div class="prose">{@html renderMarkdown(finding.fix)}</div>
    </div>
  {/if}

  <footer>
    <button onclick={() => session.draftFromFinding(finding)} disabled={drafted}>
      {drafted ? 'drafted ✓' : 'draft comment'}
    </button>
    <button onclick={() => session.dismiss(finding.id)}>dismiss</button>
  </footer>
</article>

<style>
  .finding {
    border: 1px solid var(--border);
    border-left: 2px solid var(--sev);
    border-radius: var(--radius);
    background: var(--bg-raised);
    padding: 8px 10px;
    margin: 6px 0;
    font-size: 12px;
  }

  .finding.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-dim);
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }

  .sev {
    color: var(--sev);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .loc {
    margin-left: auto;
    color: var(--text-faint);
    font-size: 11px;
  }

  button.loc:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  h4 {
    margin: 0 0 4px;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.4;
  }

  .prose {
    color: var(--text-muted);
    line-height: 1.5;
  }

  .prose :global(p) {
    margin: 0 0 6px;
  }

  .prose :global(p:last-child) {
    margin-bottom: 0;
  }

  .prose :global(code) {
    font-family: var(--mono);
    font-size: 11px;
    background: var(--bg-inset);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .prose :global(.md-code) {
    font-family: var(--mono);
    font-size: 11px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 9px;
    margin: 6px 0 0;
    overflow-x: auto;
    white-space: pre;
    color: var(--text);
  }

  .fix {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--border);
  }

  .fix-label {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-bottom: 3px;
  }

  footer {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }

  footer button {
    font-size: 11px;
    color: var(--text-faint);
  }

  footer button:hover:not(:disabled) {
    color: var(--accent);
  }

  footer button:disabled {
    color: var(--ok);
    cursor: default;
  }
</style>
