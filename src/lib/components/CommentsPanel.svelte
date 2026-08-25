<script lang="ts">
  import type { ReviewSession } from '$lib/state.svelte'

  let { session }: { session: ReviewSession } = $props()

  let event = $state<'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'>('COMMENT')
  let body = $state('')
  let posting = $state(false)
  let result = $state<{ ok: boolean; message: string; url?: string } | null>(null)

  const target = $derived(session.review.target)
  const canGate = $derived(target.kind === 'pr' && !target.viewerIsAuthor)

  async function post() {
    posting = true
    result = null
    try {
      const response = await fetch('/api/post-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: canGate ? event : 'COMMENT',
          body,
          comments: session.postableDrafts.map((d) => ({
            path: d.path,
            line: d.line,
            side: d.side === 'deletions' ? 'LEFT' : 'RIGHT',
            body: d.body,
          })),
          bodyOnly: session.bodyOnlyDrafts.map((d) => ({ path: d.path, body: d.body })),
        }),
      })
      const payload = await response.json()
      result = response.ok
        ? { ok: true, message: 'Review posted.', url: payload.url }
        : { ok: false, message: payload.error ?? 'Posting failed.' }
    } catch (cause) {
      result = { ok: false, message: (cause as Error).message }
    } finally {
      posting = false
    }
  }
</script>

<div class="panel scroll">
  {#if session.drafts.length === 0}
    <p class="empty">
      No drafts yet. Use <em>draft comment</em> on any finding, and it lands here ready to edit.
    </p>
  {:else}
    <ul>
      {#each session.drafts as draft (draft.id)}
        <li>
          <header>
            <span class="mono loc">{draft.path.split('/').pop()}{draft.line > 0 ? `:${draft.line}` : ' (file)'}</span>
            <button class="remove" onclick={() => session.removeDraft(draft.id)}>remove</button>
          </header>
          <textarea
            value={draft.body}
            rows="5"
            oninput={(e) => session.updateDraft(draft.id, (e.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </li>
      {/each}
    </ul>
  {/if}

  <section class="submit">
    <h3>Submit</h3>

    {#if target.kind !== 'pr'}
      <p class="note">This is a local branch review, so there's no PR to post to.</p>
    {:else}
      <textarea bind:value={body} rows="4" placeholder="Review summary (optional)"></textarea>

      <div class="events">
        {#each ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as option (option)}
          <label class:disabled={!canGate && option !== 'COMMENT'}>
            <input
              type="radio"
              value={option}
              checked={event === option}
              disabled={!canGate && option !== 'COMMENT'}
              onchange={() => (event = option as typeof event)}
            />
            {option.toLowerCase().replace('_', ' ')}
          </label>
        {/each}
      </div>

      {#if target.viewerIsAuthor}
        <p class="note">It's your own PR, so GitHub only accepts plain comments.</p>
      {/if}

      {#if session.bodyOnlyDrafts.length > 0}
        <p class="note">
          {session.bodyOnlyDrafts.length} draft(s) aren't anchored to a line in the diff, so they'll be appended to the
          summary instead of posted inline.
        </p>
      {/if}

      <button class="go" onclick={post} disabled={posting || session.drafts.length === 0}>
        {posting ? 'posting…' : `post ${session.postableDrafts.length} line comment(s)`}
      </button>

      {#if result}
        <p class="result" class:bad={!result.ok}>
          {result.message}
          {#if result.url}<a href={result.url} target="_blank" rel="noreferrer">view</a>{/if}
        </p>
      {/if}
    {/if}
  </section>
</div>

<style>
  .panel {
    height: 100%;
    padding: 10px 12px 40px;
  }

  ul {
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
  }

  li {
    margin-bottom: 10px;
  }

  header {
    display: flex;
    align-items: center;
    margin-bottom: 3px;
  }

  .loc {
    font-size: 11px;
    color: var(--text-muted);
  }

  .remove {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--text-faint);
  }

  .remove:hover {
    color: var(--sev-bug);
  }

  textarea {
    width: 100%;
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 7px 8px;
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    resize: vertical;
  }

  textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .submit {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }

  h3 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-faint);
  }

  .events {
    display: flex;
    gap: 12px;
    margin: 8px 0;
    font-size: 11.5px;
  }

  label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-muted);
  }

  label.disabled {
    opacity: 0.35;
  }

  .note {
    margin: 6px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-faint);
  }

  .go {
    margin-top: 10px;
    width: 100%;
    padding: 7px;
    border-radius: 4px;
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    color: var(--text);
    font-size: 12px;
  }

  .go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .result {
    margin: 8px 0 0;
    font-size: 11.5px;
    color: var(--ok);
  }

  .result.bad {
    color: var(--sev-bug);
  }

  .empty {
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.55;
    margin: 0 0 18px;
  }
</style>
