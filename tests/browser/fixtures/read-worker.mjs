// Reads a workbook in a module Web Worker. The WebAssembly loader uses
// top-level await, so the worker announces when it has loaded instead of
// relying on messages posted before its listener exists.
import { openWorkbook } from '@nazarkalytiuk/rusc-xlsx-reader'

self.addEventListener('message', async (event) => {
  try {
    const workbook = await openWorkbook(event.data.bytes)
    const rows = await workbook.sheet('Hidden').readRows()
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
    self.postMessage({ type: 'rows', rows })
  } catch (error) {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
    self.postMessage({ type: 'error', error: String(error) })
  }
})
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's postMessage has no target origin
self.postMessage({ type: 'ready' })
