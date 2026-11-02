#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use ostia_contract::redaction::{RedactionKindInfo, SecretSpan};
use ostia_privacy::redaction::Redactor;
use ostia_privacy::redaction_scan::{
    ScanError, SecretScan, WorkerScan, redaction_worker_script, scan_deadline,
};
use serde_json::{Value, json};

pub const MIB: usize = 1024 * 1024;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn fixture_script(name: &str) -> PathBuf {
    repo_root().join("test/fixtures/rust").join(name)
}

pub fn real_worker_script() -> PathBuf {
    redaction_worker_script(&repo_root())
}

pub fn real_worker() -> WorkerScan {
    WorkerScan::new(real_worker_script(), scan_deadline)
}

pub fn on() -> Redactor<WorkerScan> {
    Redactor::new(|| Value::Null, real_worker())
}

pub fn off() -> Redactor<WorkerScan> {
    Redactor::new(|| json!({"redaction": {"enabled": false}}), real_worker())
}

pub fn join(parts: &[&str]) -> String {
    parts.concat()
}

pub fn fill(seed: &str, length: usize) -> String {
    seed.repeat(length.div_ceil(seed.len()))[..length].to_owned()
}

pub fn span(start: usize, end: usize, kind: &str) -> SecretSpan {
    SecretSpan {
        start,
        end,
        kind: kind.to_owned(),
    }
}

#[derive(Clone, Default)]
pub struct Counting {
    pub seen: Arc<Mutex<Vec<String>>>,
}

impl SecretScan for Counting {
    async fn scan(&self, text: &str) -> Result<Vec<SecretSpan>, ScanError> {
        self.seen.lock().unwrap().push(text.to_owned());
        Ok(Vec::new())
    }

    async fn library_kinds(&self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        Ok(Vec::new())
    }
}

pub struct Failing;

impl SecretScan for Failing {
    async fn scan(&self, _text: &str) -> Result<Vec<SecretSpan>, ScanError> {
        Err(ScanError::Failed("scan failed".to_owned()))
    }

    async fn library_kinds(&self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        Ok(Vec::new())
    }
}

pub struct Fake {
    pub aws_access_key_id: String,
    pub aws_secret_key: String,
    pub github_classic: String,
    pub github_fine_grained: String,
    pub gitlab: String,
    pub slack_bot: String,
    pub openai_legacy: String,
    pub openai_project: String,
    pub anthropic: String,
    pub stripe_live: String,
    pub stripe_restricted: String,
    pub google_api_key: String,
    pub npm: String,
    pub jwt: String,
    pub private_key: String,
    pub bearer: String,
    pub basic_auth_url: String,
    pub postgres_url: String,
}

pub static FAKE: LazyLock<Fake> = LazyLock::new(|| Fake {
    aws_access_key_id: join(&["AKIA", "Q3EGUAAAA7BCDEFG"]),
    aws_secret_key: join(&["wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYzQ9Lm2pKEY"]),
    github_classic: join(&["ghp_", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"]),
    github_fine_grained: format!(
        "{}{}",
        "github_pat_",
        fill("11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789", 82)
    ),
    gitlab: join(&["glpat-", "A1b2C3d4E5f6G7h8I9j0"]),
    slack_bot: join(&[
        "xoxb-",
        "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    ]),
    openai_legacy: format!(
        "sk-{}T3BlbkFJ{}",
        fill("abcdefghijklmnopqrst", 20),
        fill("ABCDEFGHIJKLMNOPQRST", 20)
    ),
    openai_project: format!(
        "sk-proj-{}T3BlbkFJ{}",
        fill("aB3dE5gH7jK9mN1pQ", 58),
        fill("zY8xW6vU4tS2rQ0pO", 58)
    ),
    anthropic: format!("sk-ant-api03-{}AA", fill("aB3dE5gH7jK9mN1pQ_-", 93)),
    stripe_live: join(&["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"]),
    stripe_restricted: join(&["rk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"]),
    google_api_key: join(&["AIza", "SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"]),
    npm: join(&["npm_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"]),
    jwt: [
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        ".",
        "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
        ".",
        "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ]
    .concat(),
    private_key: [
        join(&["-----BEGIN RSA ", "PRIVATE KEY-----"]),
        "MIIEpAIBAAKCAQEA04up8hoqzS1+APIB0RhjXyObwHQnOzhAk5Bd7mhkSbPkyhP1",
        "iGq7ybRXrXn0jc5cJ4ZxG2zB4tQ9mM8LbK8Y7Wr1q1Wd8u3n0d2tZ2v8H8a1M0Zk",
        join(&["-----END RSA ", "PRIVATE KEY-----"]),
    ]
    .join("\n"),
    bearer: "abcdef1234567890abcdef1234567890".to_owned(),
    basic_auth_url: join(&["https://alice:", "s3cr3tPass", "@example.com"]),
    postgres_url: join(&["postgres://app:", "hunter2pw", "@db.internal:5432/app"]),
});

pub struct Harmless {
    pub git_sha: &'static str,
    pub sha256: &'static str,
    pub uuid: &'static str,
    pub long_path: &'static str,
    pub base64: String,
    pub prose: &'static str,
}

pub static HARMLESS: LazyLock<Harmless> = LazyLock::new(|| Harmless {
    git_sha: "3f786850e387550fdab836ed7e6dc881de23001b",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    uuid: "550e8400-e29b-41d4-a716-446655440000",
    long_path: "/home/user/projects/acme/services/billing/src/handlers/invoices/createInvoiceHandler.ts",
    base64: fill(
        "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk",
        600,
    ),
    prose: "Enter your password, then paste the token. The secret is never shown.",
});
