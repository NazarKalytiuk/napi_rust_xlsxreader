'use strict'

const { after, before, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  openWorkbook,
  Workbook,
  Worksheet,
  XlsxReaderError,
} = require('../wrapper.js')
const { createFixtures } = require('./fixtures.js')

const temporaryDirectory = path.join(__dirname, '.tmp')
let fixtures

before(() => {
  fixtures = createFixtures(temporaryDirectory)
})

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('opens path and Buffer snapshots with equivalent metadata', async () => {
  const pathWorkbook = await openWorkbook(fixtures.primary)
  const source = fs.readFileSync(fixtures.primary)
  const bufferWorkbook = await openWorkbook(source)
  source.fill(0)

  assert.ok(pathWorkbook instanceof Workbook)
  assert.deepEqual(bufferWorkbook.sheets, pathWorkbook.sheets)
  assert.deepEqual(pathWorkbook.sheets, [
    { name: 'Data', type: 'worksheet', visibility: 'visible', declaredRange: 'A1:G5' },
    { name: 'Hidden', type: 'worksheet', visibility: 'hidden', declaredRange: 'A1' },
    { name: 'Sparse', type: 'worksheet', visibility: 'visible', declaredRange: 'C3' },
    { name: 'Records', type: 'worksheet', visibility: 'visible', declaredRange: 'A1:D2' },
    { name: 'Empty', type: 'worksheet', visibility: 'visible', declaredRange: null },
  ])
  assert.deepEqual(pathWorkbook.definedNames, [
    { name: 'DataRange', formula: '=Data!$A$1:$G$5' },
  ])
  assert.equal(pathWorkbook.epoch, 1900)

  const rowsAfterMutation = await bufferWorkbook.sheet('Sparse').readRows()
  assert.deepEqual(rowsAfterMutation, [['C3']])
})

test('preserves typed values, formulas, dates, and Excel errors', async () => {
  const workbook = await openWorkbook(fixtures.primary)
  const sheet = workbook.sheet('Data')
  assert.ok(sheet instanceof Worksheet)

  const rows = await sheet.readRows({ formulaMode: 'both' })
  assert.deepEqual(rows[0], ['text', 'number', 'boolean', 'date', 'formula', 'error', 'empty'])
  assert.equal(rows[1][0], 'alpha')
  assert.equal(rows[1][1], 21.5)
  assert.equal(rows[1][2], true)
  assert.deepEqual(rows[1][3], {
    type: 'datetime',
    serial: 46238.520833333336,
    iso: '2026-08-04T12:30:00.000',
    epoch: 1900,
  })
  assert.deepEqual(rows[1][4], {
    type: 'formula',
    formula: '=B2*2',
    value: 43,
  })
  assert.deepEqual(rows[1][5], {
    type: 'formula',
    formula: '=1/0',
    value: { type: 'error', code: '#DIV/0!' },
  })
  assert.equal(rows[1][6], null)

  const formulaRows = await sheet.readRows({ range: 'E2:F2', formulaMode: 'formula' })
  assert.deepEqual(formulaRows, [['=B2*2', '=1/0']])

  const dateRows = await sheet.readRows({ range: 'D2', dateMode: 'jsDate' })
  assert.ok(dateRows[0][0] instanceof Date)
  assert.equal(dateRows[0][0].toISOString(), '2026-08-04T12:30:00.000Z')
})

test('uses exact explicit ranges and declared ranges for sparse or empty sheets', async () => {
  const workbook = await openWorkbook(fixtures.primary)

  assert.deepEqual(await workbook.sheet('Sparse').readRows(), [['C3']])
  assert.deepEqual(await workbook.sheet('Sparse').readRows({ range: 'A1:C3' }), [
    [null, null, null],
    [null, null, null],
    [null, null, 'C3'],
  ])
  assert.deepEqual(await workbook.sheet('Empty').readRows(), [])
  assert.deepEqual(await workbook.sheet('Empty').readRows({ range: 'A1:B2' }), [
    [null, null],
    [null, null],
  ])
})

test('bulk and streaming reads produce identical normalized rows', async () => {
  const sheet = (await openWorkbook(fixtures.primary)).sheet('Data')
  const expected = await sheet.readRows({ formulaMode: 'both' })
  const actual = []

  for await (const row of sheet.rows({ formulaMode: 'both', batchSize: 2 })) {
    actual.push(row)
  }

  assert.deepEqual(actual, expected)
})

