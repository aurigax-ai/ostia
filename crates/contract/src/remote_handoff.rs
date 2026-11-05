use std::sync::LazyLock;

use ostia_base::js::static_regex;
use regex::Regex;
use serde_json::{Map, Value};

use crate::utf16_prefix::utf16_prefix;

pub const START_WAIT_MS: u64 = 60_000;
pub const PROMPT_MAX: usize = 16_000;

static REPO_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$"));
static REPO_ID: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}-[0-9a-f]{12}$"));
static COMMIT: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[0-9a-f]{40}$"));
static SLUG_BAD_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(r"[^A-Za-z0-9._-]+"));
static SLUG_LEADING: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[^A-Za-z0-9]+"));

const SLUG_MAX_UNITS: usize = 40;
const ROOT_COMMIT_UNITS: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoHandoff {
    pub id: String,
    pub name: String,
    pub head: String,
}

impl RepoHandoff {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".to_owned(), Value::from(self.id.clone()));
        map.insert("name".to_owned(), Value::from(self.name.clone()));
        map.insert("head".to_owned(), Value::from(self.head.clone()));
        Value::Object(map)
    }
}

fn field_matching<'a>(value: &'a Value, key: &str, pattern: &Regex) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| pattern.is_match(text))
}

pub fn is_repo_handoff(value: &Value) -> bool {
    field_matching(value, "id", &REPO_ID).is_some()
        && field_matching(value, "name", &REPO_NAME).is_some()
        && field_matching(value, "head", &COMMIT).is_some()
}

pub fn repo_slug(name: &str) -> String {
    let dashed = SLUG_BAD_RUN.replace_all(name, "-");
    let stripped = SLUG_LEADING.replace(&dashed, "");
    let slug = utf16_prefix(&stripped, SLUG_MAX_UNITS);
    if slug.is_empty() {
        "repo".to_owned()
    } else {
        slug.to_owned()
    }
}

pub fn job_ref(job_id: &str) -> String {
    format!("refs/ostia/jobs/{job_id}")
}

pub fn job_branch(job_id: &str) -> String {
    format!("ostia/{job_id}")
}

pub fn fetched_ref(host: &str, job_id: &str) -> String {
    format!("refs/remotes/ostia/{host}/{job_id}")
}

pub fn mirror_path(repo_id: &str) -> String {
    format!(".ostia/node/repos/{repo_id}.git")
}

pub fn repo_id_of(name: &str, root_commit: &str) -> String {
    format!("{name}-{}", utf16_prefix(root_commit, ROOT_COMMIT_UNITS))
}
