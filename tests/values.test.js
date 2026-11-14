'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { readerError } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()
const values = fixtures.createValuesWorkbook()
const edges = fixtures.createCellEdgesPackage()
const sheetKinds = fixtures.createSheetKindsPackage()

async function readCells(source, sheetName, options) {
  const workbook = await openWorkbook(source)
  return workbook.sheet(sheetName).readRows(options)
}

test('converts serial datetimes in every date mode', async () => {
  const serial = 46238.520833333336
  const read = (dateMode) => readCells(primary, 'Data', { range: 'D2', dateMode })

  assert.deepEqual(await read('object'), [
    [{ type: 'datetime', serial, iso: '2026-08-04T12:30:00.000', epoch: 1900 }],
  ])
  assert.deepEqual(await read('serial'), [[serial]])
  assert.deepEqual(await read('iso'), [['2026-08-04T12:30:00.000']])
  assert.deepEqual(await read('jsDate'), [[new Date('2026-08-04T12:30:00.000Z')]])

  assert.deepEqual(await readCells(values, 'Dates', { range: 'A1' }), [
    [{ type: 'datetime', serial: 46238, iso: '2026-08-04T00:00:00.000', epoch: 1900 }],
  ])
})

test('keeps datetimes outside the calendar range lossless in every date mode', async () => {
  const tagged = { type: 'datetime', serial: 1e10, iso: null, epoch: 1900 }
  const read = (dateMode) => readCells(values, 'Dates', { range: 'B1', dateMode })

  assert.deepEqual(await read('object'), [[tagged]])
  assert.deepEqual(await read('serial'), [[1e10]])
  assert.deepEqual(await read('iso'), [[tagged]])
  assert.deepEqual(await read('jsDate'), [[tagged]])
})

test('converts serial dates from the 1904 date system', async () => {
  const read = (dateMode) => readCells(sheetKinds, 'Data', { dateMode })

  assert.deepEqual(await read('object'), [
    [{ type: 'datetime', serial: 44776, iso: '2026-08-04T00:00:00.000', epoch: 1904 }, 0],
  ])
  assert.deepEqual(await read('serial'), [[44776, 0]])
  assert.deepEqual(await read('iso'), [['2026-08-04T00:00:00.000', 0]])
  assert.deepEqual(await read('jsDate'), [[new Date('2026-08-04T00:00:00.000Z'), 0]])
})

test('converts durations in every date mode', async () => {
  const tagged = [
    { type: 'duration', serial: 1.5, iso: 'P1DT12H0M0S' },
    { type: 'duration', serial: 0.5104166666666666, iso: 'P0DT12H15M0S' },
  ]
  const read = (dateMode) => readCells(values, 'Durations', { dateMode })

  assert.deepEqual(await read('object'), [tagged])
  assert.deepEqual(await read('serial'), [[1.5, 0.5104166666666666]])
  assert.deepEqual(await read('iso'), [['P1DT12H0M0S', 'P0DT12H15M0S']])
  assert.deepEqual(await read('jsDate'), [tagged])
})

test('reads ISO 8601 date cells in every date mode', async () => {
  const stored = [
    '2026-08-04T12:30:00',
    '2026-08-04T12:30:00.250',
    '2026-08-04 12:30:00',
    '2026-08-04',
    '2026-08-04T12:30:00+02:00',
    'not-a-date',
  ]
  const tagged = (iso) => ({ type: 'datetime', serial: null, iso, epoch: null })
  const read = (dateMode) => readCells(edges, 'Iso', { dateMode })

  assert.deepEqual(await read('object'), [stored.map(tagged)])
  assert.deepEqual(await read('serial'), [stored])
  assert.deepEqual(await read('iso'), [stored])
  assert.deepEqual(await read('jsDate'), [
    [
      new Date('2026-08-04T12:30:00.000Z'),
      new Date('2026-08-04T12:30:00.250Z'),
      new Date('2026-08-04T12:30:00.000Z'),
      new Date('2026-08-04T00:00:00.000Z'),
      new Date('2026-08-04T10:30:00.000Z'),
      tagged('not-a-date'),
    ],
  ])
})

test('reports every Excel error code as a tagged value', async () => {
  const errors = fixtures.EXCEL_ERROR_CODES.map((code) => ({ type: 'error', code }))

  assert.deepEqual(await readCells(values, 'Errors'), [errors])
  assert.deepEqual(await readCells(values, 'Errors', { formulaMode: 'formula' }), [
    fixtures.EXCEL_ERROR_CODES.map(() => '=NA()'),
  ])
  assert.deepEqual(await readCells(values, 'Errors', { formulaMode: 'both' }), [
    errors.map((value) => ({ type: 'formula', formula: '=NA()', value })),
  ])
})

