import mammoth from 'mammoth'
import { odtOutline } from './odfOutline'
import { type OfficeLimits, type OfficeProblem, problemOf } from './officeLimits'
import { officeParts, zipParts } from './officePackage'
import { type OutlineWords, documentOutlineHtml } from './outlineHtml'

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
    const { format, parts } = officeParts(bytes, 'document', limits)
    if (format === 'odt') {
      const outline = documentOutlineHtml(odtOutline(parts, limits), words, limits.outlineChars)
      return {
        ok: true,
        html: outline.html,
        imagesDropped: 0,
        slidesCut: 0,
        textCut: outline.textCut,
      }
    }
    const packed = zipParts(parts)
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
    const input = { arrayBuffer: packed.buffer, buffer: packed }
    const result = await mammoth.convertToHtml(input as unknown as { arrayBuffer: ArrayBuffer }, {
      convertImage,
      externalFileAccess: false,
    })
    return { ok: true, html: result.value, imagesDropped, slidesCut: 0, textCut: false }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}
