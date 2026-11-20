// Everything the reader reports about one workbook, as plain data. The browser
// tests compute it with the WebAssembly build in the browser and, through the
// `nativeReport` command in vitest.browser.config.mjs, with the native addon in
// Node.js; the two must be equal.

const FORMULA_MODES = ['value', 'formula', 'both']
const DATE_MODES = ['object', 'serial', 'iso', 'jsDate']

/** Turns Dates into tagged strings and null-prototype records into plain objects. */
function plain(value) {
  if (value instanceof Date) {
    return { date: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() }
  }
  if (Array.isArray(value)) {
    return value.map(plain)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry)]))
  }
  return value
}

async function settle(read) {
  try {
    return { value: plain(await read()) }
  } catch (error) {
    return { error: error.code ?? String(error) }
  }
}

async function collect(iterable) {
  const items = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

export async function readReport(openWorkbook, source) {
  let workbook
  try {
    workbook = await openWorkbook(source)
  } catch (error) {
    return { openError: error.code ?? String(error) }
  }

  const sheets = []
  for (const metadata of workbook.sheets) {
    const sheet = workbook.sheet(metadata.name)
    const reads = {}
    for (const formulaMode of FORMULA_MODES) {
      for (const dateMode of DATE_MODES) {
        reads[`${formulaMode}/${dateMode}`] = await settle(() =>
          sheet.readRows({ formulaMode, dateMode })
        )
      }
    }
    sheets.push({
      name: metadata.name,
      reads,
      streamed: await settle(() => collect(sheet.rows({ batchSize: 7, formulaMode: 'both' }))),
      records: await settle(() => sheet.readRecords({ headerMode: 'dedupe' })),
      streamedRecords: await settle(() =>
        collect(sheet.records({ headerMode: 'dedupe', batchSize: 3 }))
      ),
      structural: await settle(() => sheet.structuralMetadata()),
    })
  }

  return plain({
    sheets: workbook.sheets,
    definedNames: workbook.definedNames,
    epoch: workbook.epoch,
    data: sheets,
  })
}
