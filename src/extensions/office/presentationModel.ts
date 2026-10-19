import type { DocumentResult } from './docModel'
import { odpOutline } from './odfOutline'
import { GuardStop, type OfficeLimits, problemOf } from './officeLimits'
import { isOdfPart, odfMimetype, requirePackage, unzipParts } from './officeZip'
import { type OutlineWords, presentationOutlineHtml } from './outlineHtml'
import { pptxOutline } from './pptxOutline'

const ODP_MIMETYPE = 'application/vnd.oasis.opendocument.presentation'
const PRESENTATION_PART =
  /^(?:\[content_types\]\.xml|ppt\/presentation\.xml|ppt\/_rels\/presentation\.xml\.rels|ppt\/(?:slides|notesslides)\/(?:[^/]+\.xml|_rels\/[^/]+\.xml\.rels))$/

export function readPresentation(
  bytes: Uint8Array,
  limits: OfficeLimits,
  words: OutlineWords,
): DocumentResult {
  try {
    requirePackage(bytes)
    const parts = unzipParts(bytes, (key) => isOdfPart(key) || PRESENTATION_PART.test(key))
    const odf = parts.has('mimetype')
    if (odf && odfMimetype(parts) !== ODP_MIMETYPE) throw new GuardStop('failed')
    const outline = odf ? odpOutline(parts, limits) : pptxOutline(parts, limits)
    const { html, textCut } = presentationOutlineHtml(outline.slides, words, limits.outlineChars)
    const slidesCut = outline.slidesCut ? outline.slides.length : 0
    return { ok: true, html, imagesDropped: 0, slidesCut, textCut }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}
