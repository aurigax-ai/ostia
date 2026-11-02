use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileOpError {
    Outside,
    InvalidName,
    Exists,
    IntoItself,
    Sandboxed,
    NotMoved,
    Partial,
    NoTrash,
    Failed,
}
