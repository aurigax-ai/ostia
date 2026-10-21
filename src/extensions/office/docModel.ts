import mammoth from 'mammoth'
import { wordBinaryBlocks } from './docBinary'
import { odtOutline } from './odfOutline'
import { GuardStop, type OfficeLimits, type OfficeProblem, problemOf } from './officeLimits'
import { isCompoundFile, isOdfPart, odfMimetype, requirePackage, unzipParts } from './officeZip'
import { type Block, documentOutlineHtml, type OutlineWords } from './outlineHtml'

const ODT_MIMETYPES = new Set([
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.text-template',
])
const IMAGES_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type DocumentResult =
  | { ok: true; html: string; imagesDropped: number; slidesCut: number; textCut: boolean }
  | { ok: false; problem: OfficeProblem }

function outlineResult(blocks: Block[], words: OutlineWords, limits: OfficeLimits): DocumentResult {
  const outline = documentOutlineHtml(blocks, words, limits.outlineChars)
  return { ok: true, html: outline.html, imagesDropped: 0, slidesCut: 0, textCut: outline.textCut }
}

export async function readDocument(
  bytes: Uint8Array,
  limits: OfficeLimits,
  words: OutlineWords,
): Promise<DocumentResult> {
  try {
    requirePackage(bytes)
    if (isCompoundFile(bytes)) {
      return outlineResult(await wordBinaryBlocks(bytes), words, limits)
    }
    const parts = unzipParts(bytes, isOdfPart)
    if (parts.has('mimetype')) {
      if (!ODT_MIMETYPES.has(odfMimetype(parts))) throw new GuardStop('failed')
      return outlineResult(odtOutline(parts, limits), words, limits)
    }
    let imageBytes = 0
    let imagesDropped = 0
    const convertImage = mammoth.images.imgElement(async (image) => {
      if (!IMAGE_TYPES.has(image.contentType)) {
        imagesDropped++
        return { src: '' }
      }
      const data = await image.readAsBase64String()
      imageBytes += data.length
      if (imageBytes > IMAGES_MAX_BYTES) {
        imagesDropped++
        return { src: '' }
      }
      return { src: `data:${image.contentType};base64,${data}` }
    })
    const input = { arrayBuffer: bytes.buffer, buffer: bytes }
    const result = await mammoth.convertToHtml(input as unknown as { arrayBuffer: ArrayBuffer }, {
      convertImage,
      externalFileAccess: false,
    })
    return { ok: true, html: result.value, imagesDropped, slidesCut: 0, textCut: false }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}
