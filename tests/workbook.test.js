'use strict'

const { after, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openWorkbook, Workbook, Worksheet } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { failsWith, readerError } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rusc-xlsx-reader-workbook-'))

after(() => {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
})

test('selects worksheets by index or exact name with matching metadata', async () => {
  const workbook = await openWorkbook(primary)

  workbook.sheets.forEach((metadata, index) => {
    const byIndex = workbook.sheet(index)
    assert.ok(byIndex instanceof Worksheet)
    assert.deepEqual(byIndex.metadata, metadata)
    assert.deepEqual(workbook.sheet(metadata.name).metadata, metadata)
  })
  assert.deepEqual(await workbook.sheet(2).readRows(), [['C3']])
  assert.deepEqual(await workbook.sheet('Hidden').readRows(), [['secret']])
})

test('rejects sheet indexes past the last sheet instead of wrapping them', async () => {
  const workbook = await openWorkbook(primary)

  for (const index of [5, 2 ** 32, 2 ** 32 + 2, Number.MAX_SAFE_INTEGER, 2 ** 64]) {
    assert.throws(() => workbook.sheet(index), readerError('SHEET_NOT_FOUND'), String(index))
  }
})

test('rejects selectors that are neither names nor non-negative integers', async () => {
  const workbook = await openWorkbook(primary)

  for (const selector of [-1, 1.5, Number.NaN, Infinity, -Infinity, null, undefined, true, {}, [0], 0n]) {
    assert.throws(() => workbook.sheet(selector), readerError('INVALID_SELECTOR'), String(selector))
  }
  for (const name of ['data', ' Data', 'Data ', '0', '']) {
    assert.throws(() => workbook.sheet(name), readerError('SHEET_NOT_FOUND'), JSON.stringify(name))
  }
})

test('exposes workbook and sheet metadata as frozen snapshots', async () => {
  const workbook = await openWorkbook(primary)
  const sheet = workbook.sheet('Data')

  assert.ok(Object.isFrozen(workbook.sheets))
  assert.ok(workbook.sheets.every(Object.isFrozen))
  assert.ok(Object.isFrozen(workbook.definedNames))
  assert.ok(workbook.definedNames.every(Object.isFrozen))
  assert.ok(Object.isFrozen(sheet.metadata))
  assert.throws(() => workbook.sheets.push(workbook.sheets[0]), TypeError)
  assert.throws(() => {
    sheet.metadata.name = 'Renamed'
  }, TypeError)
  assert.equal(workbook.sheet('Data').metadata.name, 'Data')
})

test('Workbook and Worksheet instances come only from the reader', () => {
  assert.throws(() => new Workbook(), TypeError)
  assert.throws(() => new Workbook({}, Symbol('rusc-xlsx-reader-internal')), TypeError)
  assert.throws(() => new Worksheet(), TypeError)
  assert.throws(() => new Worksheet({}, Symbol('rusc-xlsx-reader-internal')), TypeError)
})

test('reports sheet kinds, very hidden sheets, and the 1904 date system', async () => {
  const workbook = await openWorkbook(fixtures.createSheetKindsPackage())

  assert.equal(workbook.epoch, 1904)
  assert.deepEqual(workbook.sheets, [
    { name: 'Data', type: 'worksheet', visibility: 'visible', declaredRange: 'A1:B1' },
    { name: 'Secret', type: 'worksheet', visibility: 'veryHidden', declaredRange: 'A1' },
    { name: 'Chart', type: 'chart', visibility: 'visible', declaredRange: null },
    { name: 'Dialog', type: 'dialog', visibility: 'visible', declaredRange: null },
  ])
  assert.deepEqual(workbook.definedNames, [])
  assert.deepEqual(await workbook.sheet('Secret').readRows(), [['secret']])
})

