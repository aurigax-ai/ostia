use indexmap::IndexMap;
use ostia_contract::chat_tools::{McpServerSettings, McpTransportKind, SkillSummary};
use ostia_model::assist::mcp_server_form::{
    KeyValueRow, McpDraftField, McpDraftResult, McpServerDraft, SecretDraft, draft_from_server,
    new_row, server_from_draft, skills_in_folder,
};

fn map(entries: &[(&str, &str)]) -> IndexMap<String, String> {
    entries
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

fn draft() -> McpServerDraft {
    draft_from_server(None)
}

fn env_row(key: &str, value: &str) -> KeyValueRow {
    KeyValueRow {
        key: key.to_owned(),
        value: value.to_owned(),
        ..new_row()
    }
}

fn secret(key: &str, value: &str, saved: bool) -> SecretDraft {
    let row = new_row();
    SecretDraft {
        id: row.id,
        key: key.to_owned(),
        value: value.to_owned(),
        saved,
    }
}

fn github() -> McpServerSettings {
    McpServerSettings {
        name: "github".to_owned(),
        enabled: false,
        command: Some(strings(&["npx", "-y", "server github"])),
        url: None,
        env: map(&[("API_HOST", "x")]),
        secrets: strings(&["GITHUB_TOKEN"]),
        disabled_tools: strings(&["delete_repo"]),
    }
}

fn errors_of(result: McpDraftResult) -> Vec<McpDraftField> {
    match result {
        McpDraftResult::Invalid { errors } => errors,
        McpDraftResult::Valid { .. } => panic!("expected errors"),
    }
}

fn server_of(result: McpDraftResult) -> McpServerSettings {
    match result {
        McpDraftResult::Valid { server, .. } => server,
        McpDraftResult::Invalid { errors } => panic!("{errors:?}"),
    }
}

fn stdio(command: &str, args: &str) -> McpServerDraft {
    McpServerDraft {
        name: "srv".to_owned(),
        command: command.to_owned(),
        args: args.to_owned(),
        ..draft()
    }
}

fn http(url: &str) -> McpServerDraft {
    McpServerDraft {
        name: "remote".to_owned(),
        transport: McpTransportKind::Http,
        url: url.to_owned(),
        ..draft()
    }
}

#[test]
fn builds_a_command_server_from_a_program_and_quoted_arguments() {
    let res = server_from_draft(
        &McpServerDraft {
            name: " fs ".to_owned(),
            command: "npx".to_owned(),
            args: "-y '@scope/server fs'".to_owned(),
            ..draft()
        },
        None,
        &[],
    );
    assert_eq!(
        res,
        McpDraftResult::Valid {
            server: McpServerSettings {
                name: "fs".to_owned(),
                enabled: true,
                command: Some(strings(&["npx", "-y", "@scope/server fs"])),
                url: None,
                env: IndexMap::new(),
                secrets: Vec::new(),
                disabled_tools: Vec::new(),
            },
            secret_values: IndexMap::new(),
            removed_secrets: Vec::new(),
        }
    );
}

#[test]
fn names_every_invalid_field_at_once() {
    let res = server_from_draft(
        &McpServerDraft {
            name: "bad name".to_owned(),
            command: String::new(),
            args: "'open".to_owned(),
            env: vec![env_row("1BAD", "v")],
            secrets: vec![secret("TOKEN", "", false)],
            ..draft()
        },
        None,
        &[],
    );
    assert_eq!(
        res,
        McpDraftResult::Invalid {
            errors: vec![
                McpDraftField::Name,
                McpDraftField::Command,
                McpDraftField::Args,
                McpDraftField::Env,
                McpDraftField::Secrets,
            ]
        }
    );
}

#[test]
fn refuses_a_name_that_is_already_used_and_a_url_that_is_not_http_s() {
    let res = server_from_draft(
        &McpServerDraft {
            name: "github".to_owned(),
            ..http("ftp://example.com")
        },
        None,
        &strings(&["github"]),
    );
    assert_eq!(
        res,
        McpDraftResult::Invalid {
            errors: vec![McpDraftField::Name, McpDraftField::Url]
        }
    );
}

#[test]
fn builds_a_url_server_whose_secrets_are_headers_and_ignores_blank_rows() {
    let res = server_from_draft(
        &McpServerDraft {
            env: vec![env_row("IGNORED", "x")],
            secrets: vec![
                secret("Authorization", "Bearer t", false),
                secret("", "", false),
            ],
            ..http("https://example.com/mcp")
        },
        None,
        &[],
    );
    let McpDraftResult::Valid {
        server,
        secret_values,
        ..
    } = res
    else {
        panic!("expected a server")
    };
    assert_eq!(server.name, "remote");
    assert_eq!(server.url.as_deref(), Some("https://example.com/mcp"));
    assert_eq!(server.command, None);
    assert!(server.env.is_empty());
    assert_eq!(server.secrets, strings(&["Authorization"]));
    assert_eq!(secret_values, map(&[("Authorization", "Bearer t")]));
}

#[test]
fn keeps_the_name_switch_and_disabled_tools_when_editing_and_reports_removed_secrets() {
    assert_eq!(
        draft_from_server(Some(&github())).args,
        "-y 'server github'"
    );
    let edited = McpServerDraft {
        secrets: Vec::new(),
        args: "-y other".to_owned(),
        ..draft_from_server(Some(&github()))
    };
    let res = server_from_draft(&edited, Some(&github()), &strings(&["github"]));
    assert_eq!(
        res,
        McpDraftResult::Valid {
            server: McpServerSettings {
                name: "github".to_owned(),
                enabled: false,
                command: Some(strings(&["npx", "-y", "other"])),
                url: None,
                env: map(&[("API_HOST", "x")]),
                secrets: Vec::new(),
                disabled_tools: strings(&["delete_repo"]),
            },
            secret_values: IndexMap::new(),
            removed_secrets: strings(&["GITHUB_TOKEN"]),
        }
    );
}

#[test]
fn keeps_a_saved_secret_without_a_new_value_and_sends_only_replaced_values() {
    let mut edited = draft_from_server(Some(&github()));
    let McpDraftResult::Valid {
        server,
        secret_values,
        ..
    } = server_from_draft(&edited, Some(&github()), &strings(&["github"]))
    else {
        panic!("expected a server")
    };
    assert_eq!(server.secrets, strings(&["GITHUB_TOKEN"]));
    assert!(secret_values.is_empty());
    edited.secrets[0].value = "new".to_owned();
    let McpDraftResult::Valid { secret_values, .. } =
        server_from_draft(&edited, Some(&github()), &strings(&["github"]))
    else {
        panic!("expected a server")
    };
    assert_eq!(secret_values, map(&[("GITHUB_TOKEN", "new")]));
}

#[test]
fn refuses_duplicate_environment_names() {
    let res = server_from_draft(
        &McpServerDraft {
            env: vec![env_row("A", "1"), env_row("A", "2")],
            ..stdio("srv", "")
        },
        None,
        &[],
    );
    assert_eq!(errors_of(res), vec![McpDraftField::Env]);
}

#[test]
fn matches_skills_inside_the_folder_only_not_a_sibling_with_the_same_prefix() {
    let skill = |name: &str, path: &str| SkillSummary {
        name: name.to_owned(),
        description: String::new(),
        path: path.to_owned(),
    };
    let skills = [
        skill("a", "/s/a/SKILL.md"),
        skill("b", "/s2/b/SKILL.md"),
        skill("c", "/s"),
    ];
    let names: Vec<String> = skills_in_folder(&skills, "/s")
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, strings(&["a", "c"]));
}

