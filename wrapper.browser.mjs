// Browser entry (the `browser` condition in package.json).
//
// The WebAssembly build loads on the first openWorkbook() call rather than on
// import, so importing the package costs nothing until it is used: loading
// starts the WebAssembly worker threads. ./browser.js is napi-rs's browser
// loader, the counterpart of ./index.js; it loads the build from
// @nazarkalytiuk/rusc-xlsx-reader-wasm32-wasi.
import readerModule from './reader.js'

const { createReader, XlsxReaderError } = readerModule

let binding

function loadBinding() {
  // The threads share WebAssembly memory, a SharedArrayBuffer, which browsers
  // only allow in cross-origin isolated pages.
  if (globalThis.crossOriginIsolated === false) {
    return Promise.reject(
      new XlsxReaderError(
        'UNSUPPORTED_ENVIRONMENT',
        'Reading workbooks in a browser needs a cross-origin isolated page for WebAssembly threads: ' +
          'serve it with the headers Cross-Origin-Opener-Policy: same-origin and ' +
          'Cross-Origin-Embedder-Policy: require-corp (or credentialless)'
      )
    )
  }
  binding ??= import('./browser.js').catch((error) => {
    // Let a later call retry, for example after a failed download.
    binding = undefined
    throw error
  })
  return binding
}

const reader = createReader(loadBinding)

export const { openWorkbook, Workbook, Worksheet } = reader
export { XlsxReaderError }

export default reader
