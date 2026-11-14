'use strict'

// Builds minimal OOXML packages for edge cases the fixture writer cannot
// produce: chart and dialog sheets, very hidden sheets, the 1904 date system,
// ISO `t="d"` cells, hyperlink tooltips, mismatched declared dimensions, and
// workbook parts such as Excel's rich-value metadata.

const { crc32 } = require('node:zlib')

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const SPREADSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

const SHEET_KINDS = {
  worksheet: { folder: 'worksheets' },
  chartsheet: { folder: 'chartsheets' },
  dialogsheet: { folder: 'dialogsheets' },
}

/**
 * @param {object} definition
 * @param {Array<{
 *   name: string,
 *   kind?: 'worksheet' | 'chartsheet' | 'dialogsheet',
 *   state?: 'visible' | 'hidden' | 'veryHidden',
 *   body?: string,
 *   relationships?: Array<{ id: string, type: string, target: string, external?: boolean }>,
 * }>} definition.sheets Sheets in workbook order. `body` is the XML inside the
 *   root element; without it the sheet is declared and related but its part is
 *   missing from the archive.
 * @param {boolean} [definition.date1904]
 * @param {string} [definition.styles] XML inside `<styleSheet>`.
 * @param {Array<{ path: string, type: string, contentType: string, xml: string }>} [definition.parts]
 *   Further workbook-level parts, each related from the workbook with
 *   relationship `type`. `path` is relative to `xl/`, and `xml` is the part's
 *   complete root element.
 * @returns {Buffer}
 */