#[test]
fn ignores_trailing_slashes_on_the_folder() {
    let skill = |name: &str, path: &str| SkillSummary {
        name: name.to_owned(),
        description: String::new(),
        path: path.to_owned(),
    };
    let skills = [skill("a", "/s/a/SKILL.md"), skill("b", "/s2/b/SKILL.md")];
    let names: Vec<String> = skills_in_folder(&skills, "/s//")
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, strings(&["a"]));
}

#[test]
fn starts_a_new_draft_as_an_empty_command_server() {
    let fresh = draft();
    assert_eq!(fresh.name, "");
    assert_eq!(fresh.transport, McpTransportKind::Stdio);
    assert_eq!(fresh.command, "");
    assert_eq!(fresh.args, "");
    assert_eq!(fresh.url, "");
    assert!(fresh.env.is_empty());
    assert!(fresh.secrets.is_empty());
}

#[test]
fn gives_each_new_row_its_own_id() {
    let first = new_row();
    let second = new_row();
    assert_ne!(first.id, second.id);
    assert_eq!((first.key.as_str(), first.value.as_str()), ("", ""));
}

#[test]
fn fills_a_draft_from_a_url_server_with_saved_secrets_and_env_rows_in_order() {
    let server = McpServerSettings {
        name: "remote".to_owned(),
        enabled: true,
        command: None,
        url: Some("https://example.com/mcp".to_owned()),
        env: map(&[("B", "2"), ("A", "1")]),
        secrets: strings(&["Authorization"]),
        disabled_tools: Vec::new(),
    };
    let filled = draft_from_server(Some(&server));
    assert_eq!(filled.transport, McpTransportKind::Http);
    assert_eq!(filled.url, "https://example.com/mcp");
    assert_eq!(filled.command, "");
    assert_eq!(filled.args, "");
    let env: Vec<(&str, &str)> = filled
        .env
        .iter()
        .map(|row| (row.key.as_str(), row.value.as_str()))
        .collect();
    assert_eq!(env, vec![("B", "2"), ("A", "1")]);
    assert_eq!(filled.secrets.len(), 1);
    assert_eq!(filled.secrets[0].key, "Authorization");
    assert!(filled.secrets[0].saved);
}

