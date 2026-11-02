use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ostia_base::js::utf16_len;
use ostia_contract::redaction::{RedactionKindInfo, RedactionKindSource, SecretSpan};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, watch};

use crate::secret_scanner::{LintMessage, chunk_ranges, kind_of_rule, spans_of};

const SCAN_BASE_MS: u64 = 2000;
const SCAN_PER_MIB_MS: f64 = 6000.0;
const SCAN_MAX_MS: u64 = 20_000;
const MIB: f64 = 1024.0 * 1024.0;
const WORKER_RELATIVE: &str = "out/redaction-lint/worker.js";
const WORKER_BUILD_STEP: &str = "pnpm run build:redaction-lint-worker";
const UNPACKED_SUFFIX: &str = ".asar.unpacked";
const PACKED_SUFFIX: &str = ".asar";

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ScanError {
    #[error("{0}")]
    Failed(String),
    #[error("scan timed out")]
    TimedOut,
    #[error("scan closed")]
    Closed,
    #[error("scan worker exited")]
    WorkerExited,
}

impl ScanError {
    pub fn failed() -> Self {
        Self::Failed("scan failed".to_owned())
    }
}

pub trait SecretScan {
    fn deadline(&self, length: usize) -> Duration {
        scan_deadline(length)
    }

    fn scan(&self, text: &str) -> impl Future<Output = Result<Vec<SecretSpan>, ScanError>> + Send;

    fn library_kinds(
        &self,
    ) -> impl Future<Output = Result<Vec<RedactionKindInfo>, ScanError>> + Send;
}

pub fn redaction_worker_script(app_path: &Path) -> PathBuf {
    let text = app_path.to_string_lossy();
    let base = match text.strip_suffix(PACKED_SUFFIX) {
        Some(stem) => format!("{stem}{UNPACKED_SUFFIX}"),
        None => text.into_owned(),
    };
    PathBuf::from(base).join(WORKER_RELATIVE)
}

pub fn scan_deadline(length: usize) -> Duration {
    let per_mib = ((length as f64 / MIB) * SCAN_PER_MIB_MS).ceil() as u64;
    Duration::from_millis(SCAN_MAX_MS.min(SCAN_BASE_MS + per_mib))
}

struct Worker {
    _child: Child,
    stdin: ChildStdin,
    replies: Lines<BufReader<ChildStdout>>,
    next_id: u64,
}

impl Worker {
    fn spawn(node: &Path, script: &Path) -> Result<Self, ScanError> {
        if !node.is_absolute() {
            return Err(ScanError::Failed(
                "scan runtime path is not absolute".to_owned(),
            ));
        }
        if !node.is_file() {
            return Err(ScanError::Failed("scan runtime is missing".to_owned()));
        }
        if !script.is_file() {
            return Err(ScanError::Failed(format!(
                "scan worker is missing, run `{WORKER_BUILD_STEP}`"
            )));
        }
        let mut child = Command::new(node)
            .arg(script)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| ScanError::Failed(error.to_string()))?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(ScanError::Failed("scan worker failed".to_owned()));
        };
        Ok(Self {
            _child: child,
            stdin,
            replies: BufReader::new(stdout).lines(),
            next_id: 0,
        })
    }

    async fn request(&mut self, mut body: Value) -> Result<Value, ScanError> {
        let id = self.next_id;
        self.next_id += 1;
        body["id"] = json!(id);
        let mut line = body
            .to_string()
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|_| ScanError::WorkerExited)?;
        self.stdin
            .flush()
            .await
            .map_err(|_| ScanError::WorkerExited)?;
        loop {
            let Some(reply) = self
                .replies
                .next_line()
                .await
                .map_err(|_| ScanError::WorkerExited)?
            else {
                return Err(ScanError::WorkerExited);
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&reply) else {
                continue;
            };
            if parsed.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(parsed);
            }
        }
    }

    async fn scan(&mut self, text: &str) -> Result<Vec<SecretSpan>, ScanError> {
        let mut spans = Vec::new();
        for (start, end) in chunk_ranges(text) {
            let content = &text[start..end];
            let reply = self.request(json!({"content": content})).await?;
            for message in lint_messages(content, &reply)? {
                spans.extend(spans_of(content, &message, start));
            }
        }
        Ok(spans)
    }

    async fn library_kinds(&mut self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        let reply = self.request(json!({"kinds": true})).await?;
        let Some(rules) = reply.get("rules").and_then(Value::as_array) else {
            return Err(reply_failure(&reply));
        };
        let mut kinds = Vec::new();
        for rule in rules {
            let rule_id = rule
                .get("ruleId")
                .and_then(Value::as_str)
                .ok_or_else(ScanError::failed)?;
            let detects = rule
                .get("messages")
                .and_then(Value::as_array)
                .ok_or_else(ScanError::failed)?
                .iter()
                .map(|name| {
                    name.as_str()
                        .map(str::to_owned)
                        .ok_or_else(ScanError::failed)
                })
                .collect::<Result<Vec<_>, _>>()?;
            kinds.push(RedactionKindInfo {
                kind: kind_of_rule(rule_id),
                source: RedactionKindSource::Library,
                detects,
            });
        }
        Ok(kinds)
    }
}

