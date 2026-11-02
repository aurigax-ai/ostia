use std::collections::BTreeMap;

const REMOVED: [&str; 5] = [
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GPG_AGENT_INFO",
    "OSTIA_ARTIFACTS",
    "OSTIA_PAD",
];

pub fn sandbox_spawn_env(env: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.iter()
        .filter(|(name, _)| !REMOVED.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}
