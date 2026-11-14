'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook, XlsxReaderError } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { collect, failsWith, readerError } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()

const NON_OBJECT_OPTIONS = [null, 'A1', 1, true, []]
const INVALID_SIGNALS = [{}, { aborted: false }, { addEventListener() {} }, 'signal']

async function dataSheet() {
  return (await openWorkbook(primary)).sheet('Data')
}

function readOperations(sheet) {
  return [
    (options) => sheet.readRows(options),
    (options) => sheet.rows(options),
    (options) => sheet.readRecords(options),
    (options) => sheet.records(options),
  ]
}

function allOperations(sheet) {
  return [
    ...readOperations(sheet),
    (options) => sheet.structuralMetadata(options),
    (options) => openWorkbook(primary, options),
  ]
}

test('every operation rejects options that are not plain objects', async () => {
  const sheet = await dataSheet()

  for (const operation of allOperations(sheet)) {
    for (const options of NON_OBJECT_OPTIONS) {
      await failsWith(() => operation(options), 'INVALID_OPTION', /options must be an object/)
    }
  }
})

test('every operation rejects signals that are not AbortSignals', async () => {
  const sheet = await dataSheet()

  for (const operation of allOperations(sheet)) {
    for (const signal of INVALID_SIGNALS) {
      await failsWith(() => operation({ signal }), 'INVALID_OPTION', /signal must be an AbortSignal/)
    }
  }
})

test('read operations validate range, formula mode, and date mode', async () => {
  const sheet = await dataSheet()

  for (const operation of readOperations(sheet)) {
    await failsWith(() => operation({ range: 5 }), 'INVALID_OPTION', /range must be an A1 range string/)
    for (const formulaMode of ['calculate', 'Value', '']) {
      await failsWith(() => operation({ formulaMode }), 'INVALID_OPTION', /formulaMode/)
    }
    for (const dateMode of ['calendar', 'jsdate', '']) {
      await failsWith(() => operation({ dateMode }), 'INVALID_OPTION', /dateMode/)
    }
  }
})

test('null never stands in for an omitted option', async () => {
  const sheet = await dataSheet()
  const optionsByOperation = [
    [(options) => sheet.readRows(options), ['range', 'formulaMode', 'dateMode', 'signal']],
    [(options) => sheet.rows(options), ['range', 'formulaMode', 'dateMode', 'signal', 'batchSize']],
    [
      (options) => sheet.readRecords(options),
      ['range', 'formulaMode', 'dateMode', 'signal', 'headerRow', 'headerMode'],
    ],
    [
      (options) => sheet.records(options),
      ['range', 'formulaMode', 'dateMode', 'signal', 'batchSize', 'headerRow', 'headerMode'],
    ],
    [(options) => sheet.structuralMetadata(options), ['signal']],
    [(options) => openWorkbook(primary, options), ['signal']],
  ]

  for (const [operation, names] of optionsByOperation) {
    for (const name of names) {
      await failsWith(() => operation({ [name]: null }), 'INVALID_OPTION', new RegExp(name))
    }
  }
})

test('undefined options take their documented defaults', async () => {
  const sheet = await dataSheet()
  const omitted = {
    range: undefined,
    formulaMode: undefined,
    dateMode: undefined,
    signal: undefined,
  }

  assert.deepEqual(await sheet.readRows(omitted), await sheet.readRows())
  assert.deepEqual(
    await sheet.readRecords({ ...omitted, headerRow: undefined, headerMode: undefined }),
    await sheet.readRecords()
  )
  assert.deepEqual(
    await collect(sheet.rows({ ...omitted, batchSize: undefined })),
    await sheet.readRows()
  )
})

test('XlsxReaderError carries a stable code, its name, and the native cause', async () => {
  const cause = new Error('root cause')
  const direct = new XlsxReaderError('INVALID_RANGE', 'bad range', { cause })
  assert.ok(direct instanceof Error)
  assert.equal(direct.name, 'XlsxReaderError')
  assert.equal(direct.code, 'INVALID_RANGE')
  assert.equal(direct.message, 'bad range')
  assert.equal(direct.cause, cause)

  const workbook = await openWorkbook(primary)
  assert.throws(
    () => workbook.sheet('Missing'),
    (error) => {
      readerError('SHEET_NOT_FOUND')(error)
      assert.equal(error.name, 'XlsxReaderError')
      assert.equal(error.message, 'Worksheet "Missing" was not found')
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /^\[SHEET_NOT_FOUND\] /)
      return true
    }
  )

  await assert.rejects(
    () => workbook.sheet('Data').readRows({ range: 'B2:A1' }),
    (error) => {
      readerError('INVALID_RANGE')(error)
      assert.doesNotMatch(error.message, /^\[/)
      assert.match(error.cause.message, /^\[INVALID_RANGE\] /)
      return true
    }
  )

  const invalidSource = await openWorkbook(42).catch((error) => error)
  readerError('INVALID_SOURCE')(invalidSource)
  assert.equal(invalidSource.cause, undefined)
})
