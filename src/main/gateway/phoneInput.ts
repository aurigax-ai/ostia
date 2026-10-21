import type { PaneIdentity } from '../control/idRegistry'
import type { PtyIo } from '../terminal/pty/ptyIo'

export function phoneInputNoted(
  ptyWrite: PtyIo['ptyWrite'],
  identityOf: (rendererPaneId: string) => PaneIdentity | undefined,
  inputSent: (pane: PaneIdentity) => void,
): PtyIo['ptyWrite'] {
  return (rendererPaneId, data, source) => {
    ptyWrite(rendererPaneId, data, source)
    const pane = identityOf(rendererPaneId)
    if (pane) inputSent(pane)
  }
}
