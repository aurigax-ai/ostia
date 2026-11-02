use std::collections::{HashMap, HashSet};

use ostia_base::js::{is_js_space, js_number, utf16_len};
use serde_json::Value;

use crate::git::{BranchRef, GraphScope, ScopePlan};
use crate::history::FIELD_SEP;

const MAX_CHOSEN_REFS: usize = 64;
const MAX_REF_LENGTH: usize = 256;
const LOCAL_PREFIX: &str = "refs/heads/";
const REMOTE_PREFIX: &str = "refs/remotes/";

pub const BRANCH_REF_FORMAT: &str = concat!(
    "%(refname)",
    "\x1f",
    "%(objectname)",
    "\x1f",
    "%(committerdate:unix)",
    "\x1f",
    "%(symref)"
);

fn is_branch_ref(reference: &str) -> bool {
    utf16_len(reference) <= MAX_REF_LENGTH
        && (reference.starts_with(LOCAL_PREFIX) || reference.starts_with(REMOTE_PREFIX))
        && !reference.chars().any(|ch| ch == '\0' || is_js_space(ch))
}

pub fn parse_scope(raw: &Value) -> Option<GraphScope> {
    let object = raw.as_object()?;
    match object.get("kind")?.as_str()? {
        "current" => Some(GraphScope::Current),
        "all" => Some(GraphScope::All),
        "chosen" => {
            let refs = object.get("refs")?.as_array()?;
            let mut seen = HashSet::new();
            let valid: Vec<String> = refs
                .iter()
                .filter_map(Value::as_str)
                .filter(|reference| is_branch_ref(reference))
                .filter(|reference| seen.insert(*reference))
                .take(MAX_CHOSEN_REFS)
                .map(str::to_owned)
                .collect();
            if valid.is_empty() {
                None
            } else {
                Some(GraphScope::Chosen { refs: valid })
            }
        }
        _ => None,
    }
}

pub fn parse_branch_refs(output: &str, head: Option<&str>) -> Vec<BranchRef> {
    let mut refs = Vec::new();
    for line in output.split('\n') {
        let mut fields = line.split(FIELD_SEP);
        let reference = fields.next().unwrap_or_default();
        let sha = fields.next().unwrap_or_default();
        let time = fields.next().unwrap_or_default();
        let symref = fields.next().unwrap_or_default();
        if reference.is_empty() || sha.is_empty() || !symref.is_empty() || !is_branch_ref(reference)
        {
            continue;
        }
        let (remote, name) = match reference.strip_prefix(REMOTE_PREFIX) {
            Some(name) => (true, name),
            None => (
                false,
                reference.strip_prefix(LOCAL_PREFIX).unwrap_or_default(),
            ),
        };
        refs.push(BranchRef {
            r#ref: reference.to_owned(),
            name: name.to_owned(),
            remote,
            current: !remote && head == Some(name),
            sha: sha.to_owned(),
            time: js_number(time) as i64,
        });
    }
    refs.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then(a.remote.cmp(&b.remote))
            .then(b.time.cmp(&a.time))
            .then(a.name.cmp(&b.name))
    });
    refs
}

fn current_plan() -> ScopePlan {
    ScopePlan {
        scope: GraphScope::Current,
        revisions: vec!["HEAD".to_owned()],
        includes_head: true,
    }
}

pub fn plan_scope(scope: &GraphScope, branches: &[BranchRef]) -> ScopePlan {
    match scope {
        GraphScope::All => ScopePlan {
            scope: GraphScope::All,
            revisions: vec![
                "--branches".to_owned(),
                "--remotes".to_owned(),
                "HEAD".to_owned(),
            ],
            includes_head: true,
        },
        GraphScope::Chosen { refs } => {
            let known: HashMap<&str, &BranchRef> = branches
                .iter()
                .map(|branch| (branch.r#ref.as_str(), branch))
                .collect();
            let kept: Vec<String> = refs
                .iter()
                .filter(|reference| known.contains_key(reference.as_str()))
                .cloned()
                .collect();
            if kept.is_empty() {
                return current_plan();
            }
            let includes_head = kept.iter().any(|reference| {
                known
                    .get(reference.as_str())
                    .is_some_and(|branch| branch.current)
            });
            let mut revisions = vec!["--end-of-options".to_owned()];
            revisions.extend(kept.iter().cloned());
            ScopePlan {
                scope: GraphScope::Chosen { refs: kept },
                revisions,
                includes_head,
            }
        }
        GraphScope::Current => current_plan(),
    }
}
