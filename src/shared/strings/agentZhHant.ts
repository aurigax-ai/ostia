import type { agentEn } from './agentEn'

export const agentZhHant: typeof agentEn = {
  agentPane: {
    addToPane: '加入代理窗格',
    emptyBody: '使用 {model}。只會傳送你在此加入的內容。每次修改檔案與執行指令都會等你同意。',
    newSession: '新工作階段',
    noProvider: '請在 settings.json 的 agent.providers 加入模型伺服器，才能使用代理。',
    paneTitle: '代理',
    placeholder: '傳訊息給代理',
    rules: '規則',
    rulesOff: '此工作階段未帶入技能工坊的規則。按一下以帶入。',
    rulesOn: '此工作階段已帶入技能工坊的規則。按一下以不帶入。',
    sandboxed: '沙盒工作區中無法使用代理。',
  },
}
