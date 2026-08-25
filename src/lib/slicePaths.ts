import type { Review } from './types'

/**
 * @pierre/trees builds its hierarchy from a flat list of path strings, so
 * prefixing each file with its slice makes slices render as the top-level
 * folders. Slice titles are sanitized because a "/" in a title would
 * silently become another directory level.
 */
export interface SliceTreeMap {
  paths: string[]
  fileByTreePath: Map<string, string>
  treePathByFile: Map<string, string>
  sliceRoots: Map<string, string>
}

function sanitize(title: string) {
  return title.replace(/\//g, '∕').trim() || 'Untitled'
}

export function buildSliceTree(review: Review): SliceTreeMap {
  const paths: string[] = []
  const fileByTreePath = new Map<string, string>()
  const treePathByFile = new Map<string, string>()
  const sliceRoots = new Map<string, string>()

  review.slices.forEach((slice, index) => {
    const root = `${index + 1} · ${sanitize(slice.title)}`
    sliceRoots.set(slice.id, root)

    for (const filePath of slice.paths) {
      const treePath = `${root}/${filePath}`
      paths.push(treePath)
      fileByTreePath.set(treePath, filePath)
      treePathByFile.set(filePath, treePath)
    }
  })

  return { paths, fileByTreePath, treePathByFile, sliceRoots }
}
