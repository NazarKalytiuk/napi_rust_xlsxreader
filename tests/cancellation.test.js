'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')
const { collect, failsWith } = require('./support/assertions.js')

const primary = fixtures.createPrimaryWorkbook()
const numbered = fixtures.createNumberedWorkbook(10_000)

test('every operation accepts a signal that never aborts', async () => {
  const { signal } = new AbortController()
  const workbook = await openWorkbook(primary, { signal })
  const data = workbook.sheet('Data')

  assert.equal(workbook.sheets.length, 5)
  assert.equal((await data.readRows({ signal })).length, 5)
  assert.equal((await collect(data.rows({ signal }))).length, 5)
  assert.equal((await data.readRecords({ signal })).length, 4)
  assert.equal((await collect(data.records({ signal }))).length, 4)
  assert.deepEqual((await data.structuralMetadata({ signal })).mergedRanges, ['A4:C4'])
})

test('every operation rejects a signal that was aborted beforehand', async () => {
  const signal = AbortSignal.abort()
  const data = (await openWorkbook(primary)).sheet('Data')

  await failsWith(() => openWorkbook(primary, { signal }), 'ABORTED')
  await failsWith(() => data.readRows({ signal }), 'ABORTED')
  await failsWith(() => data.rows({ signal }), 'ABORTED')
  await failsWith(() => data.readRecords({ signal }), 'ABORTED')
  await failsWith(() => data.records({ signal }), 'ABORTED')
  await failsWith(() => data.structuralMetadata({ signal }), 'ABORTED')
})

test('aborting stops a bulk read that is already parsing', async () => {
  const data = (await openWorkbook(numbered)).sheet('Data')
  const controller = new AbortController()

  const pending = data.readRows({ signal: controller.signal })
  controller.abort()

  await failsWith(() => pending, 'ABORTED')
})

test('aborting stops record reads at the next row', async () => {
  const data = (await openWorkbook(numbered)).sheet('Data')
  const controller = new AbortController()
  let yielded = 0

  await failsWith(async () => {
    for await (const row of data.records({ signal: controller.signal, batchSize: 8 })) {
      yielded += 1
      assert.equal(row.column_0, yielded * 10)
      if (yielded === 3) {
        controller.abort()
      }
    }
  }, 'ABORTED')
  assert.equal(yielded, 3)
})
