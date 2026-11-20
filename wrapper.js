'use strict'

const native = require('./index.js')
const { createReader } = require('./reader.js')

module.exports = createReader(() => native)
