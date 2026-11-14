'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Workbook, Formula, Format } = require('@nazarkalytiuk/rusc-xlsx')
const {
  createEncryptedContainer,
  createWorkbookPackage,
  createZip,
} = require('./support/ooxml.js')

const HYPERLINK_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
const EXCEL_ERROR_CODES = ['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!']

function createFixtures(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })

  const primary = path.join(directory, 'primary.xlsx')
  const large = path.join(directory, 'large.xlsx')
  buildPrimaryWorkbook().save(primary)
  buildLargeWorkbook().save(large)
  return { primary, large }
}

function createPrimaryWorkbook() {
  return buildPrimaryWorkbook().saveToBuffer()
}

/**
 * A header row followed by `rows` numeric rows of ten columns, where the cell
 * at (row, column) holds `row * 10 + column`.
 */
function createNumberedWorkbook(rows) {
  return buildNumberedWorkbook(rows).saveToBuffer()
}

function buildPrimaryWorkbook() {
  const workbook = new Workbook()
  const data = workbook.addWorksheet('Data')
  const dateFormat = new Format().setNumFormat('yyyy-mm-dd hh:mm:ss')

  ;['text', 'number', 'boolean', 'date', 'formula', 'error', 'empty'].forEach(
    (header, column) => data.write(0, column, header)
  )
  data.write(1, 0, 'alpha')
  data.write(1, 1, 21.5)
  data.writeBoolean(1, 2, true)
  data.writeDatetimeFromYmdHms(1, 3, 2026, 8, 4, 12, 30, 0, dateFormat)
  data.writeFormula(1, 4, new Formula('=B2*2').setResult('43'))
  data.writeFormula(1, 5, new Formula('=1/0').setResult('#DIV/0!'))
  data.mergeRange(3, 0, 3, 2, 'Merged')
  data.writeUrlWithText(4, 0, 'https://example.com', 'Example')

  const hidden = workbook.addWorksheet('Hidden')
  hidden.write(0, 0, 'secret')
  hidden.setHidden(true)

  const sparse = workbook.addWorksheet('Sparse')
  sparse.write(2, 2, 'C3')

  const records = workbook.addWorksheet('Records')
  records.write(0, 0, '__proto__')
  records.write(0, 1, 'name')
  records.write(0, 2, 'name')
  records.write(1, 0, 'safe')
  records.write(1, 1, 'first')
  records.write(1, 2, 'second')
  records.write(1, 3, 'blank-header')

  workbook.addWorksheet('Empty')
  workbook.defineName('DataRange', '=Data!$A$1:$G$5')
  return workbook
}

function buildLargeWorkbook() {
  return buildNumberedWorkbook(50_000)
}

function buildNumberedWorkbook(rows) {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheetWithConstantMemory('Data')
  const columns = 10

  for (let column = 0; column < columns; column += 1) {
    sheet.write(0, column, `column_${column}`)
  }
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      sheet.write(row, column, row * columns + column)
    }
  }

  return workbook
}

/** Durations, every Excel error code, date-only and unrepresentable dates. */
function createValuesWorkbook() {
  const workbook = new Workbook()
  const durationFormat = new Format().setNumFormat('[h]:mm:ss')
  const dateFormat = new Format().setNumFormat('yyyy-mm-dd')

  const durations = workbook.addWorksheet('Durations')
  durations.write(0, 0, 1.5, durationFormat)
  durations.write(0, 1, 0.5104166666666666, durationFormat)

  const errors = workbook.addWorksheet('Errors')
  EXCEL_ERROR_CODES.forEach((code, column) => {
    errors.writeFormula(0, column, new Formula('=NA()').setResult(code))
  })

  const dates = workbook.addWorksheet('Dates')
  dates.writeDatetimeFromYmd(0, 0, 2026, 8, 4, dateFormat)
  dates.write(0, 1, 1e10, dateFormat)

  return workbook.saveToBuffer()
}

