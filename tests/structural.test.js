'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { openWorkbook } = require('../wrapper.js')
const fixtures = require('./fixtures.js')

test('reads merged ranges and hyperlinks with locations, display text, and tooltips', async () => {
  const workbook = await openWorkbook(fixtures.createCellEdgesPackage())

  assert.deepEqual(await workbook.sheet('Links').structuralMetadata(), {
    mergedRanges: ['A2:B2', 'C2:C3'],
    hyperlinks: [
      {
        range: 'A1',
        target: null,
        location: 'Iso!A1',
        displayedText: 'Go to Iso',
        tooltip: 'Jump',
      },
      {
        range: 'B1:C1',
        target: 'https://example.com/docs',
        location: null,
        displayedText: null,
        tooltip: 'Docs',
      },
    ],
  })
})

test('reads structural metadata from Buffer sources', async () => {
  const workbook = await openWorkbook(fixtures.createPrimaryWorkbook())

  assert.deepEqual(await workbook.sheet('Data').structuralMetadata(), {
    mergedRanges: ['A4:C4'],
    hyperlinks: [
      {
        range: 'A5',
        target: 'https://example.com',
        location: null,
        displayedText: null,
        tooltip: null,
      },
    ],
  })
})

test('returns empty structural metadata for sheets without merges or links', async () => {
  const workbook = await openWorkbook(fixtures.createPrimaryWorkbook())

  for (const name of ['Sparse', 'Empty']) {
    assert.deepEqual(await workbook.sheet(name).structuralMetadata(), {
      mergedRanges: [],
      hyperlinks: [],
    })
  }
})
