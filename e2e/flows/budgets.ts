export interface Budget {
  p50: number
  p95: number
}

export const BUDGETS: Record<string, Budget> = {
  'launch.window-shown': { p50: 1300, p95: 1500 },
  'launch.first-paint': { p50: 1500, p95: 1700 },
  'restore.first-paint': { p50: 1600, p95: 1900 },
  'restore.shown-prompt': { p50: 1700, p95: 2000 },
  'restore.all-panes': { p50: 1800, p95: 2200 },
  'restore.focus': { p50: 1700, p95: 2000 },
  'tab.new-shown': { p50: 50, p95: 100 },
  'tab.new-prompt': { p50: 300, p95: 500 },
  'tab.new-focus': { p50: 100, p95: 200 },
  'split.prompt': { p50: 300, p95: 500 },
  'workspace.switch-painted': { p50: 100, p95: 200 },
  'workspace.switch-focus': { p50: 100, p95: 200 },
  'palette.open': { p50: 100, p95: 150 },
  'settings.open': { p50: 100, p95: 150 },
  'file.open-editor': { p50: 300, p95: 500 },
  'file.open-editor-cold': { p50: 800, p95: 800 },
  'cli.round-trip': { p50: 250, p95: 400 },
  'cli.agent-run': { p50: 2500, p95: 4000 },
  'cli.pane-send': { p50: 400, p95: 700 },
  'agent.resume-running': { p50: 2500, p95: 4000 },
  'agent.wake-ready': { p50: 2500, p95: 4000 },
  'bus.send-taken': { p50: 500, p95: 1000 },
  'link.path-editor': { p50: 300, p95: 500 },
  'link.web-browser': { p50: 300, p95: 500 },
  'agent-pane.first-token': { p50: 500, p95: 1000 },
}