function createWorkbookPackage({ sheets, date1904 = false, styles, parts = [] }) {
  const files = []
  const contentTypes = []
  const workbookRelationships = []
  const sheetEntries = []

  sheets.forEach((sheet, index) => {
    const kind = sheet.kind ?? 'worksheet'
    const { folder } = SHEET_KINDS[kind]
    const number = index + 1
    const relationshipId = `rId${number}`
    const partName = `xl/${folder}/sheet${number}.xml`

    if (sheet.body !== undefined) {
      files.push([
        partName,
        xml(`<${kind} xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}">${sheet.body}</${kind}>`),
      ])
      contentTypes.push(override(`/${partName}`, `${SPREADSHEET_CONTENT_TYPE}.${kind}+xml`))
    }
    workbookRelationships.push(relationship(relationshipId, `${RELATIONSHIP_NS}/${kind}`, `${folder}/sheet${number}.xml`))

    if (sheet.relationships?.length) {
      files.push([
        `xl/${folder}/_rels/sheet${number}.xml.rels`,
        relationships(
          sheet.relationships.map((entry) =>
            relationship(entry.id, entry.type, entry.target, entry.external)
          )
        ),
      ])
    }

    const state = sheet.state ? ` state="${sheet.state}"` : ''
    sheetEntries.push(
      `<sheet name="${escapeXml(sheet.name)}" sheetId="${number}"${state} r:id="${relationshipId}"/>`
    )
  })

  if (styles !== undefined) {
    const relationshipId = `rId${sheets.length + 1}`
    files.push(['xl/styles.xml', xml(`<styleSheet xmlns="${MAIN_NS}">${styles}</styleSheet>`)])
    contentTypes.push(override('/xl/styles.xml', `${SPREADSHEET_CONTENT_TYPE}.styles+xml`))
    workbookRelationships.push(relationship(relationshipId, `${RELATIONSHIP_NS}/styles`, 'styles.xml'))
  }

  for (const part of parts) {
    const relationshipId = `rId${workbookRelationships.length + 1}`
    files.push([`xl/${part.path}`, xml(part.xml)])
    contentTypes.push(override(`/xl/${part.path}`, part.contentType))
    workbookRelationships.push(relationship(relationshipId, part.type, part.path))
  }

  const workbookProperties = date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'
  files.push([
    'xl/workbook.xml',
    xml(
      `<workbook xmlns="${MAIN_NS}" xmlns:r="${RELATIONSHIP_NS}">${workbookProperties}<sheets>${sheetEntries.join('')}</sheets></workbook>`
    ),
  ])
  files.push(['xl/_rels/workbook.xml.rels', relationships(workbookRelationships)])
  files.push([
    '_rels/.rels',
    relationships([
      relationship('rId1', `${RELATIONSHIP_NS}/officeDocument`, 'xl/workbook.xml'),
    ]),
  ])
  files.push([
    '[Content_Types].xml',
    xml(
      `<Types xmlns="${CONTENT_TYPES_NS}">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        override('/xl/workbook.xml', `${SPREADSHEET_CONTENT_TYPE}.sheet.main+xml`) +
        contentTypes.join('') +
        '</Types>'
    ),
  ])

  return createZip(files)
}

function xml(content) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${content}`
}

function override(partName, contentType) {
  return `<Override PartName="${partName}" ContentType="${contentType}"/>`
}

function relationships(entries) {
  return xml(`<Relationships xmlns="${PACKAGE_RELATIONSHIP_NS}">${entries.join('')}</Relationships>`)
}

function relationship(id, type, target, external = false) {
  const mode = external ? ' TargetMode="External"' : ''
  return `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${mode}/>`
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * ZIP archive with stored (uncompressed) entries, per PKWARE APPNOTE 4.3.
 *
 * @param {Array<[string, string | Buffer]>} files Entry names and contents.
 * @returns {Buffer}
 */
function createZip(files) {
  const DOS_DATE_1980_01_01 = 0x0021
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, nameBytes, data)
    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, centralDirectory, end])
}

/**
 * An MS-CFB version 3 container with the directory layout of a
 * password-encrypted OOXML file (`EncryptionInfo` and `EncryptedPackage`
 * streams). Stream contents are empty: readers must detect encryption from
 * the container structure alone.
 *
 * @returns {Buffer}
 */
function createEncryptedContainer() {
  return createCompoundFile(['EncryptionInfo', 'EncryptedPackage'])
}

function createCompoundFile(streamNames) {
  const SECTOR_SIZE = 512
  const FREE_SECTOR = 0xffffffff
  const END_OF_CHAIN = 0xfffffffe
  const FAT_SECTOR = 0xfffffffd
  const NO_STREAM = 0xffffffff
  const ENTRY_SIZE = 128
  const entriesPerSector = SECTOR_SIZE / ENTRY_SIZE

  if (streamNames.length + 1 > entriesPerSector) {
    throw new RangeError('createCompoundFile supports one directory sector')
  }

  const header = Buffer.alloc(SECTOR_SIZE, 0)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0)
  header.writeUInt16LE(0x003e, 24) // minor version
  header.writeUInt16LE(0x0003, 26) // major version 3
  header.writeUInt16LE(0xfffe, 28) // little-endian byte order mark
  header.writeUInt16LE(0x0009, 30) // 512-byte sectors
  header.writeUInt16LE(0x0006, 32) // 64-byte mini sectors
  header.writeUInt32LE(1, 44) // FAT sector count
  header.writeUInt32LE(1, 48) // first directory sector
  header.writeUInt32LE(4096, 56) // mini stream cutoff
  header.writeUInt32LE(END_OF_CHAIN, 60) // first mini FAT sector
  header.writeUInt32LE(0, 64) // mini FAT sector count
  header.writeUInt32LE(END_OF_CHAIN, 68) // first DIFAT sector
  header.writeUInt32LE(0, 72) // DIFAT sector count
  header.writeUInt32LE(0, 76) // DIFAT[0]: the FAT lives in sector 0
  for (let position = 80; position < SECTOR_SIZE; position += 4) {
    header.writeUInt32LE(FREE_SECTOR, position)
  }

  const fat = Buffer.alloc(SECTOR_SIZE)
  for (let position = 0; position < SECTOR_SIZE; position += 4) {
    fat.writeUInt32LE(FREE_SECTOR, position)
  }
  fat.writeUInt32LE(FAT_SECTOR, 0)
  fat.writeUInt32LE(END_OF_CHAIN, 4)

  const directory = Buffer.alloc(SECTOR_SIZE, 0)
  const entries = [
    { name: 'Root Entry', type: 5, child: streamNames.length > 0 ? 1 : NO_STREAM },
    ...streamNames.map((name, index) => ({
      name,
      type: 2,
      right: index + 2 <= streamNames.length ? index + 2 : NO_STREAM,
    })),
  ]
  entries.forEach((entry, index) => {
    const base = index * ENTRY_SIZE
    const name = Buffer.from(`${entry.name}\0`, 'utf16le')
    name.copy(directory, base)
    directory.writeUInt16LE(name.length, base + 64)
    directory.writeUInt8(entry.type, base + 66)
    directory.writeUInt8(1, base + 67) // black node
    directory.writeUInt32LE(entry.left ?? NO_STREAM, base + 68)
    directory.writeUInt32LE(entry.right ?? NO_STREAM, base + 72)
    directory.writeUInt32LE(entry.child ?? NO_STREAM, base + 76)
    directory.writeUInt32LE(END_OF_CHAIN, base + 116) // empty stream
    directory.writeUInt32LE(0, base + 120)
  })

  return Buffer.concat([header, fat, directory])
}

module.exports = {
  createEncryptedContainer,
  createWorkbookPackage,
  createZip,
}
