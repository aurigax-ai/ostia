use ostia_control::{ConnHandle, PaneIdentity};

pub mod extension_host_deps;
pub mod extension_launches;
pub mod extension_runtime;
pub mod extension_secrets;
pub mod extension_store;

pub trait BuiltinExtensions: Send + Sync {
    fn builtin_id(&self, identity: &PaneIdentity, conn: &ConnHandle) -> Option<String>;
}
