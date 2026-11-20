'use strict'

// Preloaded by `npm run test:wasm` (node --require) to run the suite against
// the WebAssembly build. The generated loader picks the build from
// NAPI_RS_WASI_FLAVOR when it is first required; the variable is removed again
// afterwards because the fixtures come from @nazarkalytiuk/rusc-xlsx, whose
// loader reads the same variable and must keep loading its native addon.
process.env.NAPI_RS_WASI_FLAVOR = 'wasm32-wasi'
try {
  require('../../index.js')
} finally {
  delete process.env.NAPI_RS_WASI_FLAVOR
}
process.env.RUSC_XLSX_READER_BINDING = 'wasm32-wasi'
