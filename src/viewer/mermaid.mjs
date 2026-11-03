import { Worker } from 'node:worker_threads'

const MAX_SOURCE = 20_000
const WORKER_URL = new URL('./mermaid-worker.mjs', import.meta.url)
const cache = new Map()

const toLines = (text) => {
  const lines = text.split('\n').map((line) => line.trimEnd())
  while (lines.length > 0 && !lines.at(-1)) lines.pop()
  return lines.length > 0 ? lines : null
}

function renderOne(worker, id, source, ms) {
  return new Promise((done) => {
    const finish = (result) => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onFailure)
      worker.off('exit', onFailure)
      done(result)
    }
    const onMessage = (message) => {
      if (message.id === id) finish({ text: message.text })
    }
    const onFailure = () => finish({ dead: true })
    const timer = setTimeout(() => finish({ dead: true }), ms)

    worker.on('message', onMessage)
    worker.on('error', onFailure)
    worker.on('exit', onFailure)
    worker.postMessage({ id, source })
  })
}

export async function renderDiagrams(sources, { perDiagramMs = 1500, totalMs = 3000 } = {}) {
  const diagrams = new Map()
  const deadline = Date.now() + totalMs
  let worker = null

  try {
    for (const [id, source] of [...new Set(sources)].entries()) {
      if (cache.has(source)) {
        diagrams.set(source, cache.get(source))
        continue
      }

      const left = Math.min(perDiagramMs, deadline - Date.now())
      if (source.length > MAX_SOURCE || left <= 0) {
        diagrams.set(source, null)
        continue
      }

      worker ??= new Worker(WORKER_URL, { resourceLimits: { maxOldGenerationSizeMb: 256 } })
      const { text, dead } = await renderOne(worker, id, source, left)
      if (dead) {
        await worker.terminate()
        worker = null
      }

      const lines = text ? toLines(text) : null
      diagrams.set(source, lines)
      cache.set(source, lines)
    }
  } finally {
    await worker?.terminate()
  }

  return diagrams
}