#[test]
fn asks_for_a_command_when_it_is_blank_and_still_reads_the_arguments() {
    assert_eq!(
        errors_of(server_from_draft(&stdio("  ", "-y x"), None, &[])),
        vec![McpDraftField::Command]
    );
}

#[test]
fn refuses_more_than_64_arguments_and_an_argument_with_a_control_character() {
    let many = (0..64)
        .map(|i| format!("a{i}"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(
        errors_of(server_from_draft(&stdio("srv", &many), None, &[])),
        vec![McpDraftField::Args]
    );
    assert_eq!(
        errors_of(server_from_draft(&stdio("srv", "a\u{1}b"), None, &[])),
        vec![McpDraftField::Args]
    );
    assert_eq!(
        server_of(server_from_draft(&stdio("srv", "a b"), None, &[])).command,
        Some(strings(&["srv", "a", "b"]))
    );
}

#[test]
fn refuses_a_name_that_is_empty_too_long_or_starts_with_a_dash() {
    let too_long = "n".repeat(33);
    for name in ["", too_long.as_str(), "-fs"] {
        let res = server_from_draft(
            &McpServerDraft {
                name: name.to_owned(),
                ..stdio("srv", "")
            },
            None,
            &[],
        );
        assert_eq!(errors_of(res), vec![McpDraftField::Name], "{name:?}");
    }
    let ok = server_from_draft(
        &McpServerDraft {
            name: "n".repeat(32),
            ..stdio("srv", "")
        },
        None,
        &[],
    );
    assert_eq!(server_of(ok).name, "n".repeat(32));
}

#[test]
fn refuses_an_environment_name_that_is_dangerous_and_one_past_the_cap() {
    let dangerous = McpServerDraft {
        env: vec![env_row("__proto__", "x")],
        ..stdio("srv", "")
    };
    assert_eq!(
        errors_of(server_from_draft(&dangerous, None, &[])),
        vec![McpDraftField::Env]
    );
    let rows = |count: usize| -> Vec<KeyValueRow> {
        (0..count).map(|i| env_row(&format!("K{i}"), "v")).collect()
    };
    let full = McpServerDraft {
        env: rows(32),
        ..stdio("srv", "")
    };
    assert_eq!(server_of(server_from_draft(&full, None, &[])).env.len(), 32);
    let over = McpServerDraft {
        env: rows(33),
        ..stdio("srv", "")
    };
    assert_eq!(
        errors_of(server_from_draft(&over, None, &[])),
        vec![McpDraftField::Env]
    );
}

#[test]
fn skips_blank_environment_rows_and_trims_the_name_of_the_others() {
    let res = server_from_draft(
        &McpServerDraft {
            env: vec![env_row("", ""), env_row(" HOME_DIR ", "/h")],
            ..stdio("srv", "")
        },
        None,
        &[],
    );
    assert_eq!(server_of(res).env, map(&[("HOME_DIR", "/h")]));
}

#[test]
fn refuses_a_url_that_is_too_long_or_blank() {
    let long = format!("https://example.com/{}", "a".repeat(2048));
    assert_eq!(
        errors_of(server_from_draft(&http(&long), None, &[])),
        vec![McpDraftField::Url]
    );
    assert_eq!(
        errors_of(server_from_draft(&http("  "), None, &[])),
        vec![McpDraftField::Url]
    );
    assert_eq!(
        server_of(server_from_draft(
            &http("  http://localhost:8080/mcp "),
            None,
            &[]
        ))
        .url,
        Some("http://localhost:8080/mcp".to_owned())
    );
}

#[test]
fn checks_a_secret_key_as_an_environment_name_for_commands_and_as_a_header_for_urls() {
    let for_command = |key: &str| McpServerDraft {
        secrets: vec![secret(key, "v", false)],
        ..stdio("srv", "")
    };
    assert_eq!(
        errors_of(server_from_draft(&for_command("Bad-Key"), None, &[])),
        vec![McpDraftField::Secrets]
    );
    assert!(matches!(
        server_from_draft(&for_command("GOOD_KEY"), None, &[]),
        McpDraftResult::Valid { .. }
    ));
    let for_url = |key: &str| McpServerDraft {
        secrets: vec![secret(key, "v", false)],
        ..http("https://example.com/mcp")
    };
    assert!(matches!(
        server_from_draft(&for_url("X-Api-Key"), None, &[]),
        McpDraftResult::Valid { .. }
    ));
    assert_eq!(
        errors_of(server_from_draft(&for_url("bad header"), None, &[])),
        vec![McpDraftField::Secrets]
    );
}

#[test]
fn refuses_duplicate_secrets_a_new_secret_without_a_value_and_more_than_eight() {
    let with = |rows: Vec<SecretDraft>| McpServerDraft {
        secrets: rows,
        ..stdio("srv", "")
    };
    assert_eq!(
        errors_of(server_from_draft(
            &with(vec![secret("A", "1", false), secret("A", "2", false)]),
            None,
            &[]
        )),
        vec![McpDraftField::Secrets]
    );
    assert_eq!(
        errors_of(server_from_draft(
            &with(vec![secret("A", "", false)]),
            None,
            &[]
        )),
        vec![McpDraftField::Secrets]
    );
    let rows = |count: usize| -> Vec<SecretDraft> {
        (0..count)
            .map(|i| secret(&format!("S{i}"), "v", false))
            .collect()
    };
    assert_eq!(
        server_of(server_from_draft(&with(rows(8)), None, &[]))
            .secrets
            .len(),
        8
    );
    assert_eq!(
        errors_of(server_from_draft(&with(rows(9)), None, &[])),
        vec![McpDraftField::Secrets]
    );
}

#[test]
fn refuses_a_saved_secret_whose_key_was_cleared() {
    let edited = McpServerDraft {
        secrets: vec![secret("", "", true)],
        ..draft_from_server(Some(&github()))
    };
    assert_eq!(
        errors_of(server_from_draft(&edited, Some(&github()), &[])),
        vec![McpDraftField::Secrets]
    );
}

#[test]
fn keeps_the_original_name_when_editing_even_if_the_draft_name_is_bad_or_taken() {
    let edited = McpServerDraft {
        name: "bad name".to_owned(),
        ..draft_from_server(Some(&github()))
    };
    let res = server_from_draft(&edited, Some(&github()), &strings(&["github"]));
    assert_eq!(server_of(res).name, "github");
}

#[test]
fn edits_a_url_server_and_keeps_it_enabled_by_default() {
    let remote = McpServerSettings {
        name: "remote".to_owned(),
        enabled: true,
        command: None,
        url: Some("https://example.com/mcp".to_owned()),
        env: IndexMap::new(),
        secrets: Vec::new(),
        disabled_tools: strings(&["x"]),
    };
    let edited = McpServerDraft {
        url: "https://example.com/v2".to_owned(),
        ..draft_from_server(Some(&remote))
    };
    let server = server_of(server_from_draft(&edited, Some(&remote), &[]));
    assert_eq!(server.url.as_deref(), Some("https://example.com/v2"));
    assert!(server.enabled);
    assert_eq!(server.disabled_tools, strings(&["x"]));
}
