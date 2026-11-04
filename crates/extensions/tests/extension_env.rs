#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::app_env::EnvSource;
use ostia_extensions::extension_env::{ExtensionEnvParts, extension_environment};

fn parts() -> ExtensionEnvParts {
    ExtensionEnvParts {
        socket: "/tmp/s.sock".to_owned(),
        token: "t".to_owned(),
        api_version: "4.13".to_owned(),
        api_env_name: "EXTENSION_API".to_owned(),
        id: "agent".to_owned(),
        dir: "/ext/agent".to_owned(),
        data_dir: Some("/data/agent".to_owned()),
    }
}

fn env_of(pairs: &[(&str, &str)]) -> EnvSource {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect()
}

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

#[test]
fn passes_no_provider_or_cloud_credential_to_an_extension() {
    let parent = env_of(&[
        ("PATH", "/usr/bin"),
        ("HOME", "/home/u"),
        ("ANTHROPIC_API_KEY", "sk-ant-1"),
        ("OPENAI_API_KEY", "sk-1"),
        ("OPENAI_BASE_URL", "http://x"),
        ("AWS_ACCESS_KEY_ID", "AKIA"),
        ("AWS_SECRET_ACCESS_KEY", "secret"),
        ("AWS_PROFILE", "prod"),
        ("GOOGLE_APPLICATION_CREDENTIALS", "/k.json"),
        ("AZURE_OPENAI_API_KEY", "az"),
        ("GEMINI_API_KEY", "g"),
        ("GROQ_API_KEY", "q"),
        ("HF_TOKEN", "hf"),
        ("COPILOT_GITHUB_TOKEN", "gh"),
        ("SOME_NEW_VENDOR_API_KEY", "v"),
    ]);
    let env = extension_environment(&parent, &parts());
    let leaked: Vec<&String> = env
        .keys()
        .filter(|name| {
            !name.starts_with("OSTIA_")
                && ["KEY", "TOKEN", "AWS", "GOOGLE", "AZURE", "OPENAI", "HF_"]
                    .iter()
                    .any(|word| name.contains(word))
        })
        .collect();
    assert!(leaked.is_empty(), "{leaked:?}");
    assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
    assert_eq!(env.get("HOME").map(String::as_str), Some("/home/u"));
}

#[test]
fn still_hands_the_extension_its_own_socket_token_and_folders() {
    let parent = env_of(&[("OSTIA_PANE_ID", "p"), ("OSTIA_START_DIR", "/x")]);
    let env = extension_environment(&parent, &parts());
    assert_eq!(env.get("OSTIA_PANE_ID"), None);
    assert_eq!(env.get("OSTIA_START_DIR"), None);
    let values: Vec<&str> = env.values().map(String::as_str).collect();
    for wanted in [
        "/tmp/s.sock",
        "t",
        "4.13",
        "agent",
        "/ext/agent",
        "/data/agent",
    ] {
        assert!(values.contains(&wanted), "missing {wanted}");
    }
}

#[test]
fn names_each_variable_of_the_extension_with_the_app_prefix() {
    let env = extension_environment(&EnvSource::new(), &parts());
    assert_eq!(
        env,
        env_of(&[
            ("OSTIA_SOCKET", "/tmp/s.sock"),
            ("OSTIA_TOKEN", "t"),
            ("OSTIA_EXTENSION_API", "4.13"),
            ("OSTIA_EXTENSION_ID", "agent"),
            ("OSTIA_EXTENSION_DIR", "/ext/agent"),
            ("OSTIA_EXTENSION_DATA", "/data/agent"),
        ])
    );
}

#[test]
fn drops_every_variable_that_starts_with_a_provider_prefix() {
    for prefix in PROVIDER_PREFIXES {
        let name = format!("{prefix}ANYTHING");
        let parent = env_of(&[(name.as_str(), "v"), ("KEEP", "k")]);
        let env = extension_environment(&parent, &parts());
        assert!(!env.contains_key(&name), "{name}");
        assert_eq!(env.get("KEEP").map(String::as_str), Some("k"), "{name}");
    }
}

#[test]
fn drops_every_variable_that_ends_with_a_credential_suffix() {
    for suffix in PROVIDER_SUFFIXES {
        let name = format!("NEW_VENDOR{suffix}");
        let parent = env_of(&[(name.as_str(), "v"), ("KEEP", "k")]);
        let env = extension_environment(&parent, &parts());
        assert!(!env.contains_key(&name), "{name}");
        assert_eq!(env.get("KEEP").map(String::as_str), Some("k"), "{name}");
    }
}

#[test]
fn keeps_a_variable_that_only_looks_like_a_provider_credential() {
    let kept = [
        "API_KEY",
        "TOKEN",
        "AUTH_TOKEN",
        "MY_API_KEY_FILE",
        "MY_API_KEYS",
        "MY_TOKEN",
        "GITHUB_TOKEN",
        "AWS",
        "AWSX_REGION",
        "HF",
        "HFX_HOME",
        "XAI",
        "openai_api_key_lower",
        "my_api_key",
        "aws_profile",
        "NOT_AWS_PROFILE",
        "MY_GOOGLE_HOME",
        "EDITOR",
        "SSH_AUTH_SOCK",
        "LANG",
    ];
    let parent: EnvSource = kept
        .iter()
        .map(|name| ((*name).to_owned(), "v".to_owned()))
        .collect();
    let env = extension_environment(&parent, &parts());
    for name in kept {
        assert!(env.contains_key(name), "{name}");
    }
}

