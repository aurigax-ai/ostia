use crate::extension_secrets::SecretError;

pub trait ExtensionSecretStore: Send + Sync {
    fn keys(&self, ext_id: &str) -> Vec<String>;
    fn get(&self, ext_id: &str, key: &str) -> Option<String>;
    fn set(&self, ext_id: &str, key: &str, value: Option<&str>) -> Result<(), SecretError>;
}
