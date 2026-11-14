'use strict'

const assert = require('node:assert/strict')

const { XlsxReaderError } = require('../../wrapper.js')

/**
 * Validation callback for `assert.throws` / `assert.rejects` that requires an
 * `XlsxReaderError` with the given stable code and, optionally, a message.
 */
function readerError(code, message) {
  return (error) => {
    assert.ok(error instanceof XlsxReaderError, `expected XlsxReaderError, received ${error}`)
    assert.equal(error.code, code)
    if (message !== undefined) {
      assert.match(error.message, message)
    }
    return true
  }
}

/**
 * Asserts that an operation fails with the given code, whether it throws
 * synchronously, rejects, or fails while its async iterable is drained.
 */
async function failsWith(operation, code, message) {
  await assert.rejects(async () => {
    const result = operation()
    if (typeof result?.[Symbol.asyncIterator] === 'function') {
      await collect(result)
    } else {
      await result
    }
  }, readerError(code, message))
}

/** Drains an async iterable, returning every yielded item. */
async function collect(iterable) {
  const items = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

/** Builds the null-prototype objects that record reads return. */
function record(fields) {
  return Object.assign(Object.create(null), fields)
}

module.exports = { collect, failsWith, readerError, record }
