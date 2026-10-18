import type { DocumentResult } from './docModel'
import { odpOutline } from './odfOutline'
import { type OfficeLimits, problemOf } from './officeLimits'
import { officeParts } from './officePackage'
import { type OutlineWords, presentationOutlineHtml } from './outlineHtml'
import { pptxOutline } from './pptxOutline'

export function readPresentation(
  bytes: Uint8Array,
  limits: OfficeLimits,
  words: OutlineWords,
): DocumentResult {
  try {
    const { format, parts } = officeParts(bytes, 'presentation', limits)
    const outline = format === 'odp' ? odpOutline(parts, limits) : pptxOutline(parts, limits)
    const { html, textCut } = presentationOutlineHtml(outline.slides, words, limits.outlineChars)
    const slidesCut = outline.slidesCut ? outline.slides.length : 0
    return { ok: true, html, imagesDropped: 0, slidesCut, textCut }
  } catch (error) {
    return { ok: false, problem: problemOf(error) }
  }
}
