<script lang="ts">
  import { FileTree, preparePresortedFileTreeInput } from '@pierre/trees'
  import type { ReviewSession } from '$lib/state.svelte'
  import { buildSliceTree } from '$lib/slicePaths'
  import { SEVERITY_META, SEVERITY_ORDER } from '$lib/types'

  let { session }: { session: ReviewSession } = $props()

  let host = $state<HTMLDivElement | null>(null)
  let tree: FileTree | null = null

  const map = $derived(buildSliceTree(session.review))

  // Decorations are computed during row render, so the tree has to be rebuilt
  // when the numbers behind them change. Keyed on the values that appear in a
  // decoration, and nothing else, to keep rebuilds rare.
  const decorationKey = $derived(
    JSON.stringify([Object.keys(session.reviewed).filter((p) => session.reviewed[p]).sort(), Object.keys(session.dismissed).sort()]),
  )

  function statusFor(path: string) {
    const status = session.review.files[path]?.status
    if (status === 'added') return 'added'
    if (status === 'deleted') return 'deleted'
    if (status === 'renamed') return 'renamed'
    return 'modified'
  }

  function build() {
    if (!host) return

    const scrollTop = host.querySelector('.scroll')?.scrollTop ?? 0
    tree?.unmount()
    host.replaceChildren()

    tree = new FileTree({
      preparedInput: preparePresortedFileTreeInput(map.paths),
      presorted: true,
      flattenEmptyDirectories: true,
      initialExpansion: 'open',
      initialSelectedPaths: session.activePath ? [map.treePathByFile.get(session.activePath) ?? ''] : [],
      search: true,
      density: 'compact',
      gitStatus: map.paths.map((treePath) => ({
        path: treePath,
        status: statusFor(map.fileByTreePath.get(treePath) ?? ''),
      })),
      onSelectionChange: (selected) => {
        const filePath = map.fileByTreePath.get(selected[0] ?? '')
        if (filePath) session.selectPath(filePath)
      },
      renderRowDecoration: ({ row }) => {
        if (row.kind === 'directory') {
          const sliceId = [...map.sliceRoots.entries()].find(([, root]) => root === row.path)?.[0]
          if (!sliceId) return null
          const { done, total } = session.sliceProgress(sliceId)
          return { text: `${done}/${total}`, title: `${done} of ${total} files reviewed` }
        }

        const filePath = map.fileByTreePath.get(row.path)
        if (!filePath) return null

        const parts: { text: string; color?: string }[] = []
        if (session.reviewed[filePath]) parts.push({ text: '✓', color: 'var(--ok)' })

        const findings = session.findingsFor(filePath)
        for (const severity of SEVERITY_ORDER) {
          const count = findings.filter((f) => f.severity === severity).length
          if (count > 0) parts.push({ text: `${SEVERITY_META[severity].glyph}${count}`, color: SEVERITY_META[severity].color })
        }

        if (parts.length === 0) return null
        return { text: parts.map((p) => p.text).join(' '), parts }
      },
    })

    tree.render({ fileTreeContainer: host })
    const scroller = host.querySelector('.scroll')
    if (scroller) scroller.scrollTop = scrollTop
  }

  $effect(() => {
    // Referenced so the effect re-runs when either changes.
    void map
    void decorationKey
    build()
    return () => {
      tree?.unmount()
      tree = null
    }
  })

  // Selecting a file elsewhere (triage panel, keyboard) should move the tree
  // cursor without rebuilding.
  $effect(() => {
    const treePath = map.treePathByFile.get(session.activePath)
    if (tree && treePath) tree.scrollToPath(treePath)
  })
</script>

<div class="tree" bind:this={host}></div>

<style>
  .tree {
    height: 100%;
    overflow: hidden;
    font-size: 12px;
  }
</style>
