import { fmt } from '@/lib/app/useDict'
import type { FileKindInfo } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import type { Dict } from '@shared/app/dict'

export function kindText(d: Dict, kind: FileKindInfo): string {
  const values = {
    name: kind.displayName,
    patterns: kind.selector.map((item) => item.filenamePattern).join(', '),
  }
  const lines: string[] = []
  if (kind.view) {
    lines.push(
      fmt(
        kind.view.priority === 'option' ? d.extensions.kindViewOption : d.extensions.kindView,
        values,
      ),
    )
  }
  if (kind.browse) lines.push(fmt(d.extensions.kindBrowse, values))
  for (const lost of kind.shadowed ?? []) {
    lines.push(
      fmt(d.extensions.kindShadowed, { patterns: lost.patterns.join(', '), name: lost.name }),
    )
  }
  return lines.join(' ')
}
