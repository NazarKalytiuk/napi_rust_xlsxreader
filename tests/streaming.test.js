'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { collect, failsWith } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()
const numbered = fixtures.createNumberedWorkbook(10_000)
const edges = fixtures.createCellEdgesPackage()

async function sheet(source, name) {
  return (await openWorkbook(source)).sheet(name)
}

async function summarize(rows) {
  let count = 0
  let last = null
  for await (const row of rows) {
    count += 1
    last = row
  }
  return { count, last }
}

test('streams every row with the default batch size', async () => {
  const data = await sheet(numbered, 'Data')
  const summary = await summarize(data.rows())

  assert.equal(summary.count, 10_001)
  assert.deepEqual(
    summary.last,
    Array.from({ length: 10 }, (_, column) => 100_000 + column)
  )
})

test('streams explicit ranges and empty sheets exactly like bulk reads', async () => {
  const workbook = await openWorkbook(primary)

  for (const [name, options] of [
    ['Data', { range: 'B2:D5' }],
    ['Data', { range: 'E2:F2', formulaMode: 'both', dateMode: 'iso' }],
    ['Sparse', { range: 'A1:C3' }],
    ['Sparse', {}],
    ['Empty', {}],
    ['Empty', { range: 'A1:B2' }],
  ]) {
    const worksheet = workbook.sheet(name)
    assert.deepEqual(
      await collect(worksheet.rows({ ...options, batchSize: 2 })),
      await worksheet.readRows(options),
      `${name} ${JSON.stringify(options)}`
    )
  }
})

test('accepts batch sizes at both bounds', async () => {
  const data = await sheet(primary, 'Data')
  const expected = await data.readRows()

  assert.deepEqual(await collect(data.rows({ batchSize: 1 })), expected)
  assert.deepEqual(await collect(data.rows({ batchSize: 65_536 })), expected)
})

test('rejects batch sizes outside 1..65536', async () => {
  const data = await sheet(primary, 'Data')

  for (const batchSize of [0, -1, 65_537, 1.5, Number.NaN, '16']) {
    await failsWith(() => data.rows({ batchSize }), 'INVALID_OPTION')
    await failsWith(() => data.records({ batchSize, headerMode: 'dedupe' }), 'INVALID_OPTION')
  }
})

test('surfaces worker errors after yielding the rows that preceded them', async () => {
  const overflow = await sheet(edges, 'Overflow')
  const yielded = []

  await failsWith(async () => {
    for await (const row of overflow.rows({ batchSize: 1 })) {
      yielded.push(row)
    }
  }, 'CORRUPT_WORKBOOK')
  assert.deepEqual(yielded, [[1]])
})

test('reports invalid ranges when iteration starts', async () => {
  const data = await sheet(primary, 'Data')

  await failsWith(() => data.rows({ range: 'B2:A1' }), 'INVALID_RANGE')
  await failsWith(() => data.records({ range: 'Data!A1' }), 'INVALID_RANGE')
})

test('independent iterators over one worksheet do not interfere', async () => {
  const data = await sheet(numbered, 'Data')

  const [small, big] = await Promise.all([
    summarize(data.rows({ batchSize: 7 })),
    summarize(data.rows({ batchSize: 4096 })),
  ])
  assert.deepEqual(small, big)
  assert.equal(small.count, 10_001)
})
