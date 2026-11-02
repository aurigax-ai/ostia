use std::collections::HashMap;
use std::sync::LazyLock;

use ostia_base::PRODUCT_NAME;
use ostia_base::js::{is_js_space, js_trim, static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

use crate::skill_directive::skill_directive;

pub const PLAYBOOK_TEXT_MAX: usize = 8000;
pub const PLAYBOOK_DESCRIPTION_MAX: usize = 120;
pub const OWN_PLAYBOOKS_MAX: usize = 24;
const EDIT_FROM_MAX: usize = 16;

static PLAYBOOK_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z][a-z0-9-]{0,31}$"));
static FORMAT_CHARACTER: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\p{Cf}"));

const RESERVED_NAMES: &[&str] = &[
    PRODUCT_NAME,
    "add-dir",
    "agents",
    "batch",
    "bug",
    "clear",
    "code-review",
    "compact",
    "config",
    "context",
    "copy",
    "cost",
    "debug",
    "doctor",
    "effort",
    "exit",
    "export",
    "fast",
    "feedback",
    "help",
    "hooks",
    "ide",
    "init",
    "install-github-app",
    "login",
    "logout",
    "loop",
    "mcp",
    "memory",
    "mobile",
    "model",
    "output-style",
    "permissions",
    "plugin",
    "pr-comments",
    "privacy-settings",
    "release-notes",
    "remote-control",
    "resume",
    "review",
    "rewind",
    "schedule",
    "security-review",
    "simplify",
    "skills",
    "stats",
    "status",
    "statusline",
    "terminal-setup",
    "theme",
    "todos",
    "ultrareview",
    "upgrade",
    "usage",
    "vim",
    "voice",
];

