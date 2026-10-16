import { strToU8 } from 'fflate'
import { deflated, docx, paragraph, rawZip } from './workbooks'

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'
const ODS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
const ODS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
const ODS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'

function zipOf(files: Record<string, string | Uint8Array>): Uint8Array {
  return rawZip(
    Object.entries(files).map(([name, data]) =>
      deflated(name, typeof data === 'string' ? strToU8(data) : data),
    ),
  )
}

function sheetXml(hyperlinkRef: string, extra = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData><hyperlinks><hyperlink ref="${hyperlinkRef}" location="A1"/></hyperlinks>${extra}</worksheet>`
}

export function looseWorkbook(
  sheetPath: string,
  hyperlinkRef: string,
  sharedStrings?: string[],
): Uint8Array {
  const sst = sharedStrings
    ? {
        override: `<Override PartName="/xl/sharedStrings.xml" ContentType="${SHEET_TYPE}.sharedStrings+xml"/>`,
        relation: `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`,
        part: `<?xml version="1.0"?><sst xmlns="${SHEET_NS}">${sharedStrings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`,
      }
    : null
  return zipOf({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SHEET_TYPE}.sheet.main+xml"/><Override PartName="/xl/${sheetPath}" ContentType="${SHEET_TYPE}.worksheet+xml"/>${sst?.override ?? ''}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="${sheetPath}"/>${sst?.relation ?? ''}</Relationships>`,
    [`xl/${sheetPath}`]: sheetXml(hyperlinkRef),
    ...(sst ? { 'xl/sharedStrings.xml': sst.part } : {}),
  })
}

export function looseOds(
  rowAttributes: string,
  cellAttributes: string,
  contentName = 'content.xml',
) {
  return zipOf({
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'META-INF/manifest.xml':
      '<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    'styles.xml': `<?xml version="1.0"?><office:document-styles xmlns:office="${ODS_OFFICE}"/>`,
    [contentName]: `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="${ODS_OFFICE}" xmlns:table="${ODS_TABLE}" xmlns:text="${ODS_TEXT}"><office:body><office:spreadsheet><table:table table:name="S"><table:table-row ${rowAttributes}><table:table-cell ${cellAttributes} office:value-type="string"><text:p>boom</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
  })
}

export function nestedIndexZip(inner: Uint8Array): Uint8Array {
  return zipOf({ 'Index.zip': inner })
}

export function longDocument(paragraphs: number): Uint8Array {
  return docx({
    body: Array.from({ length: paragraphs }, (_unused, i) => paragraph(`p${i}`)).join(''),
  })
}

export const ROWS = 'table:number-rows-repeated'
export const COLUMNS = 'table:number-columns-repeated'
