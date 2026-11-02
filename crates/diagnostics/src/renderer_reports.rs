use std::collections::{HashMap, HashSet};

use ostia_base::PaneId;
use ostia_base::clock::Clock;
use ostia_base::js::utf16_len;
use parking_lot::Mutex;
use serde_json::Value;

use crate::text_clip::clip_printable;

pub const REPORT_MESSAGE_MAX: usize = 1000;
pub const REPORT_STACK_MAX: usize = 8000;
pub const REPORT_PANE_IDS_MAX: usize = 2000;
pub const REPORTS_PER_WINDOW: usize = 20;
pub const REPORT_WINDOW_MS: i64 = 60_000;
const REPORT_SOURCE_MAX: usize = 200;
const PANE_ID_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererErrorKind {
    Error,
    Rejection,
    Render,
    Surface,
}

impl RendererErrorKind {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "error" => Some(Self::Error),
            "rejection" => Some(Self::Rejection),
            "render" => Some(Self::Render),
            "surface" => Some(Self::Surface),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Rejection => "rejection",
            Self::Render => "render",
            Self::Surface => "surface",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RendererErrorReport {
    pub kind: RendererErrorKind,
    pub message: String,
    pub stack: Option<String>,
    pub source: Option<String>,
}

fn clipped(value: Option<&Value>, max: usize) -> Option<String> {
    Some(clip_printable(value?.as_str()?, max))
}

pub fn normalize_renderer_report(raw: &Value) -> Option<RendererErrorReport> {
    let object = raw.as_object()?;
    let kind = object
        .get("kind")
        .and_then(Value::as_str)
        .and_then(RendererErrorKind::parse);
    let message = clipped(object.get("message"), REPORT_MESSAGE_MAX);
    let (Some(kind), Some(message)) = (kind, message) else {
        return None;
    };
    let stack = clipped(object.get("stack"), REPORT_STACK_MAX).filter(|text| !text.is_empty());
    let source = clipped(object.get("source"), REPORT_SOURCE_MAX).filter(|text| !text.is_empty());
    Some(RendererErrorReport {
        kind,
        message: if message.is_empty() {
            "(no message)".to_owned()
        } else {
            message
        },
        stack,
        source,
    })
}

pub fn normalize_pane_ids(raw: &Value) -> Option<HashSet<PaneId>> {
    let items = raw.as_array()?;
    if items.len() > REPORT_PANE_IDS_MAX {
        return None;
    }
    let mut ids = HashSet::new();
    for item in items {
        let id = item.as_str()?;
        if id.is_empty() || utf16_len(id) > PANE_ID_MAX {
            return None;
        }
        ids.insert(PaneId::new(id));
    }
    Some(ids)
}

struct Bucket {
    start: i64,
    count: usize,
    suppressed: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Take {
    pub allowed: bool,
    pub suppressed: u64,
}

pub struct ReportLimiter {
    limit: usize,
    window_ms: i64,
    now: Clock,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl ReportLimiter {
    pub fn new(limit: usize, window_ms: i64, now: Clock) -> Self {
        Self {
            limit,
            window_ms,
            now,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn take(&self, key: &str) -> Take {
        let now = (self.now)();
        let mut buckets = self.buckets.lock();
        let mut suppressed = 0;
        let expired = buckets
            .get(key)
            .is_none_or(|bucket| now - bucket.start >= self.window_ms);
        if expired {
            suppressed = buckets.get(key).map_or(0, |bucket| bucket.suppressed);
            buckets.insert(
                key.to_owned(),
                Bucket {
                    start: now,
                    count: 0,
                    suppressed: 0,
                },
            );
        }
        let Some(bucket) = buckets.get_mut(key) else {
            return Take {
                allowed: false,
                suppressed: 0,
            };
        };
        if bucket.count >= self.limit {
            bucket.suppressed += 1;
            return Take {
                allowed: false,
                suppressed: 0,
            };
        }
        bucket.count += 1;
        Take {
            allowed: true,
            suppressed,
        }
    }

    pub fn forget(&self, key: &str) {
        self.buckets.lock().remove(key);
    }
}
