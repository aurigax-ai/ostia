use ostia_control::{ConnHandle, PaneIdentity};

pub mod assist_model_choices;
pub mod extension_connections;
pub mod extension_contributions;
pub mod extension_env;
pub mod extension_host_deps;
pub mod extension_launches;
pub mod extension_runtime;
pub mod extension_secrets;
pub mod extension_store;

pub trait BuiltinExtensions: Send + Sync {
    fn builtin_id(&self, identity: &PaneIdentity, conn: &ConnHandle) -> Option<String>;
}