/** Header rows below a title, typed and colliding headers, header-only sheets. */
function createRecordsWorkbook() {
  const workbook = new Workbook()
  const dateFormat = new Format().setNumFormat('yyyy-mm-dd')
  const durationFormat = new Format().setNumFormat('[h]:mm:ss')

  const table = workbook.addWorksheet('Table')
  table.write(0, 0, 'Quarterly report')
  table.writeRow(1, 0, ['id', 'name', 'amount'])
  table.writeRow(2, 0, [1, 'alpha', 10.5])
  table.writeRow(3, 0, [2, 'beta'])

  const typed = workbook.addWorksheet('Typed')
  typed.write(0, 0, 42)
  typed.writeBoolean(0, 1, true)
  typed.writeDatetimeFromYmd(0, 2, 2026, 8, 4, dateFormat)
  typed.writeFormula(0, 3, new Formula('="calc"').setResult('calc'))
  typed.writeFormula(0, 4, new Formula('=NA()').setResult('#N/A'))
  // Column F (index 5) is intentionally left blank.
  typed.writeRow(0, 6, ['dup', 'dup', 'dup_2', 'x', 'x_2', 'x'])
  typed.write(0, 12, 1.5, durationFormat)
  for (let column = 0; column < 13; column += 1) {
    typed.write(1, column, column + 1)
  }

  const headerOnly = workbook.addWorksheet('HeaderOnly')
  headerOnly.writeRow(0, 0, ['id', 'name'])

  workbook.addWorksheet('Empty')
  return workbook.saveToBuffer()
}

/**
 * Sheet kinds and workbook properties the fixture writer cannot emit: a very
 * hidden worksheet, chart and dialog sheets, and the 1904 date system.
 */
function createSheetKindsPackage() {
  return createWorkbookPackage({
    date1904: true,
    styles:
      '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>',
    sheets: [
      {
        name: 'Data',
        body:
          '<dimension ref="A1:B1"/>' +
          sheetData('<row r="1"><c r="A1" s="1"><v>44776</v></c><c r="B1"><v>0</v></c></row>'),
      },
      {
        name: 'Secret',
        state: 'veryHidden',
        body:
          '<dimension ref="A1"/>' +
          sheetData('<row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row>'),
      },
      { name: 'Chart', kind: 'chartsheet', body: sheetViews() },
      { name: 'Dialog', kind: 'dialogsheet', body: sheetViews() },
    ],
  })
}

/**
 * Cell encodings and worksheet structures the fixture writer cannot emit:
 * ISO `t="d"` cells, value-less cells, uncached formulas, declared ranges that
 * disagree with the data, and hyperlinks with locations and tooltips.
 */
function createCellEdgesPackage() {
  const isoValues = [
    '2026-08-04T12:30:00',
    '2026-08-04T12:30:00.250',
    '2026-08-04 12:30:00',
    '2026-08-04',
    '2026-08-04T12:30:00+02:00',
    'not-a-date',
  ]

  return createWorkbookPackage({
    sheets: [
      {
        name: 'Iso',
        body:
          '<dimension ref="A1:F1"/>' +
          sheetData(
            `<row r="1">${isoValues
              .map((value, column) => `<c r="${'ABCDEF'[column]}1" t="d"><v>${value}</v></c>`)
              .join('')}</row>`
          ),
      },
      {
        name: 'Cells',
        body:
          '<dimension ref="A1:C1"/>' +
          sheetData('<row r="1"><c r="A1"><v>1</v></c><c r="B1"></c><c r="C1"><f>A1*2</f></c></row>'),
      },
      {
        name: 'Padded',
        body: '<dimension ref="A1:B3"/>' + sheetData('<row r="1"><c r="A1"><v>1</v></c></row>'),
      },
      {
        name: 'Overflow',
        body:
          '<dimension ref="A1:A2"/>' +
          sheetData(
            '<row r="1"><c r="A1"><v>1</v></c></row>' +
              '<row r="2"><c r="A2"><v>2</v></c></row>' +
              '<row r="3"><c r="B3"><v>3</v></c></row>'
          ),
      },
      {
        name: 'Links',
        body:
          '<dimension ref="A1:C3"/>' +
          sheetData('<row r="1"><c r="A1"><v>1</v></c></row>') +
          '<mergeCells count="2"><mergeCell ref="A2:B2"/><mergeCell ref="C2:C3"/></mergeCells>' +
          '<hyperlinks>' +
          '<hyperlink ref="A1" location="Iso!A1" display="Go to Iso" tooltip="Jump"/>' +
          '<hyperlink ref="B1:C1" r:id="rId1" tooltip="Docs"/>' +
          '</hyperlinks>',
        relationships: [
          {
            id: 'rId1',
            type: HYPERLINK_RELATIONSHIP,
            target: 'https://example.com/docs',
            external: true,
          },
        ],
      },
      {
        name: 'BlankHeader',
        body:
          '<dimension ref="A1:B2"/>' +
          sheetData(
            '<row r="1"><c r="A1" t="str"><v></v></c>' +
              '<c r="B1" t="inlineStr"><is><t>name</t></is></c></row>' +
              '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>alpha</t></is></c></row>'
          ),
      },
    ],
  })
}

