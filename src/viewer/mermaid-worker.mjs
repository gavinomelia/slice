import { parentPort } from 'node:worker_threads'

import { renderMermaidASCII } from 'beautiful-mermaid'

const OPTIONS = { paddingY: 2, boxBorderPadding: 0, colorMode: 'none' }

parentPort.on('message', ({ id, source }) => {
  try {
    parentPort.postMessage({ id, text: renderMermaidASCII(source, OPTIONS) })
  } catch {
    parentPort.postMessage({ id, text: null })
  }
})