test('rejects every worksheet operation on chart and dialog sheets', async () => {
  const workbook = await openWorkbook(fixtures.createSheetKindsPackage())

  for (const [name, kind] of [
    ['Chart', 'chart'],
    ['Dialog', 'dialog'],
  ]) {
    const sheet = workbook.sheet(name)
    const notAWorksheet = new RegExp(`Sheet "${name}" is a ${kind} sheet, not a worksheet`)
    for (const operation of [
      () => sheet.readRows(),
      () => sheet.rows(),
      () => sheet.readRecords(),
      () => sheet.records(),
      () => sheet.structuralMetadata(),
    ]) {
      await failsWith(operation, 'NOT_A_WORKSHEET', notAWorksheet)
    }
  }
})

test('rejects packages that hold no sheets', async () => {
  for (const source of [
    fixtures.createSheetlessPackage(),
    fixtures.createMissingWorkbookPartPackage(),
  ]) {
    await assert.rejects(
      () => openWorkbook(source),
      readerError('CORRUPT_WORKBOOK', /Workbook contains no sheets/)
    )
  }
})

test('opens workbooks whose cells hold values the backend cannot decode', async () => {
  const workbook = await openWorkbook(fixtures.createModernErrorPackage())

  assert.deepEqual(
    workbook.sheets.map(({ name, declaredRange }) => ({ name, declaredRange })),
    [
      { name: 'Spill', declaredRange: 'A1:B1' },
      { name: 'Data', declaredRange: 'A1' },
    ]
  )
  assert.deepEqual(await workbook.sheet('Data').readRows(), [[2]])
  assert.deepEqual(await workbook.sheet('Spill').structuralMetadata(), {
    mergedRanges: [],
    hyperlinks: [],
  })

  // Only reading the affected sheet fails. calamine cannot decode Excel 365
  // error values yet (https://github.com/tafia/calamine/issues/754); once it
  // can, this read must return { type: 'error', code: '#SPILL!' } instead.
  await assert.rejects(
    () => workbook.sheet('Spill').readRows(),
    readerError('PARSE_ERROR', /#SPILL!/)
  )
})

test('rejects workbooks that contain an Excel 4.0 macro sheet', async () => {
  // calamine does not recognize the macro sheet relationship yet
  // (https://github.com/tafia/calamine/issues/802), so the whole workbook
  // fails to open. Once it does, this workbook must open and list the sheet
  // with type 'macro'.
  await assert.rejects(
    () => openWorkbook(fixtures.createMacroSheetPackage()),
    readerError('PARSE_ERROR', /Unrecognized sheet:type: xl\/macrosheets\/sheet2\.xml/)
  )
})

test('rejects sources that are not a non-empty path or a Buffer', async () => {
  for (const source of [undefined, null, 42, {}, [], '']) {
    await assert.rejects(() => openWorkbook(source), readerError('INVALID_SOURCE'), String(source))
  }
})

test('reports missing, corrupt, and encrypted sources with stable codes', async () => {
  await assert.rejects(
    () => openWorkbook(path.join(temporaryDirectory, 'missing.xlsx')),
    readerError('SOURCE_NOT_FOUND')
  )
  await assert.rejects(
    () => openWorkbook(fixtures.createEncryptedContainer()),
    readerError('ENCRYPTED_WORKBOOK')
  )
  await assert.rejects(
    () => openWorkbook(fixtures.createMissingSheetPartPackage()),
    readerError('CORRUPT_WORKBOOK')
  )

  const malformed = await openWorkbook(fixtures.createMalformedReferencePackage())
  assert.deepEqual(await malformed.sheet('Valid').readRows(), [[1]])
  await assert.rejects(() => malformed.sheet('Malformed').readRows(), readerError('CORRUPT_WORKBOOK'))
})

test('reopens path sources per read, so a removed file fails later reads', async () => {
  const filename = path.join(temporaryDirectory, 'removed.xlsx')
  fs.writeFileSync(filename, primary)
  const workbook = await openWorkbook(filename)
  const sheet = workbook.sheet('Sparse')
  assert.deepEqual(await sheet.readRows(), [['C3']])

  fs.rmSync(filename)
  await assert.rejects(() => sheet.readRows(), readerError('SOURCE_NOT_FOUND'))
  await assert.rejects(() => sheet.structuralMetadata(), readerError('SOURCE_NOT_FOUND'))
})