/** A workbook whose worksheet cell references are malformed. */
function createMalformedReferencePackage() {
  return createWorkbookPackage({
    sheets: [
      {
        name: 'Valid',
        body: '<dimension ref="A1"/>' + sheetData('<row r="1"><c r="A1"><v>1</v></c></row>'),
      },
      {
        name: 'Malformed',
        body:
          '<dimension ref="A1:B1"/>' +
          sheetData('<row r="1"><c r="A1"><v>1</v></c><c r="1B"><v>2</v></c></row>'),
      },
    ],
  })
}

/** A workbook that declares a worksheet whose part is missing from the archive. */
function createMissingSheetPartPackage() {
  return createWorkbookPackage({
    sheets: [
      {
        name: 'Valid',
        body: '<dimension ref="A1"/>' + sheetData('<row r="1"><c r="A1"><v>1</v></c></row>'),
      },
      { name: 'Missing' },
    ],
  })
}

/** A workbook part whose `<sheets>` list is empty, which SpreadsheetML forbids. */
function createSheetlessPackage() {
  return createWorkbookPackage({ sheets: [] })
}

/**
 * A package whose relationships are intact but whose workbook part
 * (`xl/workbook.xml`) is missing from the archive.
 */
function createMissingWorkbookPartPackage() {
  const relationships = (entries) =>
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`
  const relationshipType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

  return createZip([
    [
      '_rels/.rels',
      relationships(
        `<Relationship Id="rId1" Type="${relationshipType}/officeDocument" Target="xl/workbook.xml"/>`
      ),
    ],
    [
      'xl/_rels/workbook.xml.rels',
      relationships(
        `<Relationship Id="rId1" Type="${relationshipType}/worksheet" Target="worksheets/sheet1.xml"/>`
      ),
    ],
  ])
}

/**
 * An Excel 365 error code stored literally in `<v>`, as some writers other
 * than Excel do. calamine cannot decode these codes yet:
 * https://github.com/tafia/calamine/issues/754
 */
function createModernErrorPackage() {
  return createWorkbookPackage({
    sheets: [
      {
        name: 'Spill',
        body:
          '<dimension ref="A1:B1"/>' +
          sheetData(
            '<row r="1"><c r="A1" t="e"><f>SEQUENCE(1,2)</f><v>#SPILL!</v></c>' +
              '<c r="B1"><v>1</v></c></row>'
          ),
      },
      {
        name: 'Data',
        body: '<dimension ref="A1"/>' + sheetData('<row r="1"><c r="A1"><v>2</v></c></row>'),
      },
    ],
  })
}

/** A worksheet next to an Excel 4.0 macro sheet, as found in `.xlsm` files. */
function createMacroSheetPackage() {
  return createWorkbookPackage({
    sheets: [
      {
        name: 'Data',
        body: '<dimension ref="A1"/>' + sheetData('<row r="1"><c r="A1"><v>1</v></c></row>'),
      },
      {
        name: 'Macro1',
        kind: 'macrosheet',
        body:
          '<dimension ref="A1:A2"/>' +
          sheetData(
            '<row r="1"><c r="A1" t="b"><f>ECHO(FALSE)</f><v>1</v></c></row>' +
              '<row r="2"><c r="A2" t="b"><f>RETURN()</f><v>1</v></c></row>'
          ),
      },
    ],
  })
}

const RICH_DATA_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata'
const RICH_DATA_RELATIONSHIP_NS = 'http://schemas.microsoft.com/office/2017/06/relationships'

/**
 * Excel 365 errors as Excel itself saves them, modeled on a workbook saved by
 * Excel 365 for Mac: the cell caches `#VALUE!`, and its `vm` attribute points
 * through `xl/metadata.xml` to a rich value holding the real error type (8 is
 * `#SPILL!`, 13 is `#CALC!`).
 */
function createRichValueErrorPackage() {
  const richValueBlock = (index) =>
    '<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}">' +
    `<xlrd:rvb i="${index}"/></ext></extLst></bk>`

  return createWorkbookPackage({
    sheets: [
      {
        name: 'Excel',
        body:
          '<dimension ref="A1:B2"/>' +
          sheetData(
            '<row r="1"><c r="A1" t="e" vm="1"><f t="array" ref="A1">_xlfn.SEQUENCE(1,2)</f><v>#VALUE!</v></c>' +
              '<c r="B1" t="inlineStr"><is><t>blocker</t></is></c></row>' +
              '<row r="2"><c r="A2" t="e" vm="2"><f>_xlfn.LAMBDA(_xlpm.x,_xlpm.x)</f><v>#VALUE!</v></c></row>'
          ),
      },
    ],
    parts: [
      {
        path: 'metadata.xml',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
        xml:
          '<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          `xmlns:xlrd="${RICH_DATA_NS}">` +
          '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" ' +
          'copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" ' +
          'clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>' +
          `<futureMetadata name="XLRICHVALUE" count="2">${richValueBlock(0)}${richValueBlock(1)}</futureMetadata>` +
          '<valueMetadata count="2"><bk><rc t="1" v="0"/></bk><bk><rc t="1" v="1"/></bk></valueMetadata>' +
          '</metadata>',
      },
      {
        path: 'richData/rdrichvalue.xml',
        type: `${RICH_DATA_RELATIONSHIP_NS}/rdRichValue`,
        contentType: 'application/vnd.ms-excel.rdrichvalue+xml',
        xml:
          `<rvData xmlns="${RICH_DATA_NS}" count="2">` +
          '<rv s="0"><v>1</v><v>8</v><v>0</v><v>1</v></rv><rv s="1"><v>13</v><v>24</v></rv></rvData>',
      },
      {
        path: 'richData/rdrichvaluestructure.xml',
        type: `${RICH_DATA_RELATIONSHIP_NS}/rdRichValueStructure`,
        contentType: 'application/vnd.ms-excel.rdrichvaluestructure+xml',
        xml:
          `<rvStructures xmlns="${RICH_DATA_NS}" count="2">` +
          '<s t="_error"><k n="colOffset" t="i"/><k n="errorType" t="i"/><k n="rwOffset" t="i"/><k n="subType" t="i"/></s>' +
          '<s t="_error"><k n="errorType" t="i"/><k n="subType" t="i"/></s></rvStructures>',
      },
    ],
  })
}

function sheetData(rows) {
  return `<sheetData>${rows}</sheetData>`
}

function sheetViews() {
  return '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
}

module.exports = {
  EXCEL_ERROR_CODES,
  createCellEdgesPackage,
  createEncryptedContainer,
  createFixtures,
  createMacroSheetPackage,
  createMalformedReferencePackage,
  createMissingSheetPartPackage,
  createMissingWorkbookPartPackage,
  createModernErrorPackage,
  createNumberedWorkbook,
  createPrimaryWorkbook,
  createRecordsWorkbook,
  createRichValueErrorPackage,
  createSheetKindsPackage,
  createSheetlessPackage,
  createValuesWorkbook,
}
