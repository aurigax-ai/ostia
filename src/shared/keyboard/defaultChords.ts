import {
  type BROWSER_CHORD_IDS,
  type ChordValue,
  DIGIT_RANGE,
  DOUBLE_SHIFT,
  type TERMINAL_CHORD_IDS,
} from './chordSpec'

type AppChord =
  | 'app.quit'
  | 'palette.toggle'
  | 'palette.searchEverywhere'
  | 'view.goToFile'
  | 'view.toggleRail'
  | 'app.openSettings'
  | 'view.searchFiles'
  | 'attention.jumpToLatest'
  | 'history.search'
  | 'snippets.search'
  | 'workspace.new'
  | 'workspace.openPad'
  | 'window.new'
  | 'tab.new'
  | 'terminal.clear'
  | 'agent.resume'
  | 'workspace.goto'
  | 'selection.sendToAgent'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'assist.compose'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.focusLeft'
  | 'pane.focusRight'
  | 'pane.focusUp'
  | 'pane.focusDown'
  | 'pane.zoom'
  | 'pane.collapse'
  | 'pane.close'
  | 'tab.next'
  | 'tab.previous'
  | 'workspace.next'
  | 'workspace.previous'

export type TerminalChord = (typeof TERMINAL_CHORD_IDS)[number]

export type BrowserChord = (typeof BROWSER_CHORD_IDS)[number]

export const DEFAULT_CHORDS: Readonly<
  Record<AppChord | TerminalChord | BrowserChord, [mac: ChordValue, other: ChordValue]>
> = {
  'app.quit': ['', 'Ctrl+Shift+Q'],
  'palette.toggle': [
    ['Shift+Cmd+P', 'Cmd+K', 'F1'],
    ['Ctrl+Shift+P', 'F1'],
  ],
  'palette.searchEverywhere': [DOUBLE_SHIFT, DOUBLE_SHIFT],
  'view.goToFile': ['Cmd+P', 'Ctrl+Alt+G'],
  'view.toggleRail': [['Cmd+B', 'Cmd+\\'], 'Ctrl+Shift+B'],
  'app.openSettings': ['Cmd+,', 'Ctrl+,'],
  'view.searchFiles': ['Shift+Cmd+F', ''],
  'attention.jumpToLatest': ['Cmd+Shift+U', 'Ctrl+Shift+U'],
  'history.search': ['Cmd+Shift+H', 'Ctrl+Shift+H'],
  'snippets.search': ['Cmd+Shift+S', 'Ctrl+Shift+S'],
  'workspace.new': ['Cmd+N', 'Ctrl+Shift+N'],
  'workspace.openPad': ['Cmd+Alt+N', 'Ctrl+Alt+N'],
  'window.new': ['Cmd+Shift+N', 'Ctrl+Shift+Alt+N'],
  'tab.new': ['Cmd+T', 'Ctrl+Shift+T'],
  'terminal.clear': ['terminal:Shift+Cmd+K', 'terminal:Ctrl+Shift+K'],
  'agent.resume': ['Cmd+Shift+R', 'Ctrl+Shift+R'],
  'workspace.goto': [`Cmd+${DIGIT_RANGE}`, `Ctrl+${DIGIT_RANGE}`],
  'selection.sendToAgent': ['Cmd+Shift+E', 'Ctrl+Shift+E'],
  'view.zoomIn': [['Cmd+=', 'Shift+Cmd+='], 'Ctrl+='],
  'view.zoomOut': ['Cmd+-', 'Ctrl+Shift+-'],
  'view.zoomReset': ['Cmd+0', 'Ctrl+0'],
  'assist.compose': ['Cmd+J', 'Ctrl+Shift+J'],
  'pane.splitRight': [['terminal:Cmd+D', 'Cmd+Alt+\\'], 'Ctrl+Alt+\\'],
  'pane.splitDown': [['terminal:Shift+Cmd+D', 'Cmd+Alt+-'], 'Ctrl+Alt+-'],
  'pane.focusLeft': [['terminal:Cmd+Alt+Left', 'Cmd+Ctrl+Left'], 'Ctrl+Shift+Alt+H'],
  'pane.focusRight': [['terminal:Cmd+Alt+Right', 'Cmd+Ctrl+Right'], 'Ctrl+Shift+Alt+L'],
  'pane.focusUp': [['terminal:Cmd+Alt+Up', 'Cmd+Ctrl+Up'], 'Ctrl+Shift+Alt+K'],
  'pane.focusDown': [['terminal:Cmd+Alt+Down', 'Cmd+Ctrl+Down'], 'Ctrl+Shift+Alt+J'],
  'pane.zoom': [
    ['terminal:Shift+Cmd+Enter', 'Cmd+Shift+X'],
    ['terminal:Ctrl+Shift+Enter', 'Ctrl+Shift+X'],
  ],
  'pane.collapse': ['Cmd+Ctrl+M', 'Ctrl+Shift+Alt+M'],
  'pane.close': ['Cmd+W', 'Ctrl+Shift+W'],
  'tab.next': [
    ['Ctrl+Tab', 'Shift+Cmd+]'],
    ['Ctrl+Tab', 'Ctrl+PageDown'],
  ],
  'tab.previous': [
    ['Ctrl+Shift+Tab', 'Shift+Cmd+['],
    ['Ctrl+Shift+Tab', 'Ctrl+PageUp'],
  ],
  'workspace.next': ['Cmd+Ctrl+]', 'Ctrl+Shift+PageDown'],
  'workspace.previous': ['Cmd+Ctrl+[', 'Ctrl+Shift+PageUp'],
  copy: ['Cmd+C', 'Ctrl+Shift+C'],
  paste: ['Cmd+V', 'Ctrl+Shift+V'],
  find: ['Cmd+F', 'Ctrl+Shift+F'],
  'find.next': ['Cmd+G', ''],
  'find.previous': ['Shift+Cmd+G', ''],
  'block.selectPrev': ['Cmd+Up', 'Ctrl+Shift+Up'],
  'block.selectNext': ['Cmd+Down', 'Ctrl+Shift+Down'],
  'terminal.scrollToTop': ['Cmd+Home', ''],
  'terminal.scrollToBottom': ['Cmd+End', ''],
  'terminal.scrollPageUp': ['Cmd+PageUp', ''],
  'terminal.scrollPageDown': ['Cmd+PageDown', ''],
  'terminal.scrollLineUp': ['', ''],
  'terminal.scrollLineDown': ['', ''],
  'terminal.reviewOutput': ['Alt+Cmd+O', ''],
  'tab.moveLeft': ['Shift+Cmd+Left', ''],
  'tab.moveRight': ['Shift+Cmd+Right', ''],
  'browser.focusAddress': ['Cmd+L', ['Ctrl+L', 'Ctrl+Shift+L']],
  'browser.reload': ['Cmd+R', ['Ctrl+R', 'Ctrl+F5']],
  'browser.back': ['Cmd+[', 'Alt+Left'],
  'browser.forward': ['Cmd+]', 'Alt+Right'],
}