test('records enforce strict headers and safely deduplicate arbitrary headers', async () => {
  const sheet = (await openWorkbook(fixtures.primary)).sheet('Records')

  await assert.rejects(
    () => sheet.readRecords(),
    (error) => error instanceof XlsxReaderError && error.code === 'INVALID_HEADER'
  )

  const records = await sheet.readRecords({ headerMode: 'dedupe' })
  assert.equal(Object.getPrototypeOf(records[0]), null)
  assert.deepEqual(Object.keys(records[0]), ['__proto__', 'name', 'name_2', 'column_4'])
  assert.equal(records[0].__proto__, 'safe')
  assert.equal(records[0].name_2, 'second')

  const streamed = []
  for await (const record of sheet.records({ headerMode: 'dedupe', batchSize: 1 })) {
    streamed.push(record)
  }
  assert.deepEqual(streamed, records)
})

test('returns merged ranges and hyperlinks', async () => {
  const sheet = (await openWorkbook(fixtures.primary)).sheet('Data')
  assert.deepEqual(await sheet.structuralMetadata(), {
    mergedRanges: ['A4:C4'],
    hyperlinks: [
      {
        range: 'A5',
        target: 'https://example.com',
        location: null,
        displayedText: null,
        tooltip: null,
      },
    ],
  })
})

test('exposes stable error codes for invalid input and selectors', async () => {
  await assert.rejects(
    () => openWorkbook(Buffer.from('not an xlsx archive')),
    (error) => error instanceof XlsxReaderError && error.code === 'CORRUPT_WORKBOOK'
  )

  const workbook = await openWorkbook(fixtures.primary)
  assert.throws(
    () => workbook.sheet('Missing'),
    (error) => error instanceof XlsxReaderError && error.code === 'SHEET_NOT_FOUND'
  )
  await assert.rejects(
    () => workbook.sheet('Data').readRows({ range: 'Sheet1!A1' }),
    (error) => error instanceof XlsxReaderError && error.code === 'INVALID_RANGE'
  )
  await assert.rejects(
    () => workbook.sheet('Data').readRows({ formulaMode: 'calculate' }),
    (error) => error instanceof XlsxReaderError && error.code === 'INVALID_OPTION'
  )
})

test('aborts streaming and releases the source file before iteration rejects', async () => {
  const controller = new AbortController()
  const sheet = (await openWorkbook(fixtures.large)).sheet('Data')
  let rows = 0

  await assert.rejects(
    async () => {
      for await (const row of sheet.rows({ batchSize: 32, signal: controller.signal })) {
        rows += 1
        assert.equal(row.length, 10)
        controller.abort()
      }
    },
    (error) => error instanceof XlsxReaderError && error.code === 'ABORTED'
  )
  assert.equal(rows, 1)

  const moved = `${fixtures.large}.moved`
  fs.renameSync(fixtures.large, moved)
  fs.renameSync(moved, fixtures.large)
})

test('break closes a streaming iterator before control returns', async () => {
  const sheet = (await openWorkbook(fixtures.large)).sheet('Data')
  for await (const row of sheet.rows({ batchSize: 16 })) {
    assert.equal(row.length, 10)
    break
  }

  const moved = `${fixtures.large}.moved`
  fs.renameSync(fixtures.large, moved)
  fs.renameSync(moved, fixtures.large)
})

test('large bulk parsing leaves the event loop responsive', async () => {
  const sheet = (await openWorkbook(fixtures.large)).sheet('Data')
  let ticks = 0
  const interval = setInterval(() => {
    ticks += 1
  }, 10)

  try {
    const rows = await sheet.readRows()
    assert.equal(rows.length, 50_001)
    assert.equal(rows[50_000][9], 500_009)
  } finally {
    clearInterval(interval)
  }

  assert.ok(ticks > 0, 'a 10 ms timer should run while native parsing is active')
})

test('CommonJS and ESM facades expose the same API', async () => {
  const esm = await import(pathToFileURL(path.join(__dirname, '..', 'wrapper.mjs')).href)
  assert.equal(esm.openWorkbook, openWorkbook)
  assert.equal(esm.default.XlsxReaderError, XlsxReaderError)
})