test('reports Excel 365 errors saved by Excel by their cached #VALUE! code', async () => {
  // Excel caches #VALUE! for #SPILL! and #CALC! and keeps the real code in
  // rich-value metadata, which calamine does not read yet
  // (https://github.com/tafia/calamine/issues/754). Once it does, these cells
  // must report '#SPILL!' and '#CALC!'.
  const source = fixtures.createRichValueErrorPackage()
  const value = { type: 'error', code: '#VALUE!' }

  assert.deepEqual(await readCells(source, 'Excel', { formulaMode: 'both' }), [
    [{ type: 'formula', formula: '=_xlfn.SEQUENCE(1,2)', value }, 'blocker'],
    [{ type: 'formula', formula: '=_xlfn.LAMBDA(_xlpm.x,_xlpm.x)', value }, null],
  ])
})

test('formula modes leave plain cells untouched and keep uncached formulas empty', async () => {
  assert.deepEqual(await readCells(primary, 'Data', { range: 'A2:F2', formulaMode: 'formula' }), [
    [
      'alpha',
      21.5,
      true,
      { type: 'datetime', serial: 46238.520833333336, iso: '2026-08-04T12:30:00.000', epoch: 1900 },
      '=B2*2',
      '=1/0',
    ],
  ])
  assert.deepEqual(await readCells(primary, 'Data', { range: 'E2:F2', formulaMode: 'value' }), [
    [43, { type: 'error', code: '#DIV/0!' }],
  ])
  assert.deepEqual(await readCells(primary, 'Data', { range: 'E2:F2' }), [
    [43, { type: 'error', code: '#DIV/0!' }],
  ])

  assert.deepEqual(await readCells(edges, 'Cells', { formulaMode: 'value' }), [[1, null, null]])
  assert.deepEqual(await readCells(edges, 'Cells', { formulaMode: 'formula' }), [[1, null, '=A1*2']])
  assert.deepEqual(await readCells(edges, 'Cells', { formulaMode: 'both' }), [
    [1, null, { type: 'formula', formula: '=A1*2', value: null }],
  ])
})

test('pads declared ranges that extend past the stored cells', async () => {
  const workbook = await openWorkbook(edges)
  const sheet = workbook.sheet('Padded')

  assert.equal(sheet.metadata.declaredRange, 'A1:B3')
  assert.deepEqual(await sheet.readRows(), [
    [1, null],
    [null, null],
    [null, null],
  ])
})

test('rejects cells outside the declared range unless an explicit range is given', async () => {
  const workbook = await openWorkbook(edges)
  const sheet = workbook.sheet('Overflow')

  await assert.rejects(
    () => sheet.readRows(),
    readerError('CORRUPT_WORKBOOK', /B3 is outside declared worksheet range A1:A2/)
  )
  assert.deepEqual(await sheet.readRows({ range: 'A1:B3' }), [
    [1, null],
    [2, null],
    [null, 3],
  ])
  assert.deepEqual(await sheet.readRows({ range: 'A1:A2' }), [[1], [2]])
})

test('accepts absolute, lowercase, and padded A1 ranges', async () => {
  const expected = await readCells(primary, 'Data', { range: 'A1:B2' })

  for (const range of ['$A$1:$B$2', 'a1:b2', ' A1:B2 ', 'A$1:$B2']) {
    assert.deepEqual(await readCells(primary, 'Data', { range }), expected, range)
  }
})

test('rejects ranges outside inclusive A1 syntax', async () => {
  const workbook = await openWorkbook(primary)
  const sheet = workbook.sheet('Data')

  for (const range of ['', 'A:A', '1:2', 'B2:A1', 'XFE1', 'A1048577', 'Data!A1', 'R1C1', 'A1:B2:C3']) {
    await assert.rejects(() => sheet.readRows({ range }), readerError('INVALID_RANGE'), range)
  }
})

test('reads explicit ranges beyond the stored data as empty cells', async () => {
  const workbook = await openWorkbook(primary)
  const sheet = workbook.sheet('Sparse')

  assert.deepEqual(await sheet.readRows({ range: 'D4:E5' }), [
    [null, null],
    [null, null],
  ])
  assert.deepEqual(await sheet.readRows({ range: 'XFD1048576' }), [[null]])
})
