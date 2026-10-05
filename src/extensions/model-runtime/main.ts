import { runAssistExtension } from '@aurigax-ai/ostia-extension-sdk/assist'
import { MODEL_RUNTIME, MODEL_RUNTIME_CATALOG } from './provider'

runAssistExtension({ catalog: MODEL_RUNTIME_CATALOG, provider: MODEL_RUNTIME })
