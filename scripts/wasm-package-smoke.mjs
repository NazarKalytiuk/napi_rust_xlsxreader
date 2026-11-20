// Checks the packages a release publishes, the way a browser app uses them.
//
// It packs the root package and the WebAssembly package (npm/wasm32-wasi,
// filled by `napi create-npm-dirs` and `npm run artifacts`, as the release
// workflow does) and installs both into a new Vite app. The app reads a
// workbook in Chromium, Firefox and WebKit, from a production build and from
// the Vite dev server, and the rows must equal what the native addon reads. A
// page that is not cross-origin isolated must get a clear error. Last, Node.js
// must fall back to the WebAssembly package when no native package is
// installed.
//
// Usage: node scripts/wasm-package-smoke.mjs [package root, default: cwd]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { chromium, firefox, webkit } from 'playwright'

const require = createRequire(import.meta.url)
const fixtures = require('../tests/fixtures.js')
const nativeReader = require('../wrapper.js')

const packageRoot = path.resolve(process.argv[2] ?? '.')
const rootManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const wasmPackageDir = path.join(packageRoot, 'npm', 'wasm32-wasi')
const wasmManifest = JSON.parse(fs.readFileSync(path.join(wasmPackageDir, 'package.json'), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

function pack(dir, destination) {
  // Scripts are skipped: the release workflow packs files it has already built.
  const [{ filename }] = JSON.parse(
    run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], dir)
  )
  return path.join(destination, filename)
}

/** What the app reports: every sheet's rows, read whole and streamed. */
async function readAll(openWorkbook, source) {
  const workbook = await openWorkbook(source)
  const sheets = []
  for (const metadata of workbook.sheets.filter((sheet) => sheet.type === 'worksheet')) {
    const sheet = workbook.sheet(metadata.name)
    const streamed = []
    for await (const row of sheet.rows({ batchSize: 2, dateMode: 'iso' })) streamed.push(row)
    sheets.push({ name: metadata.name, rows: await sheet.readRows({ dateMode: 'iso' }), streamed })
  }
  return JSON.parse(JSON.stringify(sheets))
}

const APP_SOURCE = `
import { openWorkbook } from '${rootManifest.name}'

const response = await fetch('/fixture.xlsx')
const source = new Uint8Array(await response.arrayBuffer())
${readAll.toString()}
window.smokeResult = { sheets: await readAll(openWorkbook, source) }
`

const ENTRY_SOURCE = `
// Loading the app through import() turns a failed WebAssembly load into a
// rejection the smoke test can report.
import('./app.js').catch((error) => {
  window.smokeResult = { error: String(error?.message ?? error) }
})
`

// The configuration the README documents for Vite.
const VITE_CONFIG = `
export default {
  // WebAssembly threads need SharedArrayBuffer, which browsers only allow in
  // cross-origin isolated pages.
  server: { headers: ${JSON.stringify(ISOLATION_HEADERS)} },
  preview: { headers: ${JSON.stringify(ISOLATION_HEADERS)} },
  // The dev server must serve the WebAssembly package's files as they are: its
  // loader finds the .wasm and worker files next to itself.
  optimizeDeps: { exclude: ['${wasmManifest.name}'] },
}
`

function serve(dir, headers) {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
  }
  const server = http.createServer((request, response) => {
    const urlPath = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = path.join(dir, urlPath === '/' ? 'index.html' : urlPath)
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      ...headers,
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    })
    fs.createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** Opens `url` in every browser and returns each one's `smokeResult`. */
async function visit(url) {
  const results = []
  for (const browserType of [chromium, firefox, webkit]) {
    const browser = await browserType.launch()
    try {
      const page = await browser.newPage()
      await page.goto(url)
      await page.waitForFunction(() => 'smokeResult' in globalThis, undefined, { timeout: 60_000 })
      results.push([browserType.name(), await page.evaluate(() => globalThis.smokeResult)])
    } finally {
      await browser.close()
    }
  }
  return results
}

