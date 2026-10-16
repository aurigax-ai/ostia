import { useState } from 'react'
import { type ChatSlashParams, useChatSlash } from './useChatSlash'

type ChatComposerParams = Omit<
  ChatSlashParams,
  'focused' | 'setPickerQuery' | 'setToolsOpen' | 'setModelOpen'
>

export function useChatComposer(params: ChatComposerParams) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const slash = useChatSlash({
    ...params,
    focused,
    setPickerQuery,
    setToolsOpen,
    setModelOpen,
  })
  return {
    toolsOpen,
    setToolsOpen,
    modelOpen,
    setModelOpen,
    pickerQuery,
    setPickerQuery,
    setFocused,
    slash,
  }
}

export type ChatComposerState = ReturnType<typeof useChatComposer>
