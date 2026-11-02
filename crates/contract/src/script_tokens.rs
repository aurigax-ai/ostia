use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Utc};
use ostia_base::js::static_regex;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::capabilities::Capability;

pub const SCRIPT_CAPABILITIES: [Capability; 8] = [
    Capability::ReadBoard,
    Capability::ReadOtherPane,
    Capability::TypeOtherPane,
    Capability::AllWorkspaces,
    Capability::Process,
    Capability::SendOtherPane,
    Capability::KillPane,
    Capability::Notify,
];

pub const SCRIPT_TOKEN_PREFIX: &str = "ostia_";

pub const POLKIT_ACTION: &str = "ai.aurigax.ostia.manage-script-tokens";
pub const POLKIT_POLICY_FILE: &str = "ai.aurigax.ostia.manage-script-tokens.policy";
pub const POLKIT_ACTIONS_DIR: &str = "/usr/share/polkit-1/actions";

pub const SCRIPT_TOKEN_UI_CAPS: [Capability; 7] = [
    Capability::ReadBoard,
    Capability::Notify,
    Capability::ReadOtherPane,
    Capability::SendOtherPane,
    Capability::KillPane,
    Capability::TypeOtherPane,
    Capability::Process,
];

pub const SCRIPT_TOKEN_RUN_CAPS: [Capability; 2] = [Capability::TypeOtherPane, Capability::Process];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScriptTokenPreset {
    Readonly,
    Coordinator,
}

pub const SCRIPT_TOKEN_PRESETS: [ScriptTokenPreset; 2] =
    [ScriptTokenPreset::Readonly, ScriptTokenPreset::Coordinator];

impl ScriptTokenPreset {
    pub fn caps(self) -> &'static [Capability] {
        match self {
            Self::Readonly => &[Capability::ReadBoard, Capability::ReadOtherPane],
            Self::Coordinator => &[
                Capability::ReadBoard,
                Capability::ReadOtherPane,
                Capability::SendOtherPane,
                Capability::TypeOtherPane,
                Capability::Process,
                Capability::Notify,
            ],
        }
    }
}

pub fn is_script_token_preset(raw: &Value) -> bool {
    matches!(raw.as_str(), Some("readonly" | "coordinator"))
}

pub const DEFAULT_TOKEN_EXPIRY: &str = "90d";
pub const NEVER_EXPIRES: &str = "never";

const DAY_MS: i64 = 86_400_000;

static RELATIVE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^([1-9][0-9]{0,3})([dy])$"));
static DATE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$"));

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScriptTokenScope {
    All,
    Limited {
        groups: Vec<String>,
        workspaces: Vec<String>,
        #[serde(rename = "ownWorkspaces")]
        own_workspaces: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptTokenSource {
    Settings,
    Cli,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTokenInfo {
    pub id: String,
    pub name: String,
    pub caps: Vec<Capability>,
    pub scope: ScriptTokenScope,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub source: ScriptTokenSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScriptTokenCallOutcome {
    Ok,
    OutOfScope,
    MissingPermission,
    Error,
    Regenerated,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTokenCallTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScriptTokenCall {
    pub at: String,
    pub method: String,
    pub target: ScriptTokenCallTarget,
    pub outcome: ScriptTokenCallOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn unreadable(raw: &str) -> String {
    format!("expires: {raw} (use 7d, 30d, 90d, 1y, YYYY-MM-DD or never)")
}

fn iso_string(at: DateTime<Utc>) -> String {
    let year = at.year();
    if (0..=9999).contains(&year) {
        return at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    }
    let sign = if year < 0 { '-' } else { '+' };
    format!(
        "{sign}{:06}-{}",
        year.abs(),
        at.format("%m-%dT%H:%M:%S%.3fZ")
    )
}

fn after_years(now_ms: i64, years: i32) -> Option<DateTime<Utc>> {
    let naive = Local.timestamp_millis_opt(now_ms).single()?.naive_local();
    let year = naive.year().checked_add(years)?;
    let date = NaiveDate::from_ymd_opt(year, naive.month(), naive.day())
        .or_else(|| NaiveDate::from_ymd_opt(year, 3, 1))?;
    let at = Local
        .from_local_datetime(&date.and_time(naive.time()))
        .earliest()?;
    Some(at.with_timezone(&Utc))
}

fn end_of_day(year: i32, month: u32, day: u32) -> Option<DateTime<Utc>> {
    if year < 100 {
        return None;
    }
    let end = NaiveDate::from_ymd_opt(year, month, day)?.and_hms_milli_opt(23, 59, 59, 999)?;
    let at = Local.from_local_datetime(&end).earliest()?;
    Some(at.with_timezone(&Utc))
}

pub fn token_expiry(raw: &str, now_ms: i64) -> Result<Option<String>, String> {
    if raw == NEVER_EXPIRES {
        return Ok(None);
    }
    if let Some(relative) = RELATIVE.captures(raw) {
        let count: i64 = relative[1].parse().map_err(|_| unreadable(raw))?;
        let at = if &relative[2] == "d" {
            DateTime::<Utc>::from_timestamp_millis(now_ms + count * DAY_MS)
        } else {
            i32::try_from(count)
                .ok()
                .and_then(|years| after_years(now_ms, years))
        };
        return at
            .map(|at| Some(iso_string(at)))
            .ok_or_else(|| unreadable(raw));
    }
    if let Some(date) = DATE.captures(raw) {
        let parts = (
            date[1].parse::<i32>(),
            date[2].parse::<u32>(),
            date[3].parse::<u32>(),
        );
        if let (Ok(year), Ok(month), Ok(day)) = parts
            && let Some(at) = end_of_day(year, month, day)
        {
            if at.timestamp_millis() <= now_ms {
                return Err(format!("expires: {raw} is in the past"));
            }
            return Ok(Some(iso_string(at)));
        }
    }
    Err(unreadable(raw))
}
