'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { collect, failsWith, readerError, record } = require('./support/assertions.js')

const records = fixtures.createRecordsWorkbook()
const edges = fixtures.createCellEdgesPackage()
const primary = fixtures.createPrimaryWorkbook()

async function sheet(source, name) {
  return (await openWorkbook(source)).sheet(name)
}

test('strict mode maps a header row below a title to null-prototype records', async () => {
  const table = await sheet(records, 'Table')
  const expected = [
    record({ id: 1, name: 'alpha', amount: 10.5 }),
    record({ id: 2, name: 'beta', amount: null }),
  ]

  assert.deepEqual(await table.readRecords({ headerRow: 1 }), expected)
  assert.deepEqual(await collect(table.records({ headerRow: 1, batchSize: 1 })), expected)
})

test('header rows are relative to the selected range', async () => {
  const table = await sheet(records, 'Table')

  assert.deepEqual(await table.readRecords({ range: 'A2:B3' }), [record({ id: 1, name: 'alpha' })])
  assert.deepEqual(await collect(table.records({ range: 'A2:B3' })), [record({ id: 1, name: 'alpha' })])
  assert.deepEqual(await table.readRecords({ range: 'A1:C4', headerRow: 1 }), [
    record({ id: 1, name: 'alpha', amount: 10.5 }),
    record({ id: 2, name: 'beta', amount: null }),
  ])
})

test('strict mode rejects blank and duplicate headers', async () => {
  const table = await sheet(records, 'Table')
  await assert.rejects(
    () => table.readRecords(),
    readerError('INVALID_HEADER', /column 1 must be a non-empty string/)
  )
  await assert.rejects(
    () => collect(table.records()),
    readerError('INVALID_HEADER', /column 1 must be a non-empty string/)
  )

  const blank = await sheet(edges, 'BlankHeader')
  await assert.rejects(
    () => blank.readRecords(),
    readerError('INVALID_HEADER', /column 0 must be a non-empty string/)
  )

  const typed = await sheet(records, 'Typed')
  await assert.rejects(() => typed.readRecords(), readerError('INVALID_HEADER', /column 0/))

  const duplicates = await sheet(primary, 'Records')
  await assert.rejects(() => duplicates.readRecords(), readerError('INVALID_HEADER', /Duplicate header name/))
})

test('dedupe mode derives keys from typed headers and resolves collisions', async () => {
  const typed = await sheet(records, 'Typed')
  const keys = [
    '42',
    'true',
    '2026-08-04T00:00:00.000',
    'calc',
    '#N/A',
    'column_6',
    'dup',
    'dup_2',
    'dup_2_2',
    'x',
    'x_2',
    'x_3',
    'P1DT12H0M0S',
  ]
  const expected = record(Object.fromEntries(keys.map((key, index) => [key, index + 1])))

  assert.deepEqual(await typed.readRecords({ headerMode: 'dedupe', formulaMode: 'both' }), [expected])
  assert.deepEqual(await typed.readRecords({ headerMode: 'dedupe' }), [expected])
  assert.deepEqual(
    await collect(typed.records({ headerMode: 'dedupe', formulaMode: 'both', batchSize: 1 })),
    [expected]
  )

  // Integer-like keys such as '42' are enumerated first by JavaScript, so
  // these checks address keys by name rather than by position.
  const [jsDateRecord] = await typed.readRecords({ headerMode: 'dedupe', dateMode: 'jsDate' })
  assert.equal(jsDateRecord['2026-08-04T00:00:00.000Z'], 3)
  const [serialRecord] = await typed.readRecords({ headerMode: 'dedupe', dateMode: 'serial' })
  assert.equal(serialRecord['46238'], 3)
  assert.equal(serialRecord['1.5'], 13)
})

test('dedupe mode names blank headers by their column position', async () => {
  const blank = await sheet(edges, 'BlankHeader')

  assert.deepEqual(await blank.readRecords({ headerMode: 'dedupe' }), [
    record({ column_1: 1, name: 'alpha' }),
  ])
})

test('returns no records for empty or header-only selections', async () => {
  const empty = await sheet(records, 'Empty')
  const headerOnly = await sheet(records, 'HeaderOnly')

  for (const worksheet of [empty, headerOnly]) {
    assert.deepEqual(await worksheet.readRecords(), [])
    assert.deepEqual(await collect(worksheet.records()), [])
  }
})

test('rejects a header row outside the selected rows', async () => {
  const table = await sheet(records, 'Table')
  const empty = await sheet(records, 'Empty')
  const outside = /headerRow \d+ is outside the selected rows/

  for (const [worksheet, options] of [
    [table, { headerRow: 4 }],
    [table, { range: 'A1:C2', headerRow: 2 }],
    [empty, { headerRow: 1 }],
  ]) {
    await assert.rejects(() => worksheet.readRecords(options), readerError('INVALID_HEADER', outside))
    await assert.rejects(() => collect(worksheet.records(options)), readerError('INVALID_HEADER', outside))
  }
})

test('validates header options before reading', async () => {
  const table = await sheet(records, 'Table')

  for (const options of [
    { headerRow: -1 },
    { headerRow: 1.5 },
    { headerRow: '1' },
    { headerRow: Number.NaN },
    { headerMode: 'loose' },
    { headerMode: 'Strict' },
  ]) {
    await failsWith(() => table.readRecords(options), 'INVALID_OPTION')
    await failsWith(() => table.records(options), 'INVALID_OPTION')
  }
})