#[test]
fn drops_a_provider_credential_that_has_the_app_prefix_too() {
    let parent = env_of(&[
        ("OSTIA_VENDOR_API_KEY", "v"),
        ("OSTIA_FOO", "f"),
        ("OSTIA_ANTHROPIC_X", "a"),
    ]);
    let env = extension_environment(&parent, &parts());
    assert_eq!(env.get("OSTIA_VENDOR_API_KEY"), None);
    assert_eq!(env.get("OSTIA_FOO").map(String::as_str), Some("f"));
    assert_eq!(env.get("OSTIA_ANTHROPIC_X").map(String::as_str), Some("a"));
}

#[test]
fn replaces_an_app_variable_of_the_parent_with_the_value_of_the_extension() {
    let parent = env_of(&[
        ("OSTIA_SOCKET", "/parent.sock"),
        ("OSTIA_TOKEN", "parent-token"),
        ("OSTIA_EXTENSION_ID", "other"),
        ("OSTIA_EXTENSION_DIR", "/other"),
        ("OSTIA_EXTENSION_API", "1.0"),
        ("OSTIA_EXTENSION_DATA", "/other/data"),
    ]);
    let env = extension_environment(&parent, &parts());
    assert_eq!(
        env.get("OSTIA_SOCKET").map(String::as_str),
        Some("/tmp/s.sock")
    );
    assert_eq!(env.get("OSTIA_TOKEN").map(String::as_str), Some("t"));
    assert_eq!(
        env.get("OSTIA_EXTENSION_ID").map(String::as_str),
        Some("agent")
    );
    assert_eq!(
        env.get("OSTIA_EXTENSION_DIR").map(String::as_str),
        Some("/ext/agent")
    );
    assert_eq!(
        env.get("OSTIA_EXTENSION_API").map(String::as_str),
        Some("4.13")
    );
    assert_eq!(
        env.get("OSTIA_EXTENSION_DATA").map(String::as_str),
        Some("/data/agent")
    );
}

#[test]
fn names_the_api_variable_after_the_part_it_is_given() {
    let mut custom = parts();
    custom.api_env_name = "WIRE_API".to_owned();
    let env = extension_environment(&EnvSource::new(), &custom);
    assert_eq!(env.get("OSTIA_WIRE_API").map(String::as_str), Some("4.13"));
    assert_eq!(env.get("OSTIA_EXTENSION_API"), None);
}

#[test]
fn does_not_filter_the_variables_it_adds_itself() {
    let mut custom = parts();
    custom.api_env_name = "VENDOR_API_KEY".to_owned();
    let env = extension_environment(&EnvSource::new(), &custom);
    assert_eq!(
        env.get("OSTIA_VENDOR_API_KEY").map(String::as_str),
        Some("4.13")
    );
}

#[test]
fn leaves_out_the_data_folder_when_the_extension_has_none_or_an_empty_one() {
    let mut none = parts();
    none.data_dir = None;
    assert_eq!(
        extension_environment(&EnvSource::new(), &none).get("OSTIA_EXTENSION_DATA"),
        None
    );
    let mut empty = parts();
    empty.data_dir = Some(String::new());
    assert_eq!(
        extension_environment(&EnvSource::new(), &empty).get("OSTIA_EXTENSION_DATA"),
        None
    );
}

#[test]
fn keeps_the_data_folder_variable_of_the_parent_when_the_extension_has_none() {
    let parent = env_of(&[("OSTIA_EXTENSION_DATA", "/parent/data")]);
    let mut none = parts();
    none.data_dir = None;
    let env = extension_environment(&parent, &none);
    assert_eq!(
        env.get("OSTIA_EXTENSION_DATA").map(String::as_str),
        Some("/parent/data")
    );
}

#[test]
fn removes_only_the_pane_and_start_folder_variables_of_the_app() {
    let parent = env_of(&[
        ("OSTIA_PANE_ID", "p"),
        ("OSTIA_START_DIR", "/x"),
        ("PANE_ID", "plain"),
        ("START_DIR", "plain"),
        ("OSTIA_WORKSPACE_ID", "w"),
        ("OSTIA_OTHER", "o"),
    ]);
    let env = extension_environment(&parent, &parts());
    assert_eq!(env.get("OSTIA_PANE_ID"), None);
    assert_eq!(env.get("OSTIA_START_DIR"), None);
    assert_eq!(env.get("PANE_ID").map(String::as_str), Some("plain"));
    assert_eq!(env.get("START_DIR").map(String::as_str), Some("plain"));
    assert_eq!(env.get("OSTIA_WORKSPACE_ID").map(String::as_str), Some("w"));
    assert_eq!(env.get("OSTIA_OTHER").map(String::as_str), Some("o"));
}

#[test]
fn leaves_the_parent_environment_unchanged() {
    let parent = env_of(&[("PATH", "/usr/bin"), ("OPENAI_API_KEY", "k")]);
    let before = parent.clone();
    let _ = extension_environment(&parent, &parts());
    assert_eq!(parent, before);
}
