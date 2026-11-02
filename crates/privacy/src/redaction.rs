use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use ostia_base::js::utf16_len;
use ostia_contract::redaction::{
    REDACT_TEXT_MAX, REDACT_TEXTS_MAX, RedactionKindInfo, RedactionKindSource, RedactionResult,
    RedactionSettings, apply_redactions, compile_patterns, custom_spans, extra_kinds, extra_spans,
    parse_redaction_settings, unchanged,
};
use serde_json::Value;

use crate::redaction_scan::{ScanError, SecretScan};

pub struct Redactor<S> {
    read_privacy: Arc<dyn Fn() -> Value + Send + Sync>,
    scan: S,
}

impl<S: SecretScan> Redactor<S> {
    pub fn new(read_privacy: impl Fn() -> Value + Send + Sync + 'static, scan: S) -> Self {
        Self {
            read_privacy: Arc::new(read_privacy),
            scan,
        }
    }

    fn settings(&self) -> RedactionSettings {
        let privacy = (self.read_privacy)();
        parse_redaction_settings(privacy.get("redaction").unwrap_or(&Value::Null))
    }

    pub fn enabled(&self) -> bool {
        self.settings().enabled
    }

    pub fn settings_key(&self) -> String {
        serde_json::to_string(&self.settings()).unwrap_or_default()
    }

    pub async fn kinds(&self) -> Result<Vec<RedactionKindInfo>, ScanError> {
        let mut kinds = self.scan.library_kinds().await?;
        kinds.extend(extra_kinds().into_iter().map(|kind| RedactionKindInfo {
            kind: kind.to_owned(),
            source: RedactionKindSource::Ostia,
            detects: Vec::new(),
        }));
        Ok(kinds)
    }

    async fn detect(&self, text: &str, patterns: &[String]) -> Result<RedactionResult, ScanError> {
        if text.is_empty() {
            return Ok(unchanged(text));
        }
        let mut spans = self.scan.scan(text).await?;
        let owned = text.to_owned();
        let patterns = patterns.to_vec();
        let local = tokio::task::spawn_blocking(move || {
            let mut found = extra_spans(&owned);
            found.extend(custom_spans(&owned, &compile_patterns(&patterns)));
            found
        })
        .await
        .map_err(|_| ScanError::failed())?;
        spans.extend(local);
        Ok(apply_redactions(text, &spans))
    }

    pub async fn redact(&self, text: &str) -> Result<RedactionResult, ScanError> {
        let current = self.settings();
        if current.enabled {
            self.detect(text, &current.patterns).await
        } else {
            Ok(unchanged(text))
        }
    }

    pub async fn preview(&self, text: &str) -> Result<RedactionResult, ScanError> {
        self.detect(text, &self.settings().patterns).await
    }

    pub async fn text(&self, text: &str) -> Result<String, ScanError> {
        Ok(self.redact(text).await?.text)
    }
}

pub async fn redact_requested_texts<S: SecretScan>(
    redactor: &Redactor<S>,
    raw: &Value,
) -> Option<Result<Vec<RedactionResult>, ScanError>> {
    let items = raw
        .as_array()
        .filter(|items| items.len() <= REDACT_TEXTS_MAX)?;
    let mut texts: Vec<&str> = Vec::with_capacity(items.len());
    let mut total = 0;
    for item in items {
        let text = item.as_str()?;
        total += utf16_len(text);
        texts.push(text);
    }
    if total > REDACT_TEXT_MAX {
        return None;
    }
    let mut results = Vec::with_capacity(texts.len());
    for text in texts {
        match redactor.redact(text).await {
            Ok(result) => results.push(result),
            Err(error) => return Some(Err(error)),
        }
    }
    Some(Ok(results))
}

pub struct ScrollbackRedactor<S> {
    redactor: Redactor<S>,
    seen: HashMap<String, (String, String)>,
    seen_with: String,
}

impl<S: SecretScan> ScrollbackRedactor<S> {
    pub fn new(redactor: Redactor<S>) -> Self {
        Self {
            redactor,
            seen: HashMap::new(),
            seen_with: String::new(),
        }
    }

    pub async fn redact(
        &mut self,
        by_pane: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, ScanError> {
        let key = self.redactor.settings_key();
        if key != self.seen_with {
            self.seen.clear();
        }
        self.seen_with = key;
        let mut out = BTreeMap::new();
        for (pane_id, raw) in by_pane {
            let redacted = match self.seen.get(pane_id) {
                Some((known_raw, known_redacted)) if known_raw == raw => known_redacted.clone(),
                _ => self.redactor.text(raw).await?,
            };
            self.seen
                .insert(pane_id.clone(), (raw.clone(), redacted.clone()));
            out.insert(pane_id.clone(), redacted);
        }
        self.seen.retain(|pane_id, _| by_pane.contains_key(pane_id));
        Ok(out)
    }
}
