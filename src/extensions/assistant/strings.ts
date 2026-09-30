export interface PanelStrings {
  title: string
  provider: string
  endpoint: string
  fastModel: string
  chatModel: string
  notSet: string
  models: string
  refresh: string
  load: string
  unload: string
  copy: string
  copied: string
  loaded: string
  notLoaded: string
  notInstalled: string
  busy: string
  idle: (seconds: number) => string
  noModels: string
  modelsFailed: string
  lifecycleHint: string
  copyHint: string
  problems: Record<'no-provider' | 'no-endpoint' | 'no-key' | 'no-model', string>
}

const en: PanelStrings = {
  title: 'Assistant',
  provider: 'Provider',
  endpoint: 'Endpoint',
  fastModel: 'Fast model',
  chatModel: 'Chat model',
  notSet: 'not set',
  models: 'Models',
  refresh: 'Refresh',
  load: 'Load',
  unload: 'Unload',
  copy: 'Copy id',
  copied: 'Copied',
  loaded: 'Loaded',
  notLoaded: 'Not loaded',
  notInstalled: 'Not installed',
  busy: 'Working',
  idle: (s) => (s < 60 ? `idle ${s}s` : `idle ${Math.round(s / 60)}m`),
  noModels: 'The provider lists no models.',
  modelsFailed: 'Could not list models',
  lifecycleHint: 'Load a model before its first request, or unload one to free its memory.',
  copyHint: 'Copy an id into fastModel or chatModel in Settings → Plugins → Assistant.',
  problems: {
    'no-provider':
      'Pick a provider in Settings → Plugins → Assistant. Nothing is sent until you do.',
    'no-endpoint': 'Set baseUrl to the provider’s address (http, https or unix:/path.sock).',
    'no-key': 'Save an API key in Settings → Plugins → Assistant.',
    'no-model': 'Set fastModel (and optionally chatModel) in Settings → Plugins → Assistant.',
  },
}

const zhHant: PanelStrings = {
  title: '助理',
  provider: '供應者',
  endpoint: '端點',
  fastModel: '快速模型',
  chatModel: '對話模型',
  notSet: '未設定',
  models: '模型',
  refresh: '重新整理',
  load: '載入',
  unload: '卸載',
  copy: '複製 ID',
  copied: '已複製',
  loaded: '已載入',
  notLoaded: '未載入',
  notInstalled: '未安裝',
  busy: '處理中',
  idle: (s) => (s < 60 ? `閒置 ${s} 秒` : `閒置 ${Math.round(s / 60)} 分`),
  noModels: '供應者沒有列出任何模型。',
  modelsFailed: '無法列出模型',
  lifecycleHint: '在第一次請求前先載入模型，或卸載模型以釋放記憶體。',
  copyHint: '將 ID 複製到「設定 → 外掛 → 助理」的 fastModel 或 chatModel。',
  problems: {
    'no-provider': '請在「設定 → 外掛 → 助理」選擇供應者。在那之前不會傳送任何內容。',
    'no-endpoint': '請將 baseUrl 設為供應者的位址（http、https 或 unix:/path.sock）。',
    'no-key': '請在「設定 → 外掛 → 助理」儲存 API 金鑰。',
    'no-model': '請在「設定 → 外掛 → 助理」設定 fastModel（以及選用的 chatModel）。',
  },
}

export const PANEL_STRINGS = { en, 'zh-Hant': zhHant }
