# rusc-xlsx-reader

[![CI](https://github.com/NazarKalytiuk/napi_rust_xlsxreader/actions/workflows/test.yml/badge.svg)](https://github.com/NazarKalytiuk/napi_rust_xlsxreader/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@nazarkalytiuk/rusc-xlsx-reader.svg)](https://www.npmjs.com/package/@nazarkalytiuk/rusc-xlsx-reader)
[![license](https://img.shields.io/npm/l/@nazarkalytiuk/rusc-xlsx-reader.svg)](LICENSE)

Fast, read-only XLSX/XLSM reader for Node.js and browsers, powered by [Calamine](https://github.com/tafia/calamine) and NAPI-RS. It is designed for backend imports and ETL workloads that need typed values, asynchronous parsing, and bounded row buffering. In browsers it runs on WebAssembly; see [Browsers](#browsers-webassembly).

## Installation

```bash
npm install @nazarkalytiuk/rusc-xlsx-reader
```

Node.js 22.13 or newer is required. Prebuilt native packages are provided for supported platforms; consumers do not need a Rust toolchain.

## Quick start

### CommonJS

```js
const { openWorkbook } = require('@nazarkalytiuk/rusc-xlsx-reader')

const workbook = await openWorkbook('report.xlsx')
const worksheet = workbook.sheet('Data')
const rows = await worksheet.readRows({ range: 'A1:F1000' })
```

### ESM

```js
import { openWorkbook } from '@nazarkalytiuk/rusc-xlsx-reader'

const workbook = await openWorkbook(await fs.readFile('report.xlsx'))
console.log(workbook.sheets)
```

`openWorkbook()` accepts a file path or the workbook's bytes: any `Uint8Array`, such as a `Buffer`, or an `ArrayBuffer`. Bytes are snapshotted once during open, so later JavaScript mutations cannot change workbook reads.

## Browsers (WebAssembly)

Bundlers pick a browser build of the same API through the `browser` export condition (Vite, webpack, esbuild and Rollup do). It runs on the WebAssembly package `@nazarkalytiuk/rusc-xlsx-reader-wasm32-wasi`, which npm installs with the library.

```js
import { openWorkbook } from '@nazarkalytiuk/rusc-xlsx-reader'

const file = document.querySelector('input[type=file]').files[0]
const workbook = await openWorkbook(await file.arrayBuffer())
for await (const row of workbook.sheet(0).rows()) {
  console.log(row)
}
```

Parsing and streaming run on WebAssembly threads, which share memory through `SharedArrayBuffer`, so the page must be [cross-origin isolated](https://developer.mozilla.org/docs/Web/API/Window/crossOriginIsolated). Serve it with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Cross-Origin-Embedder-Policy: credentialless` also works where the page loads cross-origin resources that do not send CORP headers. Without isolation, `openWorkbook()` rejects with `UNSUPPORTED_ENVIRONMENT`; importing the package is still safe. The WebAssembly module and its worker threads load on the first `openWorkbook()` call, not on import.

With Vite, set the headers for the dev server and `vite preview`, and keep the WebAssembly package out of dependency pre-bundling, because its loader finds the `.wasm` and worker files next to itself:

```js
// vite.config.js
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default {
  server: { headers },
  preview: { headers },
  optimizeDeps: { exclude: ['@nazarkalytiuk/rusc-xlsx-reader-wasm32-wasi'] },
}
```

Your production server must send the same headers. Other differences from Node.js:

- Browsers have no file system: pass bytes (`File.arrayBuffer()`, `fetch()` responses) instead of a path; a path rejects with `INVALID_SOURCE`.
- The module loads with top-level await, so the bundle must target browsers that support it (current Chrome, Edge, Firefox and Safari do, and so do Vite's default build targets).
- It also works in module Web Workers, which keeps parsing off the main thread.

On Node.js the native addon is used. Where no prebuilt binary exists for the platform, Node.js falls back to the same WebAssembly package automatically; set `NAPI_RS_WASI_FLAVOR=wasm32-wasi` to choose it on purpose.

## Stream large worksheets

```js
const controller = new AbortController()
const workbook = await openWorkbook('large.xlsx')
const worksheet = workbook.sheet(0)

for await (const row of worksheet.rows({
  range: 'A1:T200000',
  batchSize: 4096,
  signal: controller.signal,
})) {
  await importRow(row)
}
```

Native parsing runs outside the Node.js event loop. Batches are pulled on demand, which provides backpressure without materializing the whole worksheet on the JavaScript heap. Breaking the loop or aborting the signal closes the native worker before control returns.

The row-buffer guarantee does not include workbook-level OOXML structures such as shared strings and metadata, which can scale with the source file.

## Read records by header

```js
const records = await worksheet.readRecords({
  range: 'A1:G5000',
  headerMode: 'dedupe',
})

for await (const record of worksheet.records({
  headerRow: 1,
  headerMode: 'strict',
})) {
  console.log(record)
}
```

- `strict` rejects blank or duplicate headers.
- `dedupe` generates deterministic names such as `column_1`, `name_2`, and `name_3`.
- Record objects have a null prototype, so headers such as `__proto__` are safe.
- Record keys follow JavaScript property order, which lists integer-like keys such as `2024` before all others. Use `rows()` or `readRows()` when column order matters.

## Formulas and dates

```js
const rows = await worksheet.readRows({
  formulaMode: 'both',
  dateMode: 'iso',
})
```

### Formula modes

| Mode | Formula cell output |
| --- | --- |
| `value` | Cached value stored in the workbook; this is the default. |
| `formula` | Formula text such as `=B2*2`. |
| `both` | `{ type: 'formula', formula, value }`. |

The reader does not calculate formulas. A cached value can be stale if the producer did not recalculate the workbook before saving it.

### Date modes

| Mode | Output |
| --- | --- |
| `object` | Tagged lossless object with `serial`, `iso`, and workbook `epoch`; default. |
| `serial` | Excel serial number. |
| `iso` | ISO-8601 string. |
| `jsDate` | JavaScript `Date` for datetimes; durations remain tagged values. |

Both Excel 1900 and 1904 date systems are preserved.

## Workbook and structural metadata

```js
const workbook = await openWorkbook('report.xlsm')

console.log(workbook.epoch)
console.log(workbook.sheets)
console.log(workbook.definedNames)

const worksheet = workbook.sheet('Data')
console.log(await worksheet.structuralMetadata())
```

Sheet metadata includes workbook order, name, type, visibility, and declared range. Structural metadata contains canonical merged ranges and hyperlinks.

## Errors and cancellation

Operational failures use `XlsxReaderError` with a stable `code`:

```js
try {
  await openWorkbook('missing.xlsx')
} catch (error) {
  if (error.code === 'SOURCE_NOT_FOUND') {
    // Handle a missing input.
  }
}
```

Representative codes include `ABORTED`, `CORRUPT_WORKBOOK`, `ENCRYPTED_WORKBOOK`, `INVALID_RANGE`, `INVALID_HEADER`, `SHEET_NOT_FOUND`, `SOURCE_NOT_FOUND`, and, in browser pages that are not cross-origin isolated, `UNSUPPORTED_ENVIRONMENT`.

## API

```ts
openWorkbook(source: string | Uint8Array | ArrayBuffer, options?): Promise<Workbook>

workbook.sheets: readonly SheetMetadata[]
workbook.definedNames: readonly DefinedName[]
workbook.epoch: 1900 | 1904
workbook.sheet(selector: string | number): Worksheet

worksheet.readRows(options?): Promise<CellOutput[][]>
worksheet.rows(options?): AsyncIterable<CellOutput[]>
worksheet.readRecords(options?): Promise<Record<string, CellOutput>[]>
worksheet.records(options?): AsyncIterable<Record<string, CellOutput>>
worksheet.structuralMetadata(options?): Promise<StructuralMetadata>
```

The package ships strict TypeScript declarations for CommonJS and ESM consumers.

## Supported native packages

| Platform | Architectures |
| --- | --- |
| macOS | Universal binary: x64 and arm64 |
| Windows | x64 and arm64 MSVC |
| Linux glibc | x64 and arm64 |
| Linux musl | x64 and arm64 |
| WebAssembly (browsers, and Node.js elsewhere) | `wasm32-wasip1-threads` |

CI tests Node.js 22, 24, and 26, the WebAssembly build on each of them, and the browser build in Chromium, Firefox, and WebKit. Native packages are selected through exact-version optional dependencies; installation does not download binaries in a postinstall script.

## Scope

This package intentionally focuses on fast data extraction. It does not currently expose styles, rich text, comments, charts, images, conditional formatting, formula calculation, password decryption, or workbook editing.

Accepted ranges use inclusive A1 notation such as `A1` or `A1:F1000`. Sheet-qualified, whole-row, and whole-column range syntax is not accepted.

Cached error values cover the classic Excel codes (`#DIV/0!`, `#N/A`, `#NAME?`, `#NULL!`, `#NUM!`, `#REF!`, `#VALUE!`). Error codes introduced by Excel 365, such as `#SPILL!` and `#CALC!`, are not reported yet:

- Excel itself caches these errors as `#VALUE!` and keeps the real code in rich-value metadata, so cells in workbooks saved by Excel read as `{ type: 'error', code: '#VALUE!' }`.
- Some other writers store the code itself in the cell. Reading a worksheet that contains such a cell rejects with `PARSE_ERROR`. Opening the workbook and reading its other worksheets still work.

Both depend on [calamine#754](https://github.com/tafia/calamine/issues/754).

Workbooks that contain an Excel 4.0 macro sheet, a legacy sheet type found in some `.xlsm` files, cannot be opened yet: `openWorkbook()` rejects with `PARSE_ERROR` because calamine does not recognize that sheet type ([calamine#802](https://github.com/tafia/calamine/issues/802)).

## Benchmark

Reference workload: 200,000 rows by 20 columns, split evenly between strings and numbers. Median of three isolated release-mode runs on an Apple M4 Max:

| Reader | Throughput | Peak JS heap delta |
| --- | ---: | ---: |
| `rusc-xlsx-reader` streaming | 4.59M cells/s | 2.1 MB |
| ExcelJS 4.4 streaming | 1.35M cells/s | 3.9 MB |
| SheetJS `xlsx` 0.20 dense | 0.87M cells/s | 457.0 MB |

Run the reproducible benchmark locally:

```bash
npm run build
npm run benchmark
```

Results vary by hardware, Node.js version, allocator state, and workbook structure.

## License

MIT
