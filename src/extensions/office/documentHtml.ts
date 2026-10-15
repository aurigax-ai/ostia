import DOMPurify from 'dompurify'

export const DOCUMENT_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'strong',
  'em',
  'u',
  's',
  'sub',
  'sup',
  'br',
  'a',
  'img',
  'blockquote',
  'pre',
  'code',
]

const LINKABLE = /^(?:data:image\/(?:png|jpe?g|gif|webp);base64,|https?:|mailto:)/i
const IMAGE_SOURCE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i

export function sanitizeDocument(html: string, purify = DOMPurify): DocumentFragment {
  const fragment = purify.sanitize(html, {
    ALLOWED_TAGS: DOCUMENT_TAGS,
    ALLOWED_ATTR: ['href', 'src', 'alt', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: LINKABLE,
    ADD_URI_SAFE_ATTR: ['colspan', 'rowspan'],
    RETURN_DOM_FRAGMENT: true,
  })
  for (const image of Array.from(fragment.querySelectorAll('img'))) {
    if (!IMAGE_SOURCE.test(image.getAttribute('src') ?? '')) image.remove()
  }
  for (const link of Array.from(fragment.querySelectorAll('a'))) {
    const href = link.getAttribute('href')
    link.removeAttribute('href')
    if (href) link.title = href
  }
  return fragment
}
