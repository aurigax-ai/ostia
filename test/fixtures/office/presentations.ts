import { strToU8 } from 'fflate'
import { type ZipEntry, deflated, rawZip } from './workbooks'

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const ODF = 'urn:oasis:names:tc:opendocument:xmlns'

export const PPTX_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
export const PPTM_TYPE = 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'
export const PPSX_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'
export const ODP_MIMETYPE = 'application/vnd.oasis.opendocument.presentation'
export const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text'

export interface PptxSlide {
  shapes: string
  relationships?: string
  notes?: string
  show?: string
  doctype?: string
}

export interface PptxParts {
  slides: PptxSlide[]
  order?: number[]
  contentType?: string
  presentationRelationships?: string
  extra?: ZipEntry[]
  omit?: string[]
}

function zipOf(files: Record<string, string>, extra: ZipEntry[] = [], omit: string[] = []) {
  return rawZip([
    ...Object.entries(files)
      .filter(([name]) => !omit.includes(name))
      .map(([name, data]) => deflated(name, strToU8(data))),
    ...extra,
  ])
}

export function run(text: string, link?: string): string {
  const click = link ? `<a:rPr><a:hlinkClick r:id="${link}"/></a:rPr>` : ''
  return `<a:r>${click}<a:t>${text}</a:t></a:r>`
}

export function para(content: string, properties = ''): string {
  return `<a:p>${properties}${content}</a:p>`
}

export function shape(paragraphs: string, placeholder?: string): string {
  const ph =
    placeholder === undefined ? '' : `<p:ph${placeholder ? ` type="${placeholder}"` : ''}/>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`
}

export function titleShape(text: string): string {
  return shape(para(run(text)), 'title')
}

export function picture(alt: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 3" descr="${alt}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rImg"/></p:blipFill><p:spPr/></p:pic>`
}

export function table(rows: string[][]): string {
  const body = rows.map((cells) => `<a:tr h="1">${cells.join('')}</a:tr>`).join('')
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid/>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

export function cell(text: string, attributes = ''): string {
  return `<a:tc${attributes ? ` ${attributes}` : ''}><a:txBody><a:bodyPr/>${para(run(text))}</a:txBody></a:tc>`
}

export function relationship(id: string, type: string, target: string, external = false) {
  const mode = external ? ' TargetMode="External"' : ''
  return `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode}/>`
}

function slideXml({ shapes, show, doctype = '' }: PptxSlide): string {
  const shown = show === undefined ? '' : ` show="${show}"`
  return `<?xml version="1.0" encoding="UTF-8"?>${doctype}<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"${shown}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`
}

function notesXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${shape('', 'sldImg')}${shape(para(run(text)), 'body')}${shape(para(run('7')), 'sldNum')}</p:spTree></p:cSld></p:notes>`
}

export function pptx({
  slides,
  order = slides.map((_slide, i) => i),
  contentType = PPTX_TYPE,
  presentationRelationships = '',
  extra = [],
  omit = [],
}: PptxParts): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${contentType}"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}">${relationship('rId1', 'officeDocument', 'ppt/presentation.xml')}</Relationships>`,
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${order.map((index, i) => `<p:sldId id="${256 + i}" r:id="rS${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}">${slides.map((_slide, i) => relationship(`rS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`)).join('')}${presentationRelationships}</Relationships>`,
  }
  for (const [i, slide] of slides.entries()) {
    const notes =
      slide.notes === undefined
        ? ''
        : relationship('rN', 'notesSlide', `../notesSlides/notesSlide${i + 1}.xml`)
    files[`ppt/slides/slide${i + 1}.xml`] = slideXml(slide)
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] =
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}">${notes}${slide.relationships ?? ''}</Relationships>`
    if (slide.notes !== undefined) {
      files[`ppt/notesSlides/notesSlide${i + 1}.xml`] = notesXml(slide.notes)
    }
  }
  return zipOf(files, extra, omit)
}

export interface OdfParts {
  body: string
  styles?: string
  manifest?: string
  content?: string
  extra?: ZipEntry[]
}

const ODF_NAMESPACES = [
  `xmlns:office="${ODF}:office:1.0"`,
  `xmlns:text="${ODF}:text:1.0"`,
  `xmlns:table="${ODF}:table:1.0"`,
  `xmlns:draw="${ODF}:drawing:1.0"`,
  `xmlns:presentation="${ODF}:presentation:1.0"`,
  `xmlns:style="${ODF}:style:1.0"`,
  `xmlns:svg="${ODF}:svg-compatible:1.0"`,
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ')

export function odf(
  mimetype: string,
  { body, styles = '', manifest = '', content, extra = [] }: OdfParts,
): Uint8Array {
  const kind = mimetype === ODP_MIMETYPE ? 'presentation' : 'text'
  return zipOf(
    {
      mimetype,
      'META-INF/manifest.xml': `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="${ODF}:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>${manifest}</manifest:manifest>`,
      'content.xml':
        content ??
        `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES}><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
    },
    extra,
  )
}

export function odfContent(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NAMESPACES}>${inner}</office:document-content>`
}

export function odpPage(name: string, shapes: string, attributes = ''): string {
  return `<draw:page draw:name="${name}"${attributes ? ` ${attributes}` : ''}>${shapes}</draw:page>`
}

export function odpFrame(className: string, paragraphs: string): string {
  return `<draw:frame presentation:class="${className}"><draw:text-box>${paragraphs}</draw:text-box></draw:frame>`
}

export function odpNotes(text: string): string {
  return `<presentation:notes><draw:page-thumbnail/>${odpFrame('notes', `<text:p>${text}</text:p>`)}</presentation:notes>`
}
