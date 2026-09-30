import type { AssistFeatureId } from '../../shared/assist'

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
  problems: Record<'no-provider' | 'no-endpoint' | 'no-key' | 'no-model' | 'unreachable', string>
  featuresTitle: string
  features: Record<AssistFeatureId, string>
  featureHelp: Record<AssistFeatureId, string>
  hints: {
    chatPane: (keys: string) => string
    ask: (keys: string) => string
    composer: (keys: string) => string
    review: string
    hash: string
    terminal: string
    editor: string
    explain: string
  }
  off: string
  ready: string
  notReady: string
  problemShort: Record<
    'no-provider' | 'no-endpoint' | 'no-key' | 'no-model' | 'unreachable',
    string
  >
  lastError: string
  tryIt: string
  loading: string
  working: string
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
    unreachable: 'The provider did not answer. Check that it is running and that baseUrl is right.',
  },
  featuresTitle: 'Features',
  features: {
    chat: 'Chat and Ask',
    typos: 'Typo fix',
    promptReview: 'Prompt review',
    commandSuggest: 'Command suggestions',
    terminalCompletions: 'Terminal completion',
    editorCompletions: 'Editor completion',
    explainError: 'Explain error',
  },
  featureHelp: {
    chat: 'A conversation in its own pane, or in the command palette',
    typos: 'Fixes typos in a prompt you write for an agent; you accept it with Tab',
    promptReview: 'Scores a prompt for an agent and names what is missing',
    commandSuggest: 'Turns a description into commands inserted at the prompt, never run',
    terminalCompletions: 'Ghost text that finishes the command you are typing',
    editorCompletions: 'Ghost text in the editor from the code around the cursor',
    explainError: 'Explains a failed command from its block menu',
  },
  hints: {
    chatPane: (keys) => `${keys} chat pane`,
    ask: (keys) => `${keys} then Tab to ask`,
    composer: (keys) => `${keys} composer`,
    review: 'Ctrl+Enter in the composer',
    hash: '# in the input editor',
    terminal: 'Tab or → at the prompt (input editor)',
    editor: 'Tab in the editor',
    explain: 'Block menu of a failed command',
  },
  off: 'Off',
  ready: 'Ready',
  notReady: 'Not ready',
  problemShort: {
    'no-provider': 'No provider',
    'no-endpoint': 'No address',
    'no-key': 'No API key',
    'no-model': 'No model',
    unreachable: 'Unreachable',
  },
  lastError: 'Last error',
  tryIt: 'Try it',
  loading: 'Loading…',
  working: 'Working…',
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
    unreachable: '供應者沒有回應。請確認它正在執行，且 baseUrl 正確。',
  },
  featuresTitle: '功能',
  features: {
    chat: '對話與提問',
    typos: '錯字修正',
    promptReview: '提示詞審閱',
    commandSuggest: '指令建議',
    terminalCompletions: '終端機自動完成',
    editorCompletions: '編輯器自動完成',
    explainError: '解釋錯誤',
  },
  featureHelp: {
    chat: '在獨立窗格或命令面板中對話',
    typos: '修正你寫給代理程式的提示詞中的錯字；按 Tab 接受',
    promptReview: '為給代理程式的提示詞評分，並指出缺少的內容',
    commandSuggest: '把描述轉成指令並插入提示列，絕不自動執行',
    terminalCompletions: '以淡色文字補完你正在輸入的指令',
    editorCompletions: '依游標周圍的程式碼在編輯器中顯示淡色補完',
    explainError: '從失敗指令區塊的選單解釋錯誤',
  },
  hints: {
    chatPane: (keys) => `${keys} 對話窗格`,
    ask: (keys) => `${keys} 後按 Tab 提問`,
    composer: (keys) => `${keys} 撰寫列`,
    review: '在撰寫列按 Ctrl+Enter',
    hash: '在輸入編輯器輸入 #',
    terminal: '在提示列按 Tab 或 →（輸入編輯器）',
    editor: '在編輯器按 Tab',
    explain: '失敗指令區塊的選單',
  },
  off: '關閉',
  ready: '就緒',
  notReady: '未就緒',
  problemShort: {
    'no-provider': '未選供應者',
    'no-endpoint': '沒有位址',
    'no-key': '沒有 API 金鑰',
    'no-model': '沒有模型',
    unreachable: '無法連線',
  },
  lastError: '上次錯誤',
  tryIt: '試試看',
  loading: '載入中…',
  working: '處理中…',
}

export const PANEL_STRINGS = { en, 'zh-Hant': zhHant }
