import type { JSX } from 'react'
import { ChatComposer, type ChatComposerProps } from './ChatComposer'
import { ChatSlashMenu } from './ChatSlashMenu'
import type { ChatComposerState } from './useChatComposer'

type ChatComposerAreaProps = Omit<
  ChatComposerProps,
  | 'toolsOpen'
  | 'setToolsOpen'
  | 'modelOpen'
  | 'setModelOpen'
  | 'setFocused'
  | 'pickerQuery'
  | 'setPickerQuery'
  | 'slash'
> & { composer: ChatComposerState }

export function ChatComposerArea({
  composer,
  areaRef,
  ...rest
}: ChatComposerAreaProps): JSX.Element {
  const { toolsOpen, setToolsOpen, modelOpen, setModelOpen, setFocused } = composer
  const { pickerQuery, setPickerQuery, slash } = composer
  const { menu, rows, active, anchor, setSlashKey, pickRow } = slash
  return (
    <>
      <ChatComposer
        {...rest}
        areaRef={areaRef}
        toolsOpen={toolsOpen}
        setToolsOpen={setToolsOpen}
        modelOpen={modelOpen}
        setModelOpen={setModelOpen}
        setFocused={setFocused}
        pickerQuery={pickerQuery}
        setPickerQuery={setPickerQuery}
        slash={slash}
      />
      {menu ? (
        <ChatSlashMenu
          menu={menu}
          rows={rows}
          activeKey={active?.key}
          anchor={anchor}
          areaRef={areaRef}
          onActive={setSlashKey}
          onPick={(row) => pickRow(row, false)}
        />
      ) : null}
    </>
  )
}
