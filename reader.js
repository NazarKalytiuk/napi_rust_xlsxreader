'use strict'

// The reader's JavaScript API. It takes a function that returns the binding it
// runs on (or a promise of it), so the Node.js entry (wrapper.js, with the
// native addon or WebAssembly through ./index.js) and the browser entry
// (wrapper.browser.mjs, which loads WebAssembly through ./browser.js on first
// use) share it.

const INTERNAL = Symbol('rusc-xlsx-reader-internal')
const FORMULA_MODES = new Set(['value', 'formula', 'both'])
const DATE_MODES = new Set(['object', 'serial', 'iso', 'jsDate'])
const HEADER_MODES = new Set(['strict', 'dedupe'])
const DEFAULT_BATCH_SIZE = 4096

class XlsxReaderError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'XlsxReaderError'
    this.code = code
  }
}

class Workbook {
  constructor(nativeWorkbook, token) {
    if (token !== INTERNAL) {
      throw new TypeError('Workbook instances are created by openWorkbook()')
    }
    this._native = nativeWorkbook
    this._sheets = Object.freeze(nativeWorkbook.sheets.map(normalizeSheetMetadata))
    this._definedNames = Object.freeze(
      nativeWorkbook.definedNames.map((entry) => Object.freeze({ ...entry }))
    )
  }

  get sheets() {
    return this._sheets
  }

  get definedNames() {
    return this._definedNames
  }

  get epoch() {
    return this._native.epoch
  }

  sheet(selector) {
    try {
      if (typeof selector === 'string') {
        return new Worksheet(this._native.worksheetByName(selector), INTERNAL)
      }
      if (Number.isInteger(selector) && selector >= 0) {
        return new Worksheet(this._native.worksheetByIndex(selector), INTERNAL)
      }
    } catch (error) {
      throw normalizeError(error)
    }

    throw new XlsxReaderError(
      'INVALID_SELECTOR',
      'sheet() expects an exact sheet name or a non-negative integer index'
    )
  }
}

class Worksheet {
  constructor(nativeWorksheet, token) {
    if (token !== INTERNAL) {
      throw new TypeError('Worksheet instances are created by Workbook.sheet()')
    }
    this._native = nativeWorksheet
    this._metadata = Object.freeze(normalizeSheetMetadata(nativeWorksheet.metadata))
  }

  get metadata() {
    return this._metadata
  }

