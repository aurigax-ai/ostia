#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use ostia_diagnostics::privacy_telemetry::{
    ErrorInput, ErrorSource, InstallContext, TELEMETRY_CATEGORIES, TelemetryCategory,
    TelemetryEndpoint, TelemetrySettings,
};
use ostia_diagnostics::telemetry::{Telemetry, TelemetryDeps};
use ostia_diagnostics::telemetry_queue::{PostRequest, PostTransport};
use ostia_diagnostics::telemetry_usage::SessionFacts;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tempfile::TempDir;

pub const FAR: Duration = Duration::from_secs(3600);

pub fn context() -> InstallContext {
    InstallContext {
        app_version: "1.0.0".to_owned(),
        electron_version: "33".to_owned(),
        os_name: "linux".to_owned(),
        os_version: "6".to_owned(),
        arch: "x64".to_owned(),
        locale: "en".to_owned(),
        channel: "source".to_owned(),
    }
}

pub fn endpoint() -> TelemetryEndpoint {
    TelemetryEndpoint {
        url: "https://us.i.posthog.com/batch/".to_owned(),
        api_key: "phc_test".to_owned(),
    }
}

pub fn facts() -> SessionFacts {
    SessionFacts {
        windows: "1".to_owned(),
        workspaces: "2-3".to_owned(),
        restore: "ok".to_owned(),
        in_effect: vec![
            (
                "features".to_owned(),
                vec![
                    ("input_mode".to_owned(), "terminal".to_owned()),
                    ("prompt_style".to_owned(), "shell".to_owned()),
                ],
            ),
            (
                "terminal".to_owned(),
                vec![("gpu".to_owned(), "on".to_owned())],
            ),
        ],
        installed_extensions: vec!["trellis".to_owned()],
        enabled_extensions: vec!["trellis".to_owned()],
    }
}

pub fn only(on: &[TelemetryCategory]) -> TelemetrySettings {
    let mut settings = TelemetrySettings::default();
    for category in on {
        settings.set(*category, true);
    }
    settings
}

pub fn all_categories() -> Vec<TelemetryCategory> {
    TELEMETRY_CATEGORIES.to_vec()
}

pub fn boom() -> ErrorInput {
    ErrorInput {
        source: ErrorSource::MainException,
        name: "Error".to_owned(),
        message: "boom".to_owned(),
        stack: None,
        extension: None,
    }
}

pub fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("expected an object, got {other}"),
    }
}

pub struct Sent {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub struct FakeTransport {
    pub sent: Arc<Mutex<Vec<Sent>>>,
    pub status: Arc<Mutex<Option<u16>>>,
}

impl PostTransport for FakeTransport {
    fn post(&self, request: PostRequest) -> BoxFuture<'_, Option<u16>> {
        self.sent.lock().push(Sent {
            url: request.url,
            headers: request.headers,
            body: request.body,
        });
        let status = *self.status.lock();
        Box::pin(async move { status })
    }
}

pub struct Harness {
    pub dir: TempDir,
    pub file: PathBuf,
    pub settings: Arc<Mutex<TelemetrySettings>>,
    pub sent: Arc<Mutex<Vec<Sent>>>,
    pub status: Arc<Mutex<Option<u16>>>,
}

impl Harness {
    pub fn new(settings: TelemetrySettings) -> Self {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("telemetry.json");
        Self {
            dir,
            file,
            settings: Arc::new(Mutex::new(settings)),
            sent: Arc::new(Mutex::new(Vec::new())),
            status: Arc::new(Mutex::new(Some(200))),
        }
    }

    pub fn set_settings(&self, settings: TelemetrySettings) {
        *self.settings.lock() = settings;
    }

    pub fn respond_with(&self, status: Option<u16>) {
        *self.status.lock() = status;
    }

    pub fn sent_count(&self) -> usize {
        self.sent.lock().len()
    }

    pub fn deps(&self) -> TelemetryDeps {
        let settings = self.settings.clone();
        let mut deps = TelemetryDeps::new(
            self.file.clone(),
            Some(endpoint()),
            Arc::new(context),
            Arc::new(move || settings.lock().clone()),
            Arc::new(facts),
        );
        deps.transport = Arc::new(FakeTransport {
            sent: self.sent.clone(),
            status: self.status.clone(),
        });
        deps.flush_delay = FAR;
        deps.retry_delay = FAR;
        deps
    }

    pub fn create(&self) -> Telemetry {
        Telemetry::new(self.deps())
    }

