use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretSource {
    Host,
    Ostia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretKind {
    SshKey,
    Env,
    GhToken,
    Vault,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SecretEntry {
    pub id: String,
    pub name: String,
    pub source: SecretSource,
    pub kind: SecretKind,
    pub editable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretGrantMode {
    Env,
    File,
    Request,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SecretGrant {
    pub id: String,
    pub mode: SecretGrantMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
