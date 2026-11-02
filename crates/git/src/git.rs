use ostia_base::js::parse_safe_int;
use serde::Serialize;

pub(crate) fn js_number(text: &str) -> i64 {
    parse_safe_int(text).unwrap_or(0)
}

pub fn is_uncommitted(sha: &str) -> bool {
    !sha.is_empty() && sha.bytes().all(|byte| byte == b'0')
}

pub(crate) fn is_sha(text: &str) -> bool {
    (40..=64).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BranchInfo {
    pub oid: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeArea {
    Staged,
    Unstaged,
    Untracked,
    Conflicted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub area: ChangeArea,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RepoStatus {
    pub branch: BranchInfo,
    pub changes: Vec<FileChange>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StatusSummary {
    pub added: i64,
    pub changed: i64,
    pub staged: i64,
    pub unstaged: i64,
    pub untracked: i64,
    pub conflicted: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineChanges {
    pub files: i64,
    pub added: i64,
    pub removed: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommitSummary {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Head,
    Branch,
    Remote,
    Tag,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommitRef {
    pub kind: RefKind,
    pub name: String,
    #[serde(skip_serializing_if = "is_false")]
    pub current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub subject: String,
    pub refs: Vec<CommitRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlameLine {
    pub line: i64,
    pub sha: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
    pub text: String,
}
