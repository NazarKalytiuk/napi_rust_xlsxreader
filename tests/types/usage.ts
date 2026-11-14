import reader, {
  openWorkbook,
  Workbook,
  Worksheet,
  XlsxReaderError,
  type CellOutput,
  type CellValue,
  type DefinedName,
  type HyperlinkMetadata,
  type RecordRow,
  type Row,
  type SheetMetadata,
  type StructuralMetadata,
  type XlsxReaderErrorCode,
} from '../../wrapper.js'

async function consume(source: Buffer, path: string): Promise<void> {
  const { signal } = new AbortController()
  const workbook: Workbook = await openWorkbook(source)
  const fromPath: Workbook = await openWorkbook(path, { signal })

  const sheets: readonly SheetMetadata[] = workbook.sheets
  const names: readonly DefinedName[] = fromPath.definedNames
  const epoch: 1900 | 1904 = workbook.epoch
  const first: SheetMetadata = sheets[0]
  const kind: 'worksheet' | 'dialog' | 'macro' | 'chart' | 'vba' = first.type
  const visibility: 'visible' | 'hidden' | 'veryHidden' = first.visibility
  const declaredRange: string | null = first.declaredRange
  const formula: string = names[0].formula

  const byName: Worksheet = workbook.sheet('Data')
  const sheet: Worksheet = workbook.sheet(0)
  const metadata: SheetMetadata = sheet.metadata

  const rows: Row[] = await sheet.readRows({
    range: 'A1:B10',
    formulaMode: 'both',
    dateMode: 'object',
    signal,
  })
  for await (const row of byName.rows({ batchSize: 4096, dateMode: 'jsDate', signal })) {
    describeCell(row[0])
  }

  const records: RecordRow[] = await sheet.readRecords({ headerMode: 'strict', headerRow: 1 })
  for await (const record of sheet.records({ headerMode: 'dedupe', batchSize: 16, signal })) {
    describeCell(record['name'])
  }

  const structure: StructuralMetadata = await sheet.structuralMetadata({ signal })
  const merged: string[] = structure.mergedRanges
  const link: HyperlinkMetadata = structure.hyperlinks[0]
  const target: string | null = link.target
  const tooltip: string | null = link.tooltip

  void [epoch, kind, visibility, declaredRange, formula, metadata, rows, records, merged, target, tooltip]
}

function describeCell(cell: CellOutput): string {
  if (cell === null) return 'empty'
  if (typeof cell === 'string') return cell
  if (typeof cell === 'number') return cell.toFixed(2)
  if (typeof cell === 'boolean') return String(cell)
  if (cell instanceof Date) return cell.toISOString()

  switch (cell.type) {
    case 'formula': {
      const cached: CellValue = cell.value
      return `${cell.formula} -> ${describeCell(cached)}`
    }
    case 'datetime': {
      const epoch: 1900 | 1904 | null = cell.epoch
      return `${cell.iso ?? cell.serial} (${epoch})`
    }
    case 'duration':
      return cell.iso ?? String(cell.serial)
    case 'error':
      return cell.code
    default: {
      const exhaustive: never = cell
      return exhaustive
    }
  }
}

function handle(error: unknown): XlsxReaderErrorCode | null {
  if (error instanceof XlsxReaderError) {
    const code: XlsxReaderErrorCode = error.code
    const message: string = error.message
    void message
    return code
  }
  return null
}

const error: XlsxReaderError = new XlsxReaderError('INVALID_RANGE', 'bad range', {
  cause: new Error('root cause'),
})
const facade: typeof openWorkbook = reader.openWorkbook
void [error, facade, reader.Workbook, reader.Worksheet, reader.XlsxReaderError, consume, handle]

// Invalid usage must not type-check.
async function rejected(workbook: Workbook, sheet: Worksheet, metadata: SheetMetadata): Promise<void> {
  // @ts-expect-error sources are a path string or a Buffer
  await openWorkbook(42)
  // @ts-expect-error opening only accepts a signal
  await openWorkbook('book.xlsx', { range: 'A1' })
  // @ts-expect-error selectors are a name or an index
  workbook.sheet(true)
  // @ts-expect-error formulas are not calculated
  await sheet.readRows({ formulaMode: 'calculate' })
  // @ts-expect-error unknown date mode
  await sheet.readRows({ dateMode: 'calendar' })
  // @ts-expect-error ranges are A1 strings
  await sheet.readRows({ range: 5 })
  // @ts-expect-error bulk reads are not batched
  await sheet.readRows({ batchSize: 10 })
  // @ts-expect-error batch sizes are numbers
  sheet.rows({ batchSize: '10' })
  // @ts-expect-error unknown header mode
  await sheet.readRecords({ headerMode: 'loose' })
  // @ts-expect-error header rows are numbers
  await sheet.readRecords({ headerRow: '1' })
  // @ts-expect-error structural metadata only accepts a signal
  await sheet.structuralMetadata({ range: 'A1' })
  // @ts-expect-error unknown error code
  void new XlsxReaderError('NOT_A_CODE', 'message')
  // @ts-expect-error instances come from openWorkbook()
  void new Workbook()
  // @ts-expect-error instances come from Workbook.sheet()
  void new Worksheet()
  // @ts-expect-error the epoch is read-only
  workbook.epoch = 1904
  // @ts-expect-error sheet metadata is read-only
  workbook.sheets.push(metadata)
  // @ts-expect-error sheet metadata fields are read-only
  metadata.name = 'Renamed'
}
void rejected
