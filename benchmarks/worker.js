'use strict'

const { performance } = require('node:perf_hooks')

const mode = process.argv[2]
const filename = process.argv[3]
const rowLimit = Number(process.argv[4])
const profile = process.argv[5] || 'throughput'
const columns = 20

if (!['reader', 'xlsx', 'exceljs'].includes(mode) || !Number.isInteger(rowLimit) || rowLimit < 1) {
  throw new Error('Usage: worker.js <reader|xlsx|exceljs> <file> <rowLimit> <throughput|memory>')
}

let baseline
let peakHeap
let peakRss
let cells = 0
let numericChecksum = 0
let stringChecksum = 0

function resetMemory() {
  global.gc?.()
  baseline = process.memoryUsage()
  peakHeap = baseline.heapUsed
  peakRss = baseline.rss
}

function sampleMemory(forceGc = false) {
  if (forceGc) global.gc?.()
  const memory = process.memoryUsage()
  peakHeap = Math.max(peakHeap, memory.heapUsed)
  peakRss = Math.max(peakRss, memory.rss)
}

function consume(value) {
  cells += 1
  if (typeof value === 'number') numericChecksum += value
  else if (typeof value === 'string') stringChecksum += value.length
  else if (typeof value === 'boolean') numericChecksum += value ? 1 : 0
}

async function runReader() {
  const { openWorkbook } = require('../wrapper.js')
  resetMemory()
  const started = performance.now()
  const workbook = await openWorkbook(filename)
  const sheet = workbook.sheet(0)
  let rows = 0

  for await (const row of sheet.rows({
    range: `A1:T${rowLimit}`,
    batchSize: 4096,
    dateMode: 'serial',
  })) {
    for (const value of row) consume(value)
    rows += 1
    if (rows % 4096 === 0) sampleMemory(profile === 'memory')
  }

  sampleMemory(profile === 'memory')
  return performance.now() - started
}

async function runSheetJs() {
  const XLSX = require('xlsx')
  resetMemory()
  const started = performance.now()
  const workbook = XLSX.readFile(filename, { dense: true, cellDates: false })
  sampleMemory(profile === 'memory')
  const rows = workbook.Sheets[workbook.SheetNames[0]]['!data']

  for (let row = 0; row < rowLimit; row += 1) {
    const denseRow = rows[row] || []
    for (let column = 0; column < columns; column += 1) {
      consume(denseRow[column]?.v ?? null)
    }
    if ((row + 1) % 4096 === 0) sampleMemory(profile === 'memory')
  }

  sampleMemory(profile === 'memory')
  return performance.now() - started
}

async function runExcelJs() {
  const ExcelJS = require('exceljs')
  resetMemory()
  const started = performance.now()
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filename, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  })
  let rows = 0
  let finished = false

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      for (let column = 1; column <= columns; column += 1) {
        consume(row.getCell(column).value)
      }
      rows += 1
      if (rows % 4096 === 0) sampleMemory(profile === 'memory')
      if (rows === rowLimit) {
        finished = true
        break
      }
    }
    if (finished) break
  }

  sampleMemory(profile === 'memory')
  return performance.now() - started
}

;(async () => {
  const runners = {
    reader: runReader,
    xlsx: runSheetJs,
    exceljs: runExcelJs,
  }
  const durationMs = await runners[mode]()
  console.log(JSON.stringify({
    mode,
    profile,
    rows: rowLimit,
    cells,
    durationMs,
    cellsPerSecond: cells / (durationMs / 1000),
    numericChecksum,
    stringChecksum,
    heapDelta: peakHeap - baseline.heapUsed,
    rssDelta: peakRss - baseline.rss,
  }))
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
