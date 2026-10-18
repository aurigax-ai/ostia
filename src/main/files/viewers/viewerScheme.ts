import { VIEWER_SCHEME } from '@aurigax-ai/ostia-extension-sdk/contract/fileViewers'
import type { CustomScheme } from 'electron'

export const VIEWER_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: VIEWER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}
