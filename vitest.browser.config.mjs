import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import { readReport } from './tests/browser/report.mjs'

const require = createRequire(import.meta.url)
const fixtures = require('./tests/fixtures.js')
const nativeReader = require('./wrapper.js')

/** The fixture workbooks of the Node.js tests, as base64, built in Node.js. */
function fixture(_context, name, ...args) {
  return fixtures[name](...args).toString('base64')
}

/** What the native addon reports for a fixture; see tests/browser/report.mjs. */
function nativeReport(_context, name, ...args) {
  return readReport(nativeReader.openWorkbook, fixtures[name](...args))
}

// Runs tests/browser against the browser entry (wrapper.browser.mjs) and the
// local WebAssembly build: `npm run build:wasm` first.
export default defineConfig({
  resolve: {
    alias: [
      {
        // ./browser.js imports the published WebAssembly package; the tests
        // use the loader `npm run build:wasm` writes next to it instead.
        find: /^@nazarkalytiuk\/rusc-xlsx-reader-wasm32-wasi$/,
        replacement: fileURLToPath(new URL('./rusc_xlsx_reader.wasi-browser.js', import.meta.url)),
      },
    ],
  },
  optimizeDeps: {
    // The tests import this package by name, so Vite treats it as a dependency
    // and converts reader.js from CommonJS, as it does for an installed
    // package. The WebAssembly runtime is listed too: discovering it during
    // the run would make Vite reload the page under the first browser.
    include: [
      '@nazarkalytiuk/rusc-xlsx-reader',
      '@napi-rs/wasm-runtime',
      '@emnapi/core',
      '@emnapi/runtime',
    ],
  },
  // WebAssembly threads need SharedArrayBuffer, which browsers only allow in
  // cross-origin isolated pages.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    include: ['tests/browser/**/*.test.mjs'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
      commands: { fixture, nativeReport },
    },
  },
})
