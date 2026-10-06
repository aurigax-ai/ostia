export const isMac = process.platform === 'darwin'

export const chords = {
  palette: isMac ? 'Meta+Shift+p' : 'Control+Shift+p',
  find: isMac ? 'Meta+f' : 'Control+Shift+f',
  copy: isMac ? 'Meta+c' : 'Control+Shift+c',
  paste: isMac ? 'Meta+v' : 'Control+Shift+v',
  selectAll: 'ControlOrMeta+a',
  documentEnd: isMac ? 'Meta+ArrowDown' : 'Control+End',
  blockPrev: isMac ? 'Meta+ArrowUp' : 'Control+Shift+ArrowUp',
  blockNext: isMac ? 'Meta+ArrowDown' : 'Control+Shift+ArrowDown',
  history: isMac ? 'Meta+Shift+h' : 'Control+Shift+h',
  splitRight: isMac ? 'Meta+Alt+Backslash' : 'Control+Alt+Backslash',
  focusLeft: isMac ? 'Meta+Control+ArrowLeft' : 'Control+Shift+Alt+h',
  focusRight: isMac ? 'Meta+Control+ArrowRight' : 'Control+Shift+Alt+l',
  zoomPane: isMac ? 'Meta+Shift+x' : 'Control+Shift+x',
  nextTab: 'Control+Tab',
  previousTab: 'Control+Shift+Tab',
}