async function expectRows(url, label, expected) {
  for (const [browser, result] of await visit(url)) {
    if (result.error !== undefined) {
      throw new Error(`${label} / ${browser}: ${result.error}`)
    }
    if (!isDeepStrictEqual(result.sheets, expected)) {
      throw new Error(`${label} / ${browser}: the rows differ from the native addon's`)
    }
    console.log(`${label} / ${browser}: ok`)
  }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rusc-xlsx-reader-wasm-smoke-'))
const servers = []
try {
  const workbookBytes = fixtures.createPrimaryWorkbook()
  const expected = await readAll(nativeReader.openWorkbook, workbookBytes)

  const rootTarball = pack(packageRoot, workDir)
  const wasmTarball = pack(wasmPackageDir, workDir)

  const appDir = path.join(workDir, 'app')
  fs.mkdirSync(path.join(appDir, 'public'), { recursive: true })
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        [rootManifest.name]: `file:${rootTarball}`,
        [wasmManifest.name]: `file:${wasmTarball}`,
        vite: require('vite/package.json').version,
      },
    })
  )
  run(npm, ['install', '--no-audit', '--no-fund'], appDir)
  fs.writeFileSync(
    path.join(appDir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>smoke</title><script type="module" src="/main.js"></script>'
  )
  fs.writeFileSync(path.join(appDir, 'main.js'), ENTRY_SOURCE)
  fs.writeFileSync(path.join(appDir, 'app.js'), APP_SOURCE)
  fs.writeFileSync(path.join(appDir, 'vite.config.js'), VITE_CONFIG)
  fs.writeFileSync(path.join(appDir, 'public', 'fixture.xlsx'), workbookBytes)

  const vite = path.join('node_modules', 'vite', 'bin', 'vite.js')
  run(process.execPath, [vite, 'build'], appDir)
  const distDir = path.join(appDir, 'dist')
  const assets = fs.readdirSync(path.join(distDir, 'assets'))
  if (!assets.some((asset) => asset.endsWith('.wasm'))) {
    throw new Error(`The production build has no .wasm asset: ${assets.join(', ')}`)
  }

  const isolated = await serve(distDir, ISOLATION_HEADERS)
  servers.push(isolated)
  await expectRows(`http://127.0.0.1:${isolated.address().port}/`, 'production build', expected)

  const notIsolated = await serve(distDir, {})
  servers.push(notIsolated)
  for (const [browser, result] of await visit(`http://127.0.0.1:${notIsolated.address().port}/`)) {
    if (!/cross-origin isolated/.test(result.error ?? '')) {
      throw new Error(`not isolated / ${browser}: expected the isolation error, got ${JSON.stringify(result)}`)
    }
    console.log(`not isolated / ${browser}: ok (${result.error})`)
  }

  const { createServer } = await import(
    pathToFileURL(path.join(appDir, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href
  )
  const devServer = await createServer({ root: appDir, logLevel: 'error', server: { port: 0 } })
  await devServer.listen()
  try {
    await expectRows(devServer.resolvedUrls.local[0], 'dev server', expected)
  } finally {
    await devServer.close()
  }

  // Without a native package, as on a platform with no prebuilt binary, the
  // Node.js loader falls back to the WebAssembly package.
  const scope = path.dirname(rootManifest.name)
  const scopeDir = path.join(appDir, 'node_modules', scope)
  for (const entry of fs.readdirSync(scopeDir)) {
    const name = `${scope}/${entry}`
    if (name.startsWith(`${rootManifest.name}-`) && name !== wasmManifest.name) {
      fs.rmSync(path.join(scopeDir, entry), { recursive: true })
    }
  }
  const nodeCheck = `
    // The package's exports hide its loader, so it is required by its path.
    const packageDir = require('node:path').dirname(require.resolve('${rootManifest.name}'))
    const { __napiBindingTarget } = require(require('node:path').join(packageDir, 'index.js'))
    if (__napiBindingTarget !== 'wasm32-wasi') throw new Error('loaded ' + __napiBindingTarget)
    const { openWorkbook } = require('${rootManifest.name}')
    ${readAll.toString()}
    readAll(openWorkbook, 'public/fixture.xlsx').then((sheets) => process.stdout.write(JSON.stringify(sheets)))
  `
  const nodeRows = JSON.parse(run(process.execPath, ['--no-warnings', '-e', nodeCheck], appDir))
  if (!isDeepStrictEqual(nodeRows, expected)) {
    throw new Error('Node.js (WebAssembly fallback): the rows differ from the native addon')
  }
  console.log('node (WebAssembly fallback): ok')
} finally {
  for (const server of servers) server.close()
  fs.rmSync(workDir, { recursive: true, force: true })
}
