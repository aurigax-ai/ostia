import type { Dict } from '../i18n/dict'
import { type CommandDef, commands, wordedBy } from './registry'

export type CoreCommandId = keyof Dict['commands']['titles']
export type CoreCommandCategory = keyof Dict['commands']['categories']

export interface CoreCommandDef<Args = void, R = void>
  extends Omit<CommandDef<Args, R>, 'id' | 'title' | 'category' | 'argument' | 'wording'> {
  id: CoreCommandId
  category?: CoreCommandCategory
}

export function registerCore<Args, R = void>(def: CoreCommandDef<Args, R>): void {
  const { id, category, ...rest } = def
  commands.register<Args, R>({
    ...rest,
    id,
    ...wordedBy((d) => {
      const argument = (d.commands.arguments as Record<string, string | undefined>)[id]
      return {
        title: d.commands.titles[id],
        ...(category ? { category: d.commands.categories[category] } : {}),
        ...(argument ? { argument } : {}),
      }
    }),
  })
}
