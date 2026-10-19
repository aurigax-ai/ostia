import { appEnv, withoutEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'

const PROVIDER_PREFIXES = [
  'ANTHROPIC_',
  'OPENAI_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GEMINI_',
  'GCLOUD_',
  'CLOUDSDK_',
  'VERTEX_',
  'GROQ_',
  'MISTRAL_',
  'XAI_',
  'OPENROUTER_',
  'DEEPSEEK_',
  'TOGETHER_',
  'FIREWORKS_',
  'CEREBRAS_',
  'MOONSHOT_',
  'HF_',
  'COPILOT_',
]

const PROVIDER_SUFFIX = /_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$/

function isProviderCredential(name: string): boolean {
  return PROVIDER_SUFFIX.test(name) || PROVIDER_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isProviderCredential(name)))
}

export interface ExtensionEnvParts {
  socket: string
  token: string
  apiVersion: string
  apiEnvName: string
  id: string
  dir: string
  dataDir?: string
}

export function extensionEnvironment(
  parent: NodeJS.ProcessEnv,
  parts: ExtensionEnvParts,
): NodeJS.ProcessEnv {
  return {
    ...withoutProviderCredentials(withoutEnv(parent, ['PANE_ID', 'START_DIR'])),
    ...appEnv({
      SOCKET: parts.socket,
      TOKEN: parts.token,
      [parts.apiEnvName]: parts.apiVersion,
      EXTENSION_ID: parts.id,
      EXTENSION_DIR: parts.dir,
      ...(parts.dataDir ? { EXTENSION_DATA: parts.dataDir } : {}),
    }),
  }
}
