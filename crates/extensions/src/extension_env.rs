use ostia_contract::app_env::{EnvSource, app_env, without_env};

const PROVIDER_PREFIXES: [&str; 20] = [
    "ANTHROPIC_",
    "OPENAI_",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
    "GEMINI_",
    "GCLOUD_",
    "CLOUDSDK_",
    "VERTEX_",
    "GROQ_",
    "MISTRAL_",
    "XAI_",
    "OPENROUTER_",
    "DEEPSEEK_",
    "TOGETHER_",
    "FIREWORKS_",
    "CEREBRAS_",
    "MOONSHOT_",
    "HF_",
    "COPILOT_",
];

const PROVIDER_SUFFIXES: [&str; 5] = [
    "_API_KEY",
    "_AUTH_TOKEN",
    "_OAUTH_TOKEN",
    "_ACCESS_TOKEN",
    "_BEARER_TOKEN",
];

fn is_provider_credential(name: &str) -> bool {
    PROVIDER_SUFFIXES
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || PROVIDER_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

pub struct ExtensionEnvParts {
    pub socket: String,
    pub token: String,
    pub api_version: String,
    pub api_env_name: String,
    pub id: String,
    pub dir: String,
    pub data_dir: Option<String>,
}

pub fn extension_environment(parent: &EnvSource, parts: &ExtensionEnvParts) -> EnvSource {
    let mut env: EnvSource = without_env(parent, &["PANE_ID", "START_DIR"])
        .into_iter()
        .filter(|(name, _)| !is_provider_credential(name))
        .collect();
    let mut own = vec![
        ("SOCKET", parts.socket.as_str()),
        ("TOKEN", parts.token.as_str()),
        (parts.api_env_name.as_str(), parts.api_version.as_str()),
        ("EXTENSION_ID", parts.id.as_str()),
        ("EXTENSION_DIR", parts.dir.as_str()),
    ];
    if let Some(data_dir) = parts.data_dir.as_deref().filter(|dir| !dir.is_empty()) {
        own.push(("EXTENSION_DATA", data_dir));
    }
    env.extend(app_env(&own));
    env
}