    pub fn create_with(&self, tweak: impl FnOnce(&mut TelemetryDeps)) -> Telemetry {
        let mut deps = self.deps();
        tweak(&mut deps);
        Telemetry::new(deps)
    }

    pub fn file_json(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.file).unwrap()).unwrap()
    }
}

pub fn batch_events(body: &str) -> Vec<Value> {
    let parsed: Value = serde_json::from_str(body).unwrap();
    parsed["batch"].as_array().unwrap().clone()
}

pub fn text_event(event: &Value) -> String {
    event["event"].as_str().unwrap().to_owned()
}

pub fn properties(report: &Value) -> &Map<String, Value> {
    report["properties"].as_object().unwrap()
}

pub fn has_prefix(report: &Value, prefix: &str) -> bool {
    properties(report).keys().any(|key| key.starts_with(prefix))
}

pub fn exception_value(report: &Value) -> &str {
    report["properties"]["$exception_list"][0]["value"]
        .as_str()
        .unwrap()
}

pub async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

fn fill(seed: &str, length: usize) -> String {
    seed.repeat(length.div_ceil(seed.len()))[..length].to_owned()
}

pub fn fake_secrets() -> Vec<(&'static str, String)> {
    vec![
        ("awsAccessKeyId", ["AKIA", "Q3EGUAAAA7BCDEFG"].concat()),
        (
            "awsSecretKey",
            ["wJalrXUtnFEMI/K7MDENG", "/bPxRfiCYzQ9Lm2pKEY"].concat(),
        ),
        (
            "githubClassic",
            ["ghp_", "wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"].concat(),
        ),
        (
            "githubFineGrained",
            [
                "github_pat_",
                &fill("11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789", 82),
            ]
            .concat(),
        ),
        ("gitlab", ["glpat-", "A1b2C3d4E5f6G7h8I9j0"].concat()),
        (
            "slackBot",
            [
                "xoxb-",
                "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
            ]
            .concat(),
        ),
        (
            "openaiLegacy",
            [
                "sk-",
                &fill("abcdefghijklmnopqrst", 20),
                "T3BlbkFJ",
                &fill("ABCDEFGHIJKLMNOPQRST", 20),
            ]
            .concat(),
        ),
        (
            "openaiProject",
            [
                "sk-proj-",
                &fill("aB3dE5gH7jK9mN1pQ", 58),
                "T3BlbkFJ",
                &fill("zY8xW6vU4tS2rQ0pO", 58),
            ]
            .concat(),
        ),
        (
            "anthropic",
            ["sk-ant-api03-", &fill("aB3dE5gH7jK9mN1pQ_-", 93), "AA"].concat(),
        ),
        (
            "stripeLive",
            ["sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].concat(),
        ),
        (
            "stripeRestricted",
            ["rk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"].concat(),
        ),
        (
            "googleApiKey",
            ["AIza", "SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe"].concat(),
        ),
        (
            "npm",
            ["npm_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"].concat(),
        ),
        (
            "jwt",
            [
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
                ".",
                "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ",
                ".",
                "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            ]
            .concat(),
        ),
        (
            "privateKey",
            [
                ["-----BEGIN RSA ", "PRIVATE KEY-----"].concat(),
                "MIIEpAIBAAKCAQEA04up8hoqzS1+APIB0RhjXyObwHQnOzhAk5Bd7mhkSbPkyhP1".to_owned(),
                "iGq7ybRXrXn0jc5cJ4ZxG2zB4tQ9mM8LbK8Y7Wr1q1Wd8u3n0d2tZ2v8H8a1M0Zk".to_owned(),
                ["-----END RSA ", "PRIVATE KEY-----"].concat(),
            ]
            .join("\n"),
        ),
        ("bearer", "abcdef1234567890abcdef1234567890".to_owned()),
        (
            "basicAuthUrl",
            ["https://alice:", "s3cr3tPass", "@example.com"].concat(),
        ),
        (
            "postgresUrl",
            ["postgres://app:", "hunter2pw", "@db.internal:5432/app"].concat(),
        ),
    ]
}

pub fn fake(name: &str) -> String {
    fake_secrets()
        .into_iter()
        .find(|(known, _)| *known == name)
        .map(|(_, value)| value)
        .unwrap()
}

pub fn harmless_samples() -> Vec<String> {
    vec![
        "550e8400-e29b-41d4-a716-446655440000".to_owned(),
        "/home/user/projects/acme/services/billing/src/handlers/invoices/createInvoiceHandler.ts"
            .to_owned(),
        "Enter your password, then paste the token. The secret is never shown.".to_owned(),
    ]
}
