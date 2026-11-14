'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Workbook } = require('@nazarkalytiuk/rusc-xlsx')
const { version: excelJsVersion } = require('exceljs/package.json')
const { version: sheetJsVersion } = require('xlsx')

const ROWS = 200_000
const SMALL_ROWS = 20_000
const COLUMNS = 20
const ROUNDS = 3
const MODES = ['reader', 'xlsx', 'exceljs']
const directory = path.join(__dirname, '.tmp')
const filename = path.join(directory, 'reading-200k-x20.xlsx')
const worker = path.join(__dirname, 'worker.js')

fs.rmSync(directory, { recursive: true, force: true })
fs.mkdirSync(directory, { recursive: true })

try {
  generateFixture(filename)

  const throughputResults = Object.fromEntries(MODES.map((mode) => [mode, []]))
  for (let round = 0; round < ROUNDS; round += 1) {
    const order = MODES.map((_, offset) => MODES[(round + offset) % MODES.length])
    for (const mode of order) {
      throughputResults[mode].push(run(mode, ROWS, 'throughput'))
    }
  }

  const throughput = Object.fromEntries(
    MODES.map((mode) => [mode, medianResult(throughputResults[mode])])
  )
  const memory = Object.fromEntries(
    MODES.map((mode) => [
      mode,
      medianResult(Array.from({ length: ROUNDS }, () => run(mode, ROWS, 'memory'))),
    ])
  )
  const readerSmallMemory = medianResult(
    Array.from({ length: ROUNDS }, () => run('reader', SMALL_ROWS, 'memory'))
  )

  for (const mode of MODES.slice(1)) {
    assertSameChecksum(throughput.reader, throughput[mode])
    assertSameChecksum(memory.reader, memory[mode])
  }

  const throughputRatio = {
    xlsx: throughput.reader.cellsPerSecond / throughput.xlsx.cellsPerSecond,
    exceljs: throughput.reader.cellsPerSecond / throughput.exceljs.cellsPerSecond,
  }
  const heapRatio = {
    xlsx: memory.reader.heapDelta / memory.xlsx.heapDelta,
    exceljs: memory.reader.heapDelta / memory.exceljs.heapDelta,
  }
  const boundedHeapRatio = memory.reader.heapDelta / readerSmallMemory.heapDelta

  console.log(`Workload: ${ROWS.toLocaleString('en-US')} rows x ${COLUMNS} columns`)
  console.table([
    displayResult('rusc reader (stream)', throughput.reader, memory.reader),
    displayResult(`ExcelJS ${excelJsVersion} (stream)`, throughput.exceljs, memory.exceljs),
    displayResult(`xlsx ${sheetJsVersion} (dense)`, throughput.xlsx, memory.xlsx),
  ])
  console.log(`rusc / ExcelJS throughput: ${throughputRatio.exceljs.toFixed(2)}x`)
  console.log(`rusc / xlsx throughput: ${throughputRatio.xlsx.toFixed(2)}x`)
  console.log(`rusc / ExcelJS peak JS heap: ${(heapRatio.exceljs * 100).toFixed(1)}%`)
  console.log(`rusc / xlsx peak JS heap: ${(heapRatio.xlsx * 100).toFixed(1)}%`)
  console.log(`200k / 20k reader heap ratio: ${(boundedHeapRatio * 100).toFixed(1)}%`)

  const failures = []
  if (throughputRatio.xlsx < 1.5) {
    failures.push(`xlsx throughput ${throughputRatio.xlsx.toFixed(2)}x is below 1.50x`)
  }
  if (heapRatio.xlsx > 0.6) {
    failures.push(`xlsx heap ratio ${(heapRatio.xlsx * 100).toFixed(1)}% exceeds 60%`)
  }
  if (boundedHeapRatio > 1.25) {
    failures.push(`bounded heap ratio ${(boundedHeapRatio * 100).toFixed(1)}% exceeds 125%`)
  }

  if (failures.length > 0) {
    throw new Error(`Acceptance benchmark failed: ${failures.join('; ')}`)
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}

function generateFixture(target) {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheetWithConstantMemory('Data')

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      if (column % 2 === 0) sheet.write(row, column, row * COLUMNS + column)
      else sheet.write(row, column, `category_${row % 1000}`)
    }
  }

  workbook.save(target)
}

function run(mode, rows, profile) {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', worker, mode, filename, String(rows), profile],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )

  if (result.status !== 0) {
    throw new Error(`${mode} benchmark failed:\n${result.stderr || result.stdout}`)
  }

  const line = result.stdout.trim().split('\n').at(-1)
  return JSON.parse(line)
}

function medianResult(results) {
  const median = (field) => {
    const values = results.map((result) => result[field]).sort((left, right) => left - right)
    return values[Math.floor(values.length / 2)]
  }

  return {
    ...results[0],
    durationMs: median('durationMs'),
    cellsPerSecond: median('cellsPerSecond'),
    heapDelta: median('heapDelta'),
    rssDelta: median('rssDelta'),
  }
}

function assertSameChecksum(left, right) {
  if (
    left.cells !== right.cells ||
    left.numericChecksum !== right.numericChecksum ||
    left.stringChecksum !== right.stringChecksum
  ) {
    throw new Error(`Checksum mismatch: ${JSON.stringify({ left, right })}`)
  }
}

function displayResult(name, throughput, memory) {
  return {
    implementation: name,
    'million cells/s': (throughput.cellsPerSecond / 1_000_000).toFixed(2),
    'duration (s)': (throughput.durationMs / 1000).toFixed(2),
    'peak heap delta (MB)': (memory.heapDelta / 1024 / 1024).toFixed(1),
    'peak RSS delta (MB)': (memory.rssDelta / 1024 / 1024).toFixed(1),
  }
}
