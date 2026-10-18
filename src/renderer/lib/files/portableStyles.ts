const VARIABLE = /var\(\s*(--[\w-]+)/g

const MEDIA_RULE = 4
const SUPPORTS_RULE = 12

function matchingRules(rules: CSSRuleList, match: RegExp, out: string[]): void {
  for (const rule of Array.from(rules)) {
    if ('selectorText' in rule) {
      if (match.test(String(rule.selectorText))) out.push(rule.cssText)
      continue
    }
    if (!('cssRules' in rule)) continue
    const inner: string[] = []
    matchingRules((rule as CSSGroupingRule).cssRules, match, inner)
    if (inner.length === 0) continue
    const condition = (rule as CSSConditionRule).conditionText
    if (rule.type === MEDIA_RULE) out.push(`@media ${condition}{${inner.join('')}}`)
    else if (rule.type === SUPPORTS_RULE) out.push(`@supports ${condition}{${inner.join('')}}`)
    else out.push(...inner)
  }
}

export function stylesMatching(
  match: RegExp,
  root: HTMLElement = document.documentElement,
): string {
  const rules: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      matchingRules(sheet.cssRules, match, rules)
    } catch {}
  }
  const css = rules.join('\n')
  const style = getComputedStyle(root)
  const names = new Set<string>()
  const pending = [...css.matchAll(VARIABLE)].map((found) => found[1])
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (names.has(name)) continue
    names.add(name)
    for (const found of style.getPropertyValue(name).matchAll(VARIABLE)) pending.push(found[1])
  }
  const values = [...names]
    .map((name) => [name, style.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}:${value}`)
  return values.length > 0 ? `:root{${values.join(';')}}\n${css}` : css
}
