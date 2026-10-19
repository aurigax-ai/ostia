import type { agentEn } from './agentEn'

export const agentZhHant: typeof agentEn = {
  agentPane: {
    addToPane: '加入代理窗格',
    emptyBody: '使用 {model}。只會傳送你在此加入的內容。每次修改檔案與執行指令都會等你同意。',
    newSession: '新工作階段',
    noProvider: '請在 settings.json 的 agent.providers 加入模型伺服器，才能使用代理。',
    paneTitle: '代理',
    placeholder: '傳訊息給代理',
  },
}
