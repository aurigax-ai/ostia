use std::collections::{HashMap, HashSet};
use std::fs;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_base::node_path;
use ostia_contract::approvals::{ApprovalAnswer, ApprovalOutcome};
use ostia_contract::secrets::{SecretEntry, SecretKind, SecretSource};
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;

const SECRET_ENV_SUFFIXES: [&str; 4] = ["_TOKEN", "_KEY", "_SECRET", "_PASSWORD"];
const KEY_PEEK_UNITS: usize = 128;
const KEY_PEEK_BYTES: u64 = 384;
const SSH_DIR: &str = ".ssh";
const GH_ID: &str = "host:gh";
const GH_NAME: &str = "gh auth token";

static PRIVATE_KEY_HEADER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultScope {
    Global,
    Project,
}

impl VaultScope {
    fn word(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    fn parse(word: &str) -> Option<Self> {
        match word {
            "global" => Some(Self::Global),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultKey {
    pub key: String,
    pub scope: VaultScope,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretAsk {
    pub workspace_id: String,
    pub pane_id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretGetError {
    UnknownSecret,
    Ambiguous,
    Denied,
    Missing,
}

pub type AskFuture = Pin<Box<dyn Future<Output = ApprovalOutcome> + Send>>;

pub struct SecretServiceDeps {
    pub home: Box<dyn Fn() -> PathBuf + Send + Sync>,
    pub env: Box<dyn Fn() -> HashMap<String, String> + Send + Sync>,
    pub gh_token: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub vault_list: Box<dyn Fn(&str) -> Vec<VaultKey> + Send + Sync>,
    pub vault_get: Box<dyn Fn(&str, VaultScope, &str) -> Option<String> + Send + Sync>,
    pub granted_ids: Box<dyn Fn(&str) -> Vec<String> + Send + Sync>,
    pub ask: Box<dyn Fn(SecretAsk) -> AskFuture + Send + Sync>,
}

fn looks_like_private_key(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(KEY_PEEK_BYTES).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut units = 0;
    let head: String = text
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= KEY_PEEK_UNITS
        })
        .collect();
    PRIVATE_KEY_HEADER.is_match(&head)
}

fn ssh_keys(home: &Path) -> Vec<String> {
    let dir = home.join(SSH_DIR);
    let Ok(read) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = read
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_unstable();
    names.retain(|name| looks_like_private_key(&node_path::join(&dir, name)));
    names
}

fn is_secret_env_name(name: &str) -> bool {
    SECRET_ENV_SUFFIXES
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

fn host_entry(id: String, name: String, kind: SecretKind) -> SecretEntry {
    SecretEntry {
        id,
        name,
        source: SecretSource::Host,
        kind,
        editable: false,
    }
}

pub struct SecretService {
    deps: SecretServiceDeps,
    until_restart: Mutex<HashMap<String, HashSet<String>>>,
}

impl SecretService {
    pub fn new(deps: SecretServiceDeps) -> Self {
        Self {
            deps,
            until_restart: Mutex::new(HashMap::new()),
        }
    }

    pub fn list(&self, workspace_id: &str) -> Vec<SecretEntry> {
        let home = (self.deps.home)();
        let env = (self.deps.env)();
        let mut out: Vec<SecretEntry> = ssh_keys(&home)
            .into_iter()
            .map(|name| host_entry(format!("host:ssh:{name}"), name, SecretKind::SshKey))
            .collect();
        let mut names: Vec<&String> = env.keys().collect();
        names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for name in names {
            if is_secret_env_name(name) && !env[name].is_empty() {
                out.push(host_entry(
                    format!("host:env:{name}"),
                    name.clone(),
                    SecretKind::Env,
                ));
            }
        }
        if (self.deps.gh_token)().is_some() {
            out.push(host_entry(
                GH_ID.to_owned(),
                GH_NAME.to_owned(),
                SecretKind::GhToken,
            ));
        }
        for VaultKey { key, scope } in (self.deps.vault_list)(workspace_id) {
            out.push(SecretEntry {
                id: format!("ostia:{}:{key}", scope.word()),
                name: key,
                source: SecretSource::Ostia,
                kind: SecretKind::Vault,
                editable: true,
            });
        }
        out
    }

    pub fn value(&self, workspace_id: &str, id: &str) -> Option<String> {
        let mut parts = id.splitn(3, ':');
        let source = parts.next().unwrap_or("");
        let kind = parts.next().unwrap_or("");
        let tail = parts.next().unwrap_or("");
        match (source, kind) {
            ("host", "ssh") => {
                let dir = (self.deps.home)().join(SSH_DIR);
                let bytes = fs::read(node_path::join(&dir, tail)).ok()?;
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            ("host", "env") => (self.deps.env)().remove(tail),
            ("host", "gh") => (self.deps.gh_token)(),
            ("ostia", scope) => {
                let scope = VaultScope::parse(scope)?;
                (self.deps.vault_get)(tail, scope, workspace_id)
            }
            _ => None,
        }
    }

    pub async fn get(
        &self,
        workspace_id: &str,
        pane_id: &str,
        name: &str,
        reason: &str,
    ) -> Result<String, SecretGetError> {
        let mut matches = self.list(workspace_id);
        matches.retain(|secret| secret.name == name || secret.id == name);
        let secret = match matches.as_slice() {
            [] => return Err(SecretGetError::UnknownSecret),
            [only] => only,
            _ => return Err(SecretGetError::Ambiguous),
        };
        if !self.is_trusted(workspace_id, &secret.id) {
            let outcome = (self.deps.ask)(SecretAsk {
                workspace_id: workspace_id.to_owned(),
                pane_id: pane_id.to_owned(),
                name: secret.name.clone(),
                reason: reason.to_owned(),
            })
            .await;
            match outcome {
                ApprovalOutcome::Answer(ApprovalAnswer::Once) => {}
                ApprovalOutcome::Answer(ApprovalAnswer::Session) => {
                    self.until_restart
                        .lock()
                        .entry(workspace_id.to_owned())
                        .or_default()
                        .insert(secret.id.clone());
                }
                _ => return Err(SecretGetError::Denied),
            }
        }
        self.value(workspace_id, &secret.id)
            .ok_or(SecretGetError::Missing)
    }

    pub fn forget(&self, workspace_id: &str) {
        self.until_restart.lock().remove(workspace_id);
    }

    fn is_trusted(&self, workspace_id: &str, id: &str) -> bool {
        (self.deps.granted_ids)(workspace_id)
            .iter()
            .any(|granted| granted == id)
            || self
                .until_restart
                .lock()
                .get(workspace_id)
                .is_some_and(|set| set.contains(id))
    }
}
