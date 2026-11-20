// The browser entry (wrapper.browser.mjs) on the WebAssembly build, in real
// browsers. Every fixture of the Node.js tests must read exactly as the native
// addon reads it (see report.mjs); the other tests cover what differs in a
// browser: no file system, cross-origin isolation for WebAssembly threads,
// worker threads for streaming, and Web Workers.

import { describe, expect, test } from 'vitest'
import { commands } from 'vitest/browser'
import { openWorkbook, XlsxReaderError } from '@nazarkalytiuk/rusc-xlsx-reader'

import { readReport } from './report.mjs'

async function fixture(name, ...args) {
  const binary = atob(await commands.fixture(name, ...args))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function count(iterable) {
  let rows = 0
  let last
  for await (const row of iterable) {
    rows += 1
    last = row
  }
  return { rows, last }
}

/** The last row of `createNumberedWorkbook(rows)`. */
function numberedRow(row) {
  return Array.from({ length: 10 }, (_, column) => row * 10 + column)
}

describe('Browser entry', () => {
  test('runs in a cross-origin isolated page', () => {
    // WebAssembly threads share memory, which needs SharedArrayBuffer.
    expect(globalThis.crossOriginIsolated).toBe(true)
    expect(globalThis.process).toBeUndefined()
  })

  test.each([
    ['createPrimaryWorkbook'],
    ['createValuesWorkbook'],
    ['createRecordsWorkbook'],
    ['createSheetKindsPackage'],
    ['createCellEdgesPackage'],
    ['createMalformedReferencePackage'],
    ['createMissingSheetPartPackage'],
    ['createSheetlessPackage'],
    ['createMissingWorkbookPartPackage'],
    ['createModernErrorPackage'],
    ['createMacroSheetPackage'],
    ['createRichValueErrorPackage'],
    ['createEncryptedContainer'],
    ['createNumberedWorkbook', 2500],
  ])('reads %s exactly as the native addon does', async (name, ...args) => {
    const report = await readReport(openWorkbook, await fixture(name, ...args))
    expect(report).toEqual(await commands.nativeReport(name, ...args))
  })

  test('reads workbooks from Uint8Array views and ArrayBuffers', async () => {
    const bytes = await fixture('createPrimaryWorkbook')
    const padded = new Uint8Array(bytes.length + 16)
    padded.set(bytes, 8)

    for (const source of [bytes, padded.subarray(8, 8 + bytes.length), bytes.buffer]) {
      const workbook = await openWorkbook(source)
      expect(await workbook.sheet('Hidden').readRows()).toEqual([['secret']])
    }
  })

  test('rejects file paths, which browsers cannot read', async () => {
    const error = await openWorkbook('report.xlsx').catch((caught) => caught)
    expect(error).toBeInstanceOf(XlsxReaderError)
    expect(error.code).toBe('INVALID_SOURCE')
    expect(error.message).toMatch(/Uint8Array/)
  })

  test('aborts opening, reading and streaming', async () => {
    const bytes = await fixture('createNumberedWorkbook', 20_000)
    await expect(openWorkbook(bytes, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'ABORTED',
    })

    const sheet = (await openWorkbook(bytes)).sheet(0)
    await expect(sheet.readRows({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'ABORTED',
    })

    const controller = new AbortController()
    let rows = 0
    const streamed = (async () => {
      for await (const _ of sheet.rows({ batchSize: 16, signal: controller.signal })) {
        rows += 1
        if (rows === 100) controller.abort()
      }
    })()
    await expect(streamed).rejects.toMatchObject({ code: 'ABORTED' })
    expect(rows).toBe(100)

    // The worker thread of the aborted stream is gone; the workbook still reads.
    expect(await count(sheet.rows())).toEqual({ rows: 20_001, last: numberedRow(20_000) })
  })

  test('streams many sheets at once on WebAssembly threads', async () => {
    const workbook = await openWorkbook(await fixture('createNumberedWorkbook', 5000))
    // More streams than the loader pre-creates threads for, so some threads
    // start on workers created on demand.
    const streams = Array.from({ length: 2 * (navigator.hardwareConcurrency + 4) }, () =>
      count(workbook.sheet(0).rows({ batchSize: 256 }))
    )
    for (const result of await Promise.all(streams)) {
      expect(result).toEqual({ rows: 5001, last: numberedRow(5000) })
    }
  })

  test('reads workbooks large enough to grow WebAssembly memory', async () => {
    const rows = 100_000
    const workbook = await openWorkbook(await fixture('createNumberedWorkbook', rows))
    const read = await workbook.sheet(0).readRows()
    expect(read).toHaveLength(rows + 1)
    expect(read.at(-1)).toEqual(numberedRow(rows))
    expect(await count(workbook.sheet(0).records())).toEqual({
      rows,
      last: Object.fromEntries(numberedRow(rows).map((value, column) => [`column_${column}`, value])),
    })
  })

  test('runs in a module Web Worker', async () => {
    const worker = new Worker(new URL('./fixtures/read-worker.mjs', import.meta.url), {
      type: 'module',
    })
    try {
      const bytes = await fixture('createPrimaryWorkbook')
      const rows = await new Promise((resolve, reject) => {
        worker.addEventListener('message', ({ data }) => {
          if (data.type === 'ready') {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker#postMessage has no target origin
            worker.postMessage({ bytes }, [bytes.buffer])
          } else if (data.type === 'rows') {
            resolve(data.rows)
          } else {
            reject(new Error(data.error))
          }
        })
        worker.addEventListener('error', (event) =>
          reject(event.error ?? new Error(event.message ?? 'The worker failed to load'))
        )
      })
      expect(rows).toEqual([['secret']])
    } finally {
      worker.terminate()
    }
  })
})
