'use strict'

// Behaviour that must not depend on whether the native addon or the
// WebAssembly build is loaded: `npm test` runs this file against the native
// addon and `npm run test:wasm` against the WebAssembly build.

const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { __napiBindingTarget } = require('../index.js')
const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { readerError } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rusc-xlsx-reader-wasm-'))

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('loads the build the test run asks for', () => {
  assert.equal(__napiBindingTarget, process.env.RUSC_XLSX_READER_BINDING ?? 'native')
})

test('resolves relative paths against the working directory', async () => {
  // WASI resolves relative paths against `/`; the wrapper resolves them first.
  const absolute = path.join(temporaryDirectory, 'relative.xlsx')
  fs.writeFileSync(absolute, primary)
  const relative = path.relative(process.cwd(), absolute)
  assert.equal(path.isAbsolute(relative), false)

  const workbook = await openWorkbook(relative)
  assert.deepEqual(await workbook.sheet('Hidden').readRows(), [['secret']])
})

test('reads workbooks from any Uint8Array or an ArrayBuffer', async () => {
  const bytes = new Uint8Array(primary)
  const padded = new Uint8Array(bytes.length + 16)
  padded.set(bytes, 8)

  for (const source of [bytes, padded.subarray(8, 8 + bytes.length), bytes.buffer]) {
    assert.equal(Buffer.isBuffer(source), false)
    const workbook = await openWorkbook(source)
    assert.deepEqual(await workbook.sheet('Hidden').readRows(), [['secret']])
  }
})

test('rejects typed arrays other than Uint8Array', async () => {
  for (const source of [new Uint16Array(4), new DataView(new ArrayBuffer(4))]) {
    await assert.rejects(() => openWorkbook(source), readerError('INVALID_SOURCE'))
  }
})

test('streams rows across batches', async () => {
  const workbook = await openWorkbook(fixtures.createNumberedWorkbook(1000))
  let count = 0
  let last
  for await (const row of workbook.sheet(0).rows({ batchSize: 64 })) {
    count += 1
    last = row
  }
  assert.equal(count, 1001)
  assert.deepEqual(last, Array.from({ length: 10 }, (_, column) => 1000 * 10 + column))
})
