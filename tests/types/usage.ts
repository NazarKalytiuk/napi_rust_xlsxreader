import reader, {
  openWorkbook,
  type CellOutput,
  type RecordRow,
  XlsxReaderError,
} from '../../wrapper.js'

async function consume(source: Buffer): Promise<void> {
  const workbook = await openWorkbook(source)
  const sheet = workbook.sheet('Data')
  const rows: CellOutput[][] = await sheet.readRows({
    range: 'A1:B10',
    formulaMode: 'both',
    dateMode: 'object',
  })

  for await (const row of sheet.rows({ batchSize: 4096 })) {
    const value: CellOutput = row[0]
    void value
  }

  const records: RecordRow[] = await sheet.readRecords({ headerMode: 'strict' })
  void rows
  void records
  void reader.Workbook
}

const error: XlsxReaderError = new XlsxReaderError('INVALID_RANGE', 'bad range')
void error
void consume