  async readRows(options = {}) {
    const normalized = normalizeReadOptions(options)
    throwIfAborted(normalized.signal)
    try {
      return await this._native.readRows(normalized.native, normalized.signal)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  rows(options = {}) {
    return iterateRows(this._native, normalizeStreamOptions(options))
  }

  async readRecords(options = {}) {
    const normalized = normalizeRecordOptions(options, false)
    const rows = await this.readRows(normalized.read)
    if (rows.length === 0 && normalized.headerRow === 0) {
      return []
    }
    if (normalized.headerRow >= rows.length) {
      throw invalidHeaderRow(normalized.headerRow)
    }

    const headers = createHeaders(rows[normalized.headerRow], normalized.headerMode)
    return rows
      .slice(normalized.headerRow + 1)
      .map((row) => createRecord(headers, row))
  }

  records(options = {}) {
    return iterateRecords(this, normalizeRecordOptions(options, true))
  }

  async structuralMetadata(options = {}) {
    const signal = normalizeSignalOnlyOptions(options)
    throwIfAborted(signal)
    try {
      const metadata = await this._native.structuralMetadata(signal)
      return {
        mergedRanges: metadata.mergedRanges,
        hyperlinks: metadata.hyperlinks.map((link) => ({
          range: link.range,
          target: link.target ?? null,
          location: link.location ?? null,
          displayedText: link.displayedText ?? null,
          tooltip: link.tooltip ?? null,
        })),
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

function createReader(loadBinding) {
  async function openWorkbook(source, options = {}) {
    validateSource(source)
    const signal = normalizeSignalOnlyOptions(options)
    throwIfAborted(signal)
    try {
      const binding = await loadBinding()
      throwIfAborted(signal)
      const nativeSource = bindingSource(source, binding.__napiBindingTarget)
      const nativeWorkbook = await binding.openWorkbook(nativeSource, signal)
      return new Workbook(nativeWorkbook, INTERNAL)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  return { openWorkbook, Workbook, Worksheet, XlsxReaderError }
}

function validateSource(source) {
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    return
  }
  if (typeof source !== 'string') {
    throw new XlsxReaderError(
      'INVALID_SOURCE',
      'source must be a file path string, a Uint8Array such as a Buffer, or an ArrayBuffer'
    )
  }
  if (source.length === 0) {
    throw new XlsxReaderError('INVALID_SOURCE', 'source path must not be empty')
  }
}

/** Prepares a validated source for the binding: bytes as a Uint8Array, and file paths as the binding resolves them. */
function bindingSource(source, bindingTarget) {
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source)
  }
  if (typeof source !== 'string' || bindingTarget === 'native') {
    return source
  }

  // The WebAssembly build reaches files through WASI, which resolves a relative
  // path against `/` instead of the working directory, so on Node.js the path
  // is made absolute first. Browsers have no file system to read paths from.
  const nodeProcess = globalThis.process
  if (typeof nodeProcess?.getBuiltinModule !== 'function') {
    throw new XlsxReaderError(
      'INVALID_SOURCE',
      'file paths can only be read on Node.js; pass the file contents as a Uint8Array or an ArrayBuffer'
    )
  }
  return nodeProcess.getBuiltinModule('node:path').resolve(source)
}

async function* iterateRows(nativeWorksheet, normalized) {
  throwIfAborted(normalized.signal)

  let cursor
  try {
    cursor = nativeWorksheet.createRowCursor(normalized.native)
  } catch (error) {
    throw normalizeError(error)
  }

  const abort = () => {
    void cursor.close()
  }
  normalized.signal?.addEventListener('abort', abort, { once: true })

  try {
    while (true) {
      let batch
      try {
        batch = await cursor.nextBatch()
      } catch (error) {
        throw normalizeError(error)
      }

      if (normalized.signal?.aborted) {
        throw abortedError()
      }
      if (batch === null) {
        return
      }

      for (const row of batch) {
        if (normalized.signal?.aborted) {
          throw abortedError()
        }
        yield row
      }
    }
  } finally {
    normalized.signal?.removeEventListener('abort', abort)
    await cursor.close()
  }
}

async function* iterateRecords(worksheet, normalized) {
  let rowIndex = 0
  let headers = null

  for await (const row of worksheet.rows(normalized.read)) {
    if (rowIndex < normalized.headerRow) {
      rowIndex += 1
      continue
    }
    if (rowIndex === normalized.headerRow) {
      headers = createHeaders(row, normalized.headerMode)
      rowIndex += 1
      continue
    }

    rowIndex += 1
    yield createRecord(headers, row)
  }

  if (headers === null && normalized.headerRow > 0) {
    throw invalidHeaderRow(normalized.headerRow)
  }
}

function normalizeReadOptions(options) {
  assertPlainOptions(options)
  const { range, formulaMode = 'value', dateMode = 'object', signal } = options

  if (range !== undefined && typeof range !== 'string') {
    throw new XlsxReaderError('INVALID_OPTION', 'range must be an A1 range string')
  }
  if (!FORMULA_MODES.has(formulaMode)) {
    throw new XlsxReaderError(
      'INVALID_OPTION',
      'formulaMode must be value, formula, or both'
    )
  }
  if (!DATE_MODES.has(dateMode)) {
    throw new XlsxReaderError(
      'INVALID_OPTION',
      'dateMode must be object, serial, iso, or jsDate'
    )
  }
  assertSignal(signal)

  return {
    native: { range, formulaMode, dateMode },
    signal,
  }
}

function normalizeStreamOptions(options) {
  const normalized = normalizeReadOptions(options)
  const { batchSize = DEFAULT_BATCH_SIZE } = options
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 65536) {
    throw new XlsxReaderError(
      'INVALID_OPTION',
      'batchSize must be an integer between 1 and 65536'
    )
  }

  return {
    native: { ...normalized.native, batchSize },
    signal: normalized.signal,
  }
}

function normalizeRecordOptions(options, streaming) {
  assertPlainOptions(options)
  const { headerRow = 0, headerMode = 'strict' } = options
  if (!Number.isInteger(headerRow) || headerRow < 0) {
    throw new XlsxReaderError('INVALID_OPTION', 'headerRow must be a non-negative integer')
  }
  if (!HEADER_MODES.has(headerMode)) {
    throw new XlsxReaderError('INVALID_OPTION', 'headerMode must be strict or dedupe')
  }

  const readOptions = {
    range: options.range,
    formulaMode: options.formulaMode,
    dateMode: options.dateMode,
    signal: options.signal,
  }
  if (streaming) {
    readOptions.batchSize = options.batchSize
  }

  return { read: readOptions, headerRow, headerMode }
}

function normalizeSignalOnlyOptions(options) {
  assertPlainOptions(options)
  const { signal } = options
  assertSignal(signal)
  return signal
}

function createHeaders(row, mode) {
  const headers = []
  const used = new Set()

  row.forEach((value, index) => {
    let base
    if (mode === 'strict') {
      if (typeof value !== 'string' || value.length === 0) {
        throw new XlsxReaderError(
          'INVALID_HEADER',
          `Header at column ${index} must be a non-empty string in strict mode`
        )
      }
      base = value
      if (used.has(base)) {
        throw new XlsxReaderError('INVALID_HEADER', `Duplicate header ${base}`)
      }
    } else {
      base = headerToString(value, index)
      if (base.length === 0) {
        base = `column_${index + 1}`
      }
      if (used.has(base)) {
        let suffix = 2
        while (used.has(`${base}_${suffix}`)) {
          suffix += 1
        }
        base = `${base}_${suffix}`
      }
    }

    used.add(base)
    headers.push(base)
  })

  return headers
}

function headerToString(value, index) {
  if (value === null) return `column_${index + 1}`
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    if (value.type === 'formula') return headerToString(value.value, index)
    if (value.type === 'error') return value.code
    if (value.type === 'datetime' || value.type === 'duration') {
      return value.iso ?? String(value.serial)
    }
  }
  throw new XlsxReaderError(
    'INVALID_HEADER',
    `Header at column ${index} cannot be converted to a record key`
  )
}

function createRecord(headers, row) {
  const record = Object.create(null)
  for (let index = 0; index < headers.length; index += 1) {
    record[headers[index]] = index < row.length ? row[index] : null
  }
  return record
}

function normalizeSheetMetadata(metadata) {
  return Object.freeze({
    name: metadata.name,
    type: metadata.type,
    visibility: metadata.visibility,
    declaredRange: metadata.declaredRange ?? null,
  })
}

function normalizeError(error) {
  if (error instanceof XlsxReaderError) return error
  if (error?.name === 'AbortError') return abortedError(error)

  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\[([A-Z][A-Z0-9_]*)\]\s*([\s\S]*)$/)
  if (match) {
    return new XlsxReaderError(match[1], match[2], { cause: error })
  }
  return new XlsxReaderError('NATIVE_ERROR', message, { cause: error })
}

function abortedError(cause) {
  return new XlsxReaderError('ABORTED', 'The read operation was aborted', { cause })
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortedError()
}

function invalidHeaderRow(headerRow) {
  return new XlsxReaderError(
    'INVALID_HEADER',
    `headerRow ${headerRow} is outside the selected rows`
  )
}

function assertSignal(signal) {
  if (
    signal !== undefined &&
    (signal === null || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
  ) {
    throw new XlsxReaderError('INVALID_OPTION', 'signal must be an AbortSignal')
  }
}

function assertPlainOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new XlsxReaderError('INVALID_OPTION', 'options must be an object')
  }
}

module.exports = { createReader, XlsxReaderError }
