'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { Workbook, Formula, Format } = require('@nazarkalytiuk/rusc-xlsx')

function createFixtures(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })

  const primary = path.join(directory, 'primary.xlsx')
  const large = path.join(directory, 'large.xlsx')
  createPrimaryFixture(primary)
  createLargeFixture(large)
  return { primary, large }
}

function createPrimaryFixture(filename) {
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
  workbook.save(filename)
}

function createLargeFixture(filename) {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheetWithConstantMemory('Data')
  const columns = 10
  const rows = 50_000

  for (let column = 0; column < columns; column += 1) {
    sheet.write(0, column, `column_${column}`)
  }
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      sheet.write(row, column, row * columns + column)
    }
  }

  workbook.save(filename)
}

module.exports = { createFixtures }
