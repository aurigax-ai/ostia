use std::collections::{HashMap, HashSet};

pub const ENV_PREFIX: &str = "OSTIA_";

pub type EnvSource = HashMap<String, String>;

pub fn env_name(name: &str) -> String {
    format!("{ENV_PREFIX}{name}")
}

pub fn read_env(name: &str, env: &EnvSource) -> Option<String> {
    env.get(&env_name(name))
        .filter(|value| !value.is_empty())
        .cloned()
}

pub fn app_env(values: &[(&str, &str)]) -> EnvSource {
    values
        .iter()
        .map(|(name, value)| (env_name(name), (*value).to_owned()))
        .collect()
}

pub fn without_env(env: &EnvSource, names: &[&str]) -> EnvSource {
    let drop: HashSet<String> = names.iter().map(|name| env_name(name)).collect();
    env.iter()
        .filter(|(key, _)| !drop.contains(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn is_app_env_name(key: &str) -> bool {
    key.starts_with(ENV_PREFIX)
}

pub fn shell_env(name: &str) -> String {
    format!("${{{}}}", env_name(name))
}
