use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use ostia_base::js::{JS_SPACE_CLASS, js_trim, static_regex};
use ostia_contract::assist::CHAT_TOOL_OUTPUT_MAX;
use ostia_contract::utf16_prefix::utf16_prefix;
use regex::Regex;
use serde_json::Value;

pub const SKILL_DESCRIPTION_MAX: usize = 1024;
pub const SKILL_FILE_MAX: usize = 256 * 1024;
pub const SKILLS_MAX: usize = 128;

const SKILL_FILE: &str = "SKILL.md";

static SKILL_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));
static FRONT_MATTER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?s)^---\r?\n(.*?)\r?\n---\r?\n?"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| static_regex(&format!("[{JS_SPACE_CLASS}]+")));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillLoadResult {
    Loaded {
        name: String,
        path: PathBuf,
        body: String,
    },
    Failed {
        error: &'static str,
    },
}

struct FoundSkill {
    skill: ParsedSkill,
    path: PathBuf,
}

fn parse_front_matter(meta: &str) -> Option<serde_json::Map<String, Value>> {
    let options = serde_saphyr::options! {
        budget: serde_saphyr::budget! { max_aliases: 0 },
    };
    match serde_saphyr::from_str_with_options::<Value>(meta, options) {
        Ok(Value::Object(fields)) => Some(fields),
        _ => None,
    }
}

pub fn parse_skill_text(text: &str, fallback_name: &str) -> Option<ParsedSkill> {
    let captures = FRONT_MATTER.captures(text)?;
    let whole = captures.get(0)?;
    let fields = parse_front_matter(captures.get(1)?.as_str())?;
    let name = match fields.get("name").and_then(Value::as_str) {
        Some(name) => js_trim(name).to_owned(),
        None => fallback_name.to_owned(),
    };
    let description = match fields.get("description").and_then(Value::as_str) {
        Some(description) => {
            let folded = SPACE_RUN.replace_all(description, " ");
            utf16_prefix(js_trim(&folded), SKILL_DESCRIPTION_MAX).to_owned()
        }
        None => String::new(),
    };
    if !SKILL_NAME.is_match(&name) || description.is_empty() {
        return None;
    }
    Some(ParsedSkill {
        name,
        description,
        body: text[whole.end()..].to_owned(),
    })
}

fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|info| info.is_dir())
}

fn read_skill_file(dir: &Path) -> Option<ParsedSkill> {
    let file = dir.join(SKILL_FILE);
    let info = fs::symlink_metadata(&file).ok()?;
    if !info.is_file() || usize::try_from(info.len()).is_ok_and(|len| len > SKILL_FILE_MAX) {
        return None;
    }
    let bytes = fs::read(&file).ok()?;
    let fallback = dir.file_name()?.to_string_lossy();
    parse_skill_text(&String::from_utf8_lossy(&bytes), &fallback)
}

fn skill_dirs(folder: &Path) -> Vec<PathBuf> {
    if !is_real_dir(folder) {
        return Vec::new();
    }
    if fs::symlink_metadata(folder.join(SKILL_FILE)).is_ok_and(|info| info.is_file()) {
        return vec![folder.to_path_buf()];
    }
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    dirs.sort_by(|left, right| {
        let left = left.to_string_lossy();
        let right = right.to_string_lossy();
        left.encode_utf16().cmp(right.encode_utf16())
    });
    dirs
}

fn find_skills(folders: &[PathBuf]) -> Vec<FoundSkill> {
    let mut out: Vec<FoundSkill> = Vec::new();
    for folder in folders {
        for dir in skill_dirs(folder) {
            if out.len() == SKILLS_MAX {
                return out;
            }
            let Some(skill) = read_skill_file(&dir) else {
                continue;
            };
            if out.iter().any(|found| found.skill.name == skill.name) {
                continue;
            }
            out.push(FoundSkill {
                skill,
                path: dir.join(SKILL_FILE),
            });
        }
    }
    out
}

pub fn list_skills(folders: &[PathBuf]) -> Vec<SkillSummary> {
    find_skills(folders)
        .into_iter()
        .map(|found| SkillSummary {
            name: found.skill.name,
            description: found.skill.description,
            path: found.path,
        })
        .collect()
}

pub fn load_skill(folders: &[PathBuf], name: &Value) -> SkillLoadResult {
    let Some(name) = name.as_str().filter(|name| SKILL_NAME.is_match(name)) else {
        return SkillLoadResult::Failed { error: "invalid" };
    };
    let Some(found) = find_skills(folders)
        .into_iter()
        .find(|found| found.skill.name == name)
    else {
        return SkillLoadResult::Failed {
            error: "unknown-skill",
        };
    };
    SkillLoadResult::Loaded {
        name: found.skill.name,
        path: found.path,
        body: utf16_prefix(&found.skill.body, CHAT_TOOL_OUTPUT_MAX).to_owned(),
    }
}