const ONBOARD_STEPS: &[(&str, &str)] = &[
    (
        "cleanup",
        include_str!("playbooks/onboard/steps/cleanup.md"),
    ),
    (
        "dispatch",
        include_str!("playbooks/onboard/steps/dispatch.md"),
    ),
    ("issue", include_str!("playbooks/onboard/steps/issue.md")),
    ("limits", include_str!("playbooks/onboard/steps/limits.md")),
    ("merge", include_str!("playbooks/onboard/steps/merge.md")),
    ("name", include_str!("playbooks/onboard/steps/name.md")),
    ("pr", include_str!("playbooks/onboard/steps/pr.md")),
    ("report", include_str!("playbooks/onboard/steps/report.md")),
    ("review", include_str!("playbooks/onboard/steps/review.md")),
    ("scout", include_str!("playbooks/onboard/steps/scout.md")),
    ("test", include_str!("playbooks/onboard/steps/test.md")),
    ("watch", include_str!("playbooks/onboard/steps/watch.md")),
    (
        "worktree",
        include_str!("playbooks/onboard/steps/worktree.md"),
    ),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookExtraFile {
    pub path: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuiltinPlaybook {
    pub id: String,
    pub description: String,
    pub text: String,
    pub files: Vec<PlaybookExtraFile>,
    pub agent_loadable: bool,
}

static BUILTIN_PLAYBOOKS: LazyLock<Vec<BuiltinPlaybook>> = LazyLock::new(|| {
    vec![
        BuiltinPlaybook {
            id: "onboard".to_owned(),
            description: "Learn the manager, worker and review workflow, one step at a time."
                .to_owned(),
            text: include_str!("playbooks/onboard/SKILL.md").to_owned(),
            files: ONBOARD_STEPS
                .iter()
                .map(|(step, text)| PlaybookExtraFile {
                    path: format!("steps/{step}.md"),
                    text: (*text).to_owned(),
                })
                .collect(),
            agent_loadable: true,
        },
        BuiltinPlaybook {
            id: "handoff".to_owned(),
            description: "Start a clean new session on one topic, beside this one.".to_owned(),
            text: include_str!("playbooks/handoff.md").to_owned(),
            files: Vec::new(),
            agent_loadable: false,
        },
        BuiltinPlaybook {
            id: "coordinator".to_owned(),
            description: "Plan, dispatch, review and merge; write no code yourself.".to_owned(),
            text: include_str!("playbooks/coordinator.md").to_owned(),
            files: Vec::new(),
            agent_loadable: false,
        },
    ]
});

pub fn builtin_playbooks() -> &'static [BuiltinPlaybook] {
    BUILTIN_PLAYBOOKS.as_slice()
}

fn builtin_of(id: &str) -> Option<&'static BuiltinPlaybook> {
    builtin_playbooks()
        .iter()
        .find(|playbook| playbook.id == id)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookEdit {
    pub text: String,
    pub from: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnPlaybook {
    pub description: String,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlaybooksSettings {
    pub enabled: HashMap<String, bool>,
    pub accepted: HashMap<String, String>,
    pub edits: HashMap<String, PlaybookEdit>,
    pub own: Vec<(String, OwnPlaybook)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedPlaybook {
    pub id: String,
    pub builtin: bool,
    pub description: String,
    pub text: String,
    pub files: Vec<PlaybookExtraFile>,
    pub agent_loadable: bool,
    pub enabled: bool,
    pub unaccepted: Option<String>,
}

fn utf16_prefix(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= max
        })
        .collect()
}

fn entries(value: Option<&Value>) -> impl Iterator<Item = (&String, &Value)> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(Map::iter)
}

fn text_field(fields: &Map<String, Value>, key: &str, max: usize) -> String {
    fields
        .get(key)
        .and_then(Value::as_str)
        .map_or_else(String::new, |text| utf16_prefix(text, max))
}

fn own_name_allowed(name: &str) -> bool {
    PLAYBOOK_NAME.is_match(name) && !RESERVED_NAMES.contains(&name) && builtin_of(name).is_none()
}

pub fn parse_playbooks(raw: &Value) -> PlaybooksSettings {
    let Some(src) = raw.as_object() else {
        return PlaybooksSettings::default();
    };
    let enabled: HashMap<String, bool> = entries(src.get("enabled"))
        .filter(|(id, _)| PLAYBOOK_NAME.is_match(id))
        .filter_map(|(id, value)| Some((id.clone(), value.as_bool()?)))
        .collect();
    let edits: HashMap<String, PlaybookEdit> = entries(src.get("edits"))
        .filter_map(|(id, value)| {
            builtin_of(id)?;
            let fields = value.as_object()?;
            let text = fields.get("text")?.as_str()?;
            let from = fields.get("from")?.as_str()?;
            Some((
                id.clone(),
                PlaybookEdit {
                    text: utf16_prefix(text, PLAYBOOK_TEXT_MAX),
                    from: utf16_prefix(from, EDIT_FROM_MAX),
                },
            ))
        })
        .collect();
    let mut own = Vec::new();
    for (name, value) in entries(src.get("own")) {
        if own.len() >= OWN_PLAYBOOKS_MAX {
            break;
        }
        if !own_name_allowed(name) {
            continue;
        }
        let Some(fields) = value.as_object() else {
            continue;
        };
        own.push((
            name.clone(),
            OwnPlaybook {
                description: text_field(fields, "description", PLAYBOOK_DESCRIPTION_MAX),
                text: text_field(fields, "text", PLAYBOOK_TEXT_MAX),
            },
        ));
    }
    let accepted: HashMap<String, String> = entries(src.get("accepted"))
        .filter(|(id, _)| PLAYBOOK_NAME.is_match(id))
        .filter_map(|(id, value)| {
            Some((id.clone(), utf16_prefix(value.as_str()?, PLAYBOOK_TEXT_MAX)))
        })
        .collect();
    PlaybooksSettings {
        enabled,
        accepted,
        edits,
        own,
    }
}

fn resolve(settings: &PlaybooksSettings) -> Vec<ResolvedPlaybook> {
    let builtins = builtin_playbooks().iter().map(|builtin| {
        let edit = settings
            .edits
            .get(&builtin.id)
            .filter(|edit| edit.text != builtin.text);
        let accepted =
            edit.is_some_and(|edit| settings.accepted.get(&builtin.id) == Some(&edit.text));
        let text = match edit {
            Some(edit) if accepted => edit.text.clone(),
            _ => builtin.text.clone(),
        };
        ResolvedPlaybook {
            id: builtin.id.clone(),
            builtin: true,
            description: builtin.description.clone(),
            text,
            files: builtin.files.clone(),
            agent_loadable: builtin.agent_loadable,
            enabled: settings.enabled.get(&builtin.id).copied().unwrap_or(false),
            unaccepted: edit.filter(|_| !accepted).map(|edit| edit.text.clone()),
        }
    });
    let owns = settings.own.iter().map(|(id, own)| ResolvedPlaybook {
        id: id.clone(),
        builtin: false,
        description: own.description.clone(),
        text: own.text.clone(),
        files: Vec::new(),
        agent_loadable: false,
        enabled: settings.enabled.get(id).copied().unwrap_or(false),
        unaccepted: (settings.accepted.get(id) != Some(&own.text)).then(|| own.text.clone()),
    });
    builtins.chain(owns).collect()
}

fn has_control(text: &str, allow_line_breaks: bool) -> bool {
    text.chars().any(|ch| {
        let code = ch as u32;
        if allow_line_breaks && matches!(code, 0x09 | 0x0a | 0x0d) {
            return false;
        }
        matches!(code, 0x00..=0x1f | 0x7f..=0x9f | 0x2028 | 0x2029)
    })
}

fn text_is_valid(text: &str) -> bool {
    !js_trim(text).is_empty()
        && utf16_len(text) <= PLAYBOOK_TEXT_MAX
        && !has_control(text, true)
        && skill_directive(text).is_none()
}

fn description_is_valid(description: &str) -> bool {
    !js_trim(description).is_empty()
        && utf16_len(description) <= PLAYBOOK_DESCRIPTION_MAX
        && !has_control(description, false)
        && !FORMAT_CHARACTER.is_match(description)
}

pub fn active_playbooks(settings: &PlaybooksSettings) -> Vec<ResolvedPlaybook> {
    resolve(settings)
        .into_iter()
        .filter(|playbook| {
            playbook.enabled
                && (playbook.builtin || playbook.unaccepted.is_none())
                && text_is_valid(&playbook.text)
                && (playbook.builtin || description_is_valid(&playbook.description))
        })
        .collect()
}

pub fn collapse_spaces(text: &str) -> String {
    text.split(is_js_space)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn skill_text(playbook: &ResolvedPlaybook) -> String {
    let mut lines = vec![
        "---".to_owned(),
        format!("name: {}", playbook.id),
        format!(
            "description: {}",
            Value::String(collapse_spaces(&playbook.description))
        ),
        "argument-hint: \"[task]\"".to_owned(),
    ];
    if !playbook.agent_loadable {
        lines.push("disable-model-invocation: true".to_owned());
    }
    lines.push("---".to_owned());
    lines.push(String::new());
    lines.push(playbook.text.trim_end_matches(is_js_space).to_owned());
    lines.push(String::new());
    lines.join("\n")
}
