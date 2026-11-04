use std::collections::{BTreeMap, HashSet};
use std::ops::RangeInclusive;
use std::sync::LazyLock;

use ostia_base::js::{js_to_number, static_regex, utf16_len};
use regex::Regex;
use serde_json::{Map, Value};

pub const PI_MANAGER_AGENT: &str = "pi";
pub const MANAGER_MAX_ARGS: usize = 64;
pub const MANAGER_MAX_ARG_LENGTH: usize = 4096;
const MANAGER_MAX_SKILLS: usize = 32;
const MAX_SKILL_PATH: usize = 4096;

pub const MAX_WORKERS_BOUNDS: RangeInclusive<u32> = 0..=64;
pub const SPAWNS_PER_10_MIN_BOUNDS: RangeInclusive<u32> = 0..=200;
pub const BUS_PER_MINUTE_BOUNDS: RangeInclusive<u32> = 0..=600;

static MANAGER_AGENT_NAME: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));

pub type ManagerAgents = BTreeMap<String, Vec<String>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ManagerLimits {
    pub max_workers: u32,
    pub spawns_per_10_min: u32,
    pub bus_per_minute: u32,
}

impl Default for ManagerLimits {
    fn default() -> Self {
        Self {
            max_workers: 8,
            spawns_per_10_min: 20,
            bus_per_minute: 60,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManagerSettings {
    pub agents: ManagerAgents,
    pub skills: Vec<String>,
    pub allow_input: bool,
    pub limits: ManagerLimits,
}

pub fn is_manager_agent_name(name: &str) -> bool {
    MANAGER_AGENT_NAME.is_match(name)
}

pub fn builtin_manager_agents() -> ManagerAgents {
    [
        ("claude", vec!["claude"]),
        ("codex", vec!["codex"]),
        ("agy", vec!["agy", "-i"]),
    ]
    .into_iter()
    .map(|(name, argv)| {
        (
            name.to_owned(),
            argv.into_iter().map(str::to_owned).collect(),
        )
    })
    .collect()
}

pub fn manager_argv(value: &Value) -> Option<Vec<String>> {
    let items = value.as_array()?;
    if items.is_empty() || items.len() > MANAGER_MAX_ARGS {
        return None;
    }
    if items.first()?.as_str()?.is_empty() {
        return None;
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| utf16_len(text) <= MANAGER_MAX_ARG_LENGTH)
                .map(str::to_owned)
        })
        .collect()
}

pub fn is_skill_path(value: &Value) -> bool {
    value.as_str().is_some_and(|path| {
        path.starts_with('/')
            && utf16_len(path) <= MAX_SKILL_PATH
            && !path.split('/').any(|part| part == "..")
    })
}

fn clamp_limit(bounds: &RangeInclusive<u32>, default: u32, value: Option<&Value>) -> u32 {
    let number = value.map_or(f64::NAN, js_to_number);
    if !number.is_finite() {
        return default;
    }
    let floor = number.floor();
    let rounded = if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    let clamped = rounded.clamp(f64::from(*bounds.start()), f64::from(*bounds.end()));
    clamped as u32
}

fn parse_agents(raw: &Map<String, Value>) -> ManagerAgents {
    let Some(agents) = raw.get("agents").and_then(Value::as_object) else {
        return ManagerAgents::new();
    };
    agents
        .iter()
        .filter(|(name, _)| name.as_str() != PI_MANAGER_AGENT && is_manager_agent_name(name))
        .filter_map(|(name, argv)| Some((name.clone(), manager_argv(argv)?)))
        .collect()
}

fn parse_skills(raw: &Map<String, Value>) -> Vec<String> {
    let Some(skills) = raw.get("skills").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    skills
        .iter()
        .filter(|skill| is_skill_path(skill))
        .filter_map(Value::as_str)
        .filter(|skill| seen.insert(*skill))
        .take(MANAGER_MAX_SKILLS)
        .map(str::to_owned)
        .collect()
}

pub fn parse_manager_settings(raw: &Value) -> ManagerSettings {
    let Some(raw) = raw.as_object() else {
        return ManagerSettings::default();
    };
    let defaults = ManagerLimits::default();
    let empty = Map::new();
    let limits = raw
        .get("limits")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    ManagerSettings {
        agents: parse_agents(raw),
        skills: parse_skills(raw),
        allow_input: raw.get("allowInput") == Some(&Value::Bool(true)),
        limits: ManagerLimits {
            max_workers: clamp_limit(
                &MAX_WORKERS_BOUNDS,
                defaults.max_workers,
                limits.get("maxWorkers"),
            ),
            spawns_per_10_min: clamp_limit(
                &SPAWNS_PER_10_MIN_BOUNDS,
                defaults.spawns_per_10_min,
                limits.get("spawnsPer10Min"),
            ),
            bus_per_minute: clamp_limit(
                &BUS_PER_MINUTE_BOUNDS,
                defaults.bus_per_minute,
                limits.get("busPerMinute"),
            ),
        },
    }
}

pub fn manager_agents(settings: &ManagerSettings) -> ManagerAgents {
    let mut agents = builtin_manager_agents();
    agents.extend(settings.agents.clone());
    agents
}
