<script lang="ts">
  import type { ReviewSession } from '$lib/state.svelte'

  let { session }: { session: ReviewSession } = $props()

  const slice = $derived(session.activeSlice)
  const counts = $derived(session.countsBySeverity(slice?.paths))
</script>

<div class="panel scroll">
  <section>
    <h3>The change</h3>
    <p>{session.review.overview.intent || 'No intent was recorded.'}</p>
  </section>

  <section>
    <h3>
      Assessment
      <span class="chip risk risk-{session.review.overview.risk}">{session.review.overview.risk} risk</span>
    </h3>
    <p>{session.review.overview.assessment || 'No assessment was recorded.'}</p>
  </section>

  {#if slice}
    <section class="slice">
      <h3>
        {slice.title}
        {#if slice.kind !== 'behavior'}<span class="chip">{slice.kind}</span>{/if}
      </h3>
      <p>{slice.summary}</p>

      <dl>
        <div><dt>Files</dt><dd>{slice.paths.length}</dd></div>
        <div><dt>Reviewed</dt><dd>{session.sliceProgress(slice.id).done}/{slice.paths.length}</dd></div>
        <div>
          <dt>Findings</dt>
          <dd>{counts.bug + counts.risk + counts.cleanup + counts.nit + counts.question}</dd>
        </div>
      </dl>
    </section>

    <section>
      <h3>Files in this slice</h3>
      <ul class="files">
        {#each slice.paths as path (path)}
          <li>
            <button class:active={session.activePath === path} onclick={() => session.selectPath(path)}>
              <span class="name mono">{path.split('/').pop()}</span>
              {#if session.reviewed[path]}<span class="done">✓</span>{/if}
              <span class="dir mono">{path.split('/').slice(0, -1).join('/')}</span>
              {#if session.review.notes[path]}
                <span class="blurb">{session.review.notes[path]}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .panel {
    height: 100%;
    padding: 12px 14px 40px;
  }

  section {
    margin-bottom: 20px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-faint);
    font-weight: 600;
  }

  p {
    margin: 0;
    line-height: 1.55;
    color: var(--text);
    font-size: 12.5px;
  }

  .slice p {
    color: var(--text-muted);
  }

  .risk {
    margin-left: auto;
    text-transform: uppercase;
    font-size: 10px;
  }

  .risk-high {
    color: var(--sev-bug);
    border-color: var(--sev-bug);
  }
  .risk-medium {
    color: var(--sev-risk);
    border-color: var(--sev-risk);
  }
  .risk-low {
    color: var(--ok);
    border-color: var(--ok);
  }

  dl {
    display: flex;
    gap: 16px;
    margin: 10px 0 0;
  }

  dt {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
  }

  dd {
    margin: 2px 0 0;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  ul.files {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  ul.files button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 4px;
    border-left: 2px solid transparent;
  }

  ul.files button:hover {
    background: var(--bg-hover);
  }

  ul.files button.active {
    background: var(--bg-hover);
    border-left-color: var(--accent);
  }

  .name {
    font-size: 12px;
  }

  .done {
    color: var(--ok);
    margin-left: 5px;
    font-size: 11px;
  }

  .dir {
    display: block;
    font-size: 10.5px;
    color: var(--text-faint);
  }

  .blurb {
    display: block;
    margin-top: 3px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--text-muted);
  }
</style>
