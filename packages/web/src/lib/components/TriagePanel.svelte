<script lang="ts">
  import type { ReviewSession } from '$lib/state.svelte'
  import { SEVERITY_META, SEVERITY_ORDER } from '$lib/types'
  import FindingCard from './FindingCard.svelte'

  let { session }: { session: ReviewSession } = $props()

  const all = $derived(session.countsBySeverity())
  const findings = $derived(session.liveFindings)
  const dismissedCount = $derived(Object.keys(session.dismissed).length)
</script>

<div class="panel scroll">
  <div class="filters">
    {#each SEVERITY_ORDER as severity (severity)}
      <button
        class="filter"
        class:off={!session.severityFilter[severity]}
        style="--sev: {SEVERITY_META[severity].color}"
        disabled={all[severity] === 0}
        onclick={() => (session.severityFilter = { ...session.severityFilter, [severity]: !session.severityFilter[severity] })}
      >
        <span class="glyph">{SEVERITY_META[severity].glyph}</span>
        {SEVERITY_META[severity].label}
        <span class="n">{all[severity]}</span>
      </button>
    {/each}
  </div>

  {#if findings.length === 0}
    <p class="empty">
      {#if dismissedCount > 0}
        Nothing left. {dismissedCount} finding(s) dismissed.
      {:else}
        No findings match the current filters.
      {/if}
    </p>
  {:else}
    <ol>
      {#each findings as finding (finding.id)}
        <li>
          <span class="where mono">{finding.path}</span>
          <FindingCard {finding} {session} showPath />
        </li>
      {/each}
    </ol>
  {/if}

  {#if dismissedCount > 0}
    <footer>
      <span>{dismissedCount} dismissed</span>
      <button
        onclick={() => {
          session.dismissed = {}
          session.persist()
        }}>restore all</button
      >
    </footer>
  {/if}
</div>

<style>
  .panel {
    height: 100%;
    padding: 10px 12px 40px;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }

  .filter {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .filter .glyph {
    color: var(--sev);
  }

  .filter .n {
    font-variant-numeric: tabular-nums;
    color: var(--text-faint);
  }

  .filter.off {
    opacity: 0.35;
  }

  .filter:disabled {
    opacity: 0.25;
    cursor: default;
  }

  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    margin-bottom: 10px;
  }

  .where {
    font-size: 10.5px;
    color: var(--text-faint);
  }

  .empty {
    color: var(--text-faint);
    font-size: 12px;
    padding: 20px 4px;
    margin: 0;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-faint);
  }

  footer button:hover {
    color: var(--accent);
  }
</style>
