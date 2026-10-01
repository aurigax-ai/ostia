import { runAssistExtension } from '../sdk/assist/run'
import { MODEL_RUNTIME, MODEL_RUNTIME_CATALOG } from './provider'

runAssistExtension({ catalog: MODEL_RUNTIME_CATALOG, provider: MODEL_RUNTIME })
