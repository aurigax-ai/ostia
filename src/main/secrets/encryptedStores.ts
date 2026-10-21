import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { ExtensionConnections } from '../extensions/extensionConnections'
import { createSecretStore, type SecretStoreDeps } from '../extensions/extensionSecrets'
import { loadJson, saveJson, storePath } from '../platform/jsonStore'

export function createEncryptedStores() {
  let connectionsStore: ExtensionConnections | null = null

  function extensionConnections(): ExtensionConnections {
    connectionsStore ??= new ExtensionConnections(
      join(app.getPath('userData'), 'extension-connections.json'),
      () => extensionSecretStore(),
    )
    return connectionsStore
  }

  function extensionSecretStore() {
    return encryptedStore(storePath('extension-secrets', 'global'))
  }

  function assistKeyStore() {
    return encryptedStore(storePath('assist-keys', 'global'))
  }

  function encryptedFile(path: string): SecretStoreDeps {
    return {
      load: () => loadJson<unknown>(path, {}),
      save: (data) => saveJson(path, data, { secure: true }),
      canEncrypt: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
    }
  }

  function encryptedStore(path: string) {
    return createSecretStore(encryptedFile(path))
  }

  return {
    extensionConnections,
    extensionSecretStore,
    assistKeyStore,
    encryptedFile,
    encryptedStore,
  }
}
