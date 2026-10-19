import mammoth from 'mammoth'
import { odtOutline } from './odfOutline'
import { GuardStop, type OfficeLimits, type OfficeProblem, problemOf } from './officeLimits'
import { isOdfPart, odfMimetype, requirePackage, unzipParts } from './officeZip'
import { type OutlineWords, documentOutlineHtml } from './outlineHtml'

const ODT_MIMETYPE = 'application/vnd.oasis.opendocument.text'
const IMAGES_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type DocumentResult =
  | { ok: true; html: string; imagesDropped: number; slidesCut: number; textCut: boolean }
  | { ok: false; problem: OfficeProblem }

export async function readDocument(
  bytes: Uint8Array,
  limits: OfficeLimits,
  words: OutlineWords,
): Promise<DocumentResult> {
  try {
    requirePackage(bytes)
    const parts = unzipParts(bytes, isOdfPart)
    if (parts.has('mimetype')) {
      if (odfMimetype(parts) !== ODT_MIMETYPE) throw new GuardStop('failed')
      const outline = documentOutlineHtml(odtOutline(parts, limits), words, limits.outlineChars)
      return {
        ok: true,
        html: outline.html,
        imagesDropped: 0,
        slidesCut: 0,
        textCut: outline.textCut,
      }
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
