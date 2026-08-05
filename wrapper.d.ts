/// <reference types="node" />

export type WorkbookSource = string | Buffer
export type FormulaMode = 'value' | 'formula' | 'both'
export type DateMode = 'object' | 'serial' | 'iso' | 'jsDate'
export type HeaderMode = 'strict' | 'dedupe'
export type SheetType = 'worksheet' | 'dialog' | 'macro' | 'chart' | 'vba'
export type SheetVisibility = 'visible' | 'hidden' | 'veryHidden'

export type ExcelErrorCode =
  | '#DIV/0!'
  | '#N/A'
  | '#NAME?'
  | '#NULL!'
  | '#NUM!'
  | '#REF!'
  | '#VALUE!'
  | '#DATA!'

export interface DateTimeValue {
  readonly type: 'datetime'
  readonly serial: number | null
  readonly iso: string | null
  readonly epoch: 1900 | 1904 | null
}

export interface DurationValue {
  readonly type: 'duration'
  readonly serial: number | null
  readonly iso: string | null
}

export interface ExcelCellError {
  readonly type: 'error'
  readonly code: ExcelErrorCode
}

export type CellValue =
  | null
  | string
  | number
  | boolean
  | Date
  | DateTimeValue
  | DurationValue
  | ExcelCellError

export interface FormulaCell {
  readonly type: 'formula'
  readonly formula: string
  readonly value: CellValue
}

export type CellOutput = CellValue | FormulaCell
export type Row = CellOutput[]
export type RecordRow = Record<string, CellOutput>

export interface OpenWorkbookOptions {
  readonly signal?: AbortSignal
}

export interface ReadOptions {
  readonly range?: string
  readonly formulaMode?: FormulaMode
  readonly dateMode?: DateMode
  readonly signal?: AbortSignal
}

export interface StreamOptions extends ReadOptions {
  readonly batchSize?: number
}

export interface RecordOptions extends StreamOptions {
  /** Zero-based row index relative to the selected rows. */
  readonly headerRow?: number
  readonly headerMode?: HeaderMode
}

export interface SheetMetadata {
  readonly name: string
  readonly type: SheetType
  readonly visibility: SheetVisibility
  /** Declared OOXML range, or null for an empty/non-worksheet sheet. */
  readonly declaredRange: string | null
}

export interface DefinedName {
  readonly name: string
  /** Formula normalized to exactly one leading equals sign. */
  readonly formula: string
}

export interface HyperlinkMetadata {
  readonly range: string
  readonly target: string | null
  readonly location: string | null
  readonly displayedText: string | null
  readonly tooltip: string | null
}

export interface StructuralMetadata {
  readonly mergedRanges: string[]
  readonly hyperlinks: HyperlinkMetadata[]
}

export type XlsxReaderErrorCode =
  | 'ABORTED'
  | 'CORRUPT_WORKBOOK'
  | 'ENCRYPTED_WORKBOOK'
  | 'INTERNAL_ERROR'
  | 'INVALID_HEADER'
  | 'INVALID_OPTION'
  | 'INVALID_RANGE'
  | 'INVALID_SELECTOR'
  | 'INVALID_SOURCE'
  | 'IO_ERROR'
  | 'NATIVE_ERROR'
  | 'NOT_A_WORKSHEET'
  | 'PARSE_ERROR'
  | 'SHEET_NOT_FOUND'
  | 'SOURCE_NOT_FOUND'
  | 'STREAM_ERROR'

export class XlsxReaderError extends Error {
  readonly code: XlsxReaderErrorCode
  constructor(code: XlsxReaderErrorCode, message: string, options?: ErrorOptions)
}

export class Workbook {
  private constructor()
  readonly sheets: readonly SheetMetadata[]
  readonly definedNames: readonly DefinedName[]
  readonly epoch: 1900 | 1904
  sheet(selector: string | number): Worksheet
}

export class Worksheet {
  private constructor()
  readonly metadata: SheetMetadata
  readRows(options?: ReadOptions): Promise<Row[]>
  rows(options?: StreamOptions): AsyncIterable<Row>
  readRecords(options?: RecordOptions): Promise<RecordRow[]>
  records(options?: RecordOptions): AsyncIterable<RecordRow>
  structuralMetadata(options?: OpenWorkbookOptions): Promise<StructuralMetadata>
}

export function openWorkbook(
  source: WorkbookSource,
  options?: OpenWorkbookOptions,
): Promise<Workbook>

declare const reader: {
  openWorkbook: typeof openWorkbook
  Workbook: typeof Workbook
  Worksheet: typeof Worksheet
  XlsxReaderError: typeof XlsxReaderError
}

export default reader
