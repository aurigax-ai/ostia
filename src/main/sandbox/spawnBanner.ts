import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { fmt } from '../../shared/app/dict'
import { errorBanner, type PaneBannerText } from '../terminal/paneBanner'

const PACKAGE_BY_ERROR: [RegExp, string][] = [
  [/bubblewrap|bwrap/i, 'bubblewrap'],
  [/socat/i, 'socat'],
  [/ripgrep|\brg\b/i, 'ripgrep'],
]

export function missingPackages(errors: readonly string[]): string[] {
  const found = new Set<string>()
  for (const error of errors) {
    for (const [pattern, pkg] of PACKAGE_BY_ERROR) if (pattern.test(error)) found.add(pkg)
  }
  return [...found]
}

export function sandboxFailureBanner(
  t: PaneBannerText,
  message: string,
  missing: readonly string[],
): string {
  const lines = [errorBanner(fmt(t.sandboxUnavailable, { message }))]
  const packages = missingPackages(missing)
  if (packages.length > 0) {
    lines.push(` ${fmt(t.missing, { packages: packages.join(', ') })}\r\n`)
    lines.push(
      ` ${fmt(t.install, { command: `${PRODUCT_NAME} system install ${packages.join(' ')}` })}\r\n`,
    )
  }
  lines.push(` ${t.noShell}\r\n`)
  return lines.join('')
}

export function hiddenHomeNotice(
  t: PaneBannerText,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'linux') return ''
  const lines = t.hiddenHome.split('\n').map((line) => ` ${line}`)
  return `\x1b[2m${lines.join('\r\n')}\x1b[0m\r\n`
}