fn reply_failure(reply: &Value) -> ScanError {
    match reply.get("error").and_then(Value::as_str) {
        Some(error) => ScanError::Failed(error.to_owned()),
        None => ScanError::failed(),
    }
}

fn unit_offsets(content: &str) -> Option<Vec<usize>> {
    if content.is_ascii() {
        return None;
    }
    let mut offsets = Vec::with_capacity(content.len() + 1);
    for (offset, ch) in content.char_indices() {
        offsets.extend(std::iter::repeat_n(offset, ch.len_utf16()));
    }
    offsets.push(content.len());
    Some(offsets)
}

fn lint_messages(content: &str, reply: &Value) -> Result<Vec<LintMessage>, ScanError> {
    let Some(messages) = reply.get("messages").and_then(Value::as_array) else {
        return Err(reply_failure(reply));
    };
    let offsets = unit_offsets(content);
    let to_byte = |unit: u64| -> usize {
        let unit = usize::try_from(unit).unwrap_or(usize::MAX);
        match &offsets {
            None => unit.min(content.len()),
            Some(table) => table.get(unit).copied().unwrap_or(content.len()),
        }
    };
    messages
        .iter()
        .map(|message| {
            let rule_id = message
                .get("ruleId")
                .and_then(Value::as_str)
                .ok_or_else(ScanError::failed)?;
            let range = message
                .get("range")
                .and_then(Value::as_array)
                .ok_or_else(ScanError::failed)?;
            let (Some(start), Some(end)) = (
                range.first().and_then(Value::as_u64),
                range.get(1).and_then(Value::as_u64),
            ) else {
                return Err(ScanError::failed());
            };
            Ok(LintMessage {
                rule_id: rule_id.to_owned(),
                range: (to_byte(start), to_byte(end)),
                data: message.get("data").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

struct Inner {
    node: PathBuf,
    script: PathBuf,
    deadline: Box<dyn Fn(usize) -> Duration + Send + Sync>,
    slot: Mutex<Option<Worker>>,
    closed: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct WorkerScan {
    inner: Arc<Inner>,
}

impl WorkerScan {
    pub fn new(
        node: impl Into<PathBuf>,
        script: impl Into<PathBuf>,
        deadline: impl Fn(usize) -> Duration + Send + Sync + 'static,
    ) -> Self {
        let (closed, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner {
                node: node.into(),
                script: script.into(),
                deadline: Box::new(deadline),
                slot: Mutex::new(None),
                closed,
            }),
        }
    }

    pub async fn close(&self) {
        self.inner.closed.send_replace(true);
        let dead = self.inner.slot.lock().await.take();
        drop(dead);
    }

    async fn serialized<T, F, Fut>(&self, length: usize, work: F) -> Result<T, ScanError>
    where
        F: FnOnce(Worker) -> Fut,
        Fut: Future<Output = (Worker, Result<T, ScanError>)>,
    {
        let mut closed = self.inner.closed.subscribe();
        if *closed.borrow() {
            return Err(ScanError::Closed);
        }
        let run = async {
            let mut slot = self.inner.slot.lock().await;
            let worker = match slot.take() {
                Some(worker) => worker,
                None => Worker::spawn(&self.inner.node, &self.inner.script)?,
            };
            let deadline = (self.inner.deadline)(length);
            match tokio::time::timeout(deadline, work(worker)).await {
                Err(_) => Err(ScanError::TimedOut),
                Ok((worker, result)) => {
                    if matches!(&result, Ok(_) | Err(ScanError::Failed(_))) {
                        *slot = Some(worker);
                    }
                    result
                }
            }
        };
        tokio::select! {
            biased;
            _ = closed.changed() => Err(ScanError::Closed),
            result = run => result,
        }
    }
}

impl SecretScan for WorkerScan {
    fn deadline(&self, length: usize) -> Duration {
        (self.inner.deadline)(length)
    }

    async fn scan(&self, text: &str) -> Result<Vec<SecretSpan>, ScanError> {
        let owned = text.to_owned();
        self.serialized(utf16_len(text), move |mut worker| async move {
            let result = worker.scan(&owned).await;
            (worker, result)
        })
        .await
    }

    async fn library_kinds(&self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        self.serialized(0, |mut worker| async move {
            let result = worker.library_kinds().await;
            (worker, result)
        })
        .await
    }
}
