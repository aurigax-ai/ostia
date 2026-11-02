use ostia_control::{ConnHandle, PaneIdentity};

pub trait BuiltinExtensions: Send + Sync {
    fn builtin_id(&self, identity: &PaneIdentity, conn: &ConnHandle) -> Option<String>;
}
