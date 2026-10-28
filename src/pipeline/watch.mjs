import { watch } from 'node:fs'

export function watchDirs({ dirs, ignore = () => false, onChange, onError = () => {}, delayMs = 250 }) {
  const watchers = new Map()
  let timer = null
  let closed = false

  const sync = () => {
    let wanted
    try {
      wanted = new Set(dirs())
    } catch (error) {
      return onError(error)
    }
    for (const [dir, watcher] of watchers) {
      if (wanted.has(dir)) continue
      watcher.close()
      watchers.delete(dir)
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue
      try {
        const watcher = watch(dir, (_, name) => poke(dir, name))
        watcher.on('error', () => {
          watcher.close()
          watchers.delete(dir)
        })
        watchers.set(dir, watcher)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue
        return onError(error)
      }
    }
  }

  const fire = () => {
    timer = null
    if (closed) return
    onChange()
    sync()
  }

  const poke = (dir, name) => {
    if (closed || ignore(dir, name)) return
    clearTimeout(timer)
    timer = setTimeout(fire, delayMs)
  }

  sync()

  return () => {
    closed = true
    clearTimeout(timer)
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
}
