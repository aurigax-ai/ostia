use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ostia_base::clock::{Clock, system_clock};
use ostia_base::random::random_bytes;
use ostia_base::{EventHub, Host};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::iso_time::iso_millis;

const CODE_TTL_MS: i64 = 120_000;
const EXPIRY_TIMER_MS: u64 = 120_001;
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH: usize = 8;
const PAIR_RATE_LIMIT_WINDOW_MS: i64 = 60_000;
const PAIR_RATE_LIMIT_MAX: usize = 5;

pub fn format_code(code: &str) -> String {
    let head: String = code.chars().take(4).collect();
    let tail: String = code.chars().skip(4).collect();
    format!("{head}-{tail}")
}

#[derive(Clone)]
pub struct PairCodes {
    now: Clock,
    codes: Arc<Mutex<HashMap<String, i64>>>,
    changed: EventHub<()>,
}

impl Default for PairCodes {
    fn default() -> Self {
        Self::new()
    }
}

impl PairCodes {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(now: Clock) -> Self {
        Self {
            now,
            codes: Arc::new(Mutex::new(HashMap::new())),
            changed: EventHub::default(),
        }
    }

    pub fn subscribe(&self) -> UnboundedReceiver<()> {
        self.changed.subscribe()
    }

    fn sweep_expired(&self, codes: &mut HashMap<String, i64>) {
        let now = (self.now)();
        codes.retain(|_, expiry| *expiry >= now);
    }

    pub fn live_code_count(&self) -> usize {
        let mut codes = self.codes.lock();
        self.sweep_expired(&mut codes);
        codes.len()
    }

    pub fn new_code(&self) -> String {
        let code: String = random_bytes::<CODE_LENGTH>()
            .iter()
            .map(|byte| char::from(CODE_ALPHABET[usize::from(*byte) % CODE_ALPHABET.len()]))
            .collect();
        {
            let mut codes = self.codes.lock();
            self.sweep_expired(&mut codes);
            codes.insert(code.clone(), (self.now)() + CODE_TTL_MS);
        }
        let expiry = tokio::time::sleep(Duration::from_millis(EXPIRY_TIMER_MS));
        let changed = self.changed.clone();
        tokio::spawn(async move {
            expiry.await;
            changed.emit(());
        });
        self.changed.emit(());
        code
    }

    pub fn is_live_code(&self, code: &str) -> bool {
        self.codes
            .lock()
            .get(code)
            .is_some_and(|expiry| (self.now)() <= *expiry)
    }

    pub fn consume_code(&self, code: &str) -> bool {
        let expiry = self.codes.lock().remove(code);
        if expiry.is_some() {
            self.changed.emit(());
        }
        expiry.is_some_and(|expiry| (self.now)() <= expiry)
    }

    pub fn reset(&self) {
        self.codes.lock().clear();
    }
}

#[derive(Clone)]
pub struct PairRateLimit {
    now: Clock,
    attempts: Arc<Mutex<HashMap<String, Vec<i64>>>>,
}

impl Default for PairRateLimit {
    fn default() -> Self {
        Self::new()
    }
}

impl PairRateLimit {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    pub fn with_clock(now: Clock) -> Self {
        Self {
            now,
            attempts: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn check(&self, ip: &str) -> bool {
        let now = (self.now)();
        let mut attempts = self.attempts.lock();
        let recent = attempts.entry(ip.to_owned()).or_default();
        recent.retain(|at| now - *at < PAIR_RATE_LIMIT_WINDOW_MS);
        recent.push(now);
        recent.len() <= PAIR_RATE_LIMIT_MAX
    }

    pub fn reset(&self) {
        self.attempts.lock().clear();
    }
}

pub fn pair_audit_log_path(host: &Host) -> PathBuf {
    host.app_data_dir().join("gateway-pair-audit.log")
}

fn is_local_peer(ip: &str) -> bool {
    ip.starts_with("127.") || ip.starts_with("::ffff:127.") || ip == "::1"
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PairOutcome {
    Ok,
    InvalidCode,
    BadRequest,
    RateLimited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PairVia {
    Relay,
}

#[derive(Serialize)]
struct AuditLine<'a> {
    ts: String,
    ip: &'a str,
    outcome: PairOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    via: Option<&'static str>,
}

#[derive(Clone)]
pub struct PairAudit {
    path: Arc<PathBuf>,
    now: Clock,
}

fn append_line(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(line.as_bytes())
}

impl PairAudit {
    pub fn new(path: PathBuf) -> Self {
        Self::with_clock(path, system_clock())
    }

    pub fn with_clock(path: PathBuf, now: Clock) -> Self {
        Self {
            path: Arc::new(path),
            now,
        }
    }

    pub fn record(&self, ip: &str, outcome: PairOutcome, via: Option<PairVia>) {
        let via = match via {
            Some(PairVia::Relay) => Some("relay"),
            None => is_local_peer(ip).then_some("this-computer"),
        };
        let line = AuditLine {
            ts: iso_millis((self.now)()),
            ip,
            outcome,
            via,
        };
        let Ok(mut text) = serde_json::to_string(&line) else {
            return;
        };
        text.push('\n');
        let _ = append_line(&self.path, &text);
    }
}
