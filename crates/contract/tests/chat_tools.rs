#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use indexmap::IndexMap;
use ostia_contract::chat_tools::{
    BUILTIN_TOOL_ACCESS, CHAT_DIRTY_PATHS_MAX, CHAT_LIST_MAX, CHAT_QUERY_MAX, CHAT_READ_FILE_MAX,
    CHAT_READ_LINES_MAX, CHAT_SEARCH_FILE_MAX, CHAT_SEARCH_FILES_MAX, CHAT_SEARCH_MATCHES_MAX,
    CHAT_TOOL_GRANTS_MAX, CHAT_WRITE_MAX, ChatToolAccess, ChatToolSettings, MCP_ENV_MAX,
    MCP_SECRETS_MAX, MCP_SERVERS_MAX, MCP_TOOLS_PER_SERVER_MAX, McpServerSettings,
    McpTransportKind, READ_OUTSIDE_GRANT, SKILL_DESCRIPTION_MAX, SKILL_FILE_MAX, SKILL_NAME,
    SKILLS_MAX, builtin_tool_access, is_mcp_secret_key, is_standing_chat_grant, mcp_tool_name,
    mcp_transport_of, parse_chat_tool_settings, parse_mcp_server,
};
use serde_json::{Value, json};

fn server(raw: Value) -> Option<McpServerSettings> {
    parse_mcp_server(&raw)
}

fn env_pairs(server: &McpServerSettings) -> Vec<(&str, &str)> {
    server
        .env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn url_of_length(length: usize) -> String {
    let prefix = "https://a.example/";
    format!("{prefix}{}", "p".repeat(length - prefix.len()))
}

#[test]
fn accepts_an_argv_server_or_an_http_s_server_never_both_or_neither() {
    assert_eq!(
        server(json!({"name": "fs", "command": ["npx", "-y", "srv"]})),
        Some(McpServerSettings {
            name: "fs".to_owned(),
            enabled: true,
            command: Some(strings(&["npx", "-y", "srv"])),
            url: None,
            env: IndexMap::new(),
            secrets: Vec::new(),
            disabled_tools: Vec::new(),
        })
    );
    assert_eq!(
        server(json!({"name": "web", "url": "https://mcp.example.com/mcp"}))
            .unwrap()
            .url
            .as_deref(),
        Some("https://mcp.example.com/mcp")
    );
    assert_eq!(
        server(json!({"name": "x", "url": "https://a", "command": ["a"]})),
        None
    );
    assert_eq!(server(json!({"name": "x"})), None);
    assert_eq!(
        server(json!({"name": "x", "url": "file:///etc/passwd"})),
        None
    );
    assert_eq!(
        server(json!({"name": "x", "url": "javascript:alert(1)"})),
        None
    );
}

#[test]
fn refuses_a_shell_string_empty_argv_control_characters_and_bad_names() {
    assert_eq!(server(json!({"name": "x", "command": "npx srv"})), None);
    assert_eq!(server(json!({"name": "x", "command": []})), None);
    assert_eq!(server(json!({"name": "x", "command": ["a", "b\nc"]})), None);
    assert_eq!(server(json!({"name": "../x", "command": ["a"]})), None);
    assert_eq!(server(json!({"name": "", "command": ["a"]})), None);
}

#[test]
fn keeps_valid_env_keys_for_argv_servers_and_secret_names_per_transport() {
    let stdio = server(json!({
        "name": "s",
        "command": ["a"],
        "env": {"GOOD": "1", "bad-key": "2", "__proto__": "3", "NUM": 4},
        "secrets": ["TOKEN", "Bad-Header", "TOKEN"],
    }))
    .unwrap();
    assert_eq!(env_pairs(&stdio), vec![("GOOD", "1")]);
    assert_eq!(stdio.secrets, strings(&["TOKEN"]));
    let http = server(json!({
        "name": "h",
        "url": "http://127.0.0.1:1/mcp",
        "env": {"A": "1"},
        "secrets": ["Authorization", "X Bad"],
    }))
    .unwrap();
    assert!(http.env.is_empty());
    assert_eq!(http.secrets, strings(&["Authorization"]));
    assert!(is_mcp_secret_key(McpTransportKind::Stdio, "Authorization"));
    assert!(!is_mcp_secret_key(McpTransportKind::Http, "MY_TOKEN"));
}

#[test]
fn drops_duplicates_caps_the_list_and_keeps_only_absolute_skill_folders() {
    let many: Vec<Value> = (0..MCP_SERVERS_MAX + 3)
        .map(|index| json!({"name": format!("s{index}"), "command": ["a"]}))
        .collect();
    let mut servers = vec![json!({"name": "s0", "command": ["dup"]})];
    servers.extend(many);
    let parsed = parse_chat_tool_settings(&json!({
        "mcpServers": servers,
        "skillFolders": ["/abs/skills", "relative", "/a/../b", "/abs/skills"],
    }));
    assert_eq!(parsed.mcp_servers.len(), MCP_SERVERS_MAX);
    assert_eq!(parsed.mcp_servers[0].command, Some(strings(&["dup"])));
    assert_eq!(parsed.skill_folders, strings(&["/abs/skills"]));
    assert_eq!(
        parse_chat_tool_settings(&Value::Null),
        ChatToolSettings {
            mcp_servers: Vec::new(),
            skill_folders: Vec::new(),
        }
    );
}

#[test]
fn builds_a_provider_safe_name_under_64_chars() {
    assert_eq!(mcp_tool_name("fs", "read.file"), "mcp__fs__read_file");
    assert_eq!(mcp_tool_name("s", &"x".repeat(100)).len(), 64);
}

#[test]
fn replaces_each_utf16_unit_of_a_tool_name_outside_the_safe_set() {
    assert_eq!(mcp_tool_name("fs", "a b/c"), "mcp__fs__a_b_c");
    assert_eq!(mcp_tool_name("fs", "😀"), "mcp__fs____");
    assert_eq!(mcp_tool_name("fs", "é"), "mcp__fs___");
    assert_eq!(
        mcp_tool_name("fs", "keep_this-ok9"),
        "mcp__fs__keep_this-ok9"
    );
}

#[test]
fn cuts_a_long_server_name_and_an_emoji_tool_name_at_64_utf16_units() {
    let long_server = "s".repeat(32);
    let name = mcp_tool_name(&long_server, &"t".repeat(100));
    assert_eq!(name.len(), 64);
    assert!(name.starts_with(&format!("mcp__{long_server}__")));
    assert_eq!(mcp_tool_name("s", &"😀".repeat(40)).len(), 64);
}

#[test]
fn reads_an_empty_url_as_no_url() {
    assert_eq!(server(json!({"name": "x", "url": ""})), None);
    let stdio = server(json!({"name": "x", "url": "", "command": ["a"]})).unwrap();
    assert_eq!(stdio.command, Some(strings(&["a"])));
    assert_eq!(stdio.url, None);
    assert_eq!(mcp_transport_of(&stdio), McpTransportKind::Stdio);
}

#[test]
fn refuses_a_url_or_command_of_the_wrong_type_or_a_null_command() {
    assert_eq!(server(json!({"name": "x", "url": 5})), None);
    assert_eq!(server(json!({"name": "x", "url": null})), None);
    assert_eq!(server(json!({"name": "x", "command": null})), None);
    assert_eq!(
        server(json!({"name": "x", "url": "https://a", "command": null})),
        None
    );
    assert_eq!(server(json!({"name": "x", "command": [1]})), None);
    assert_eq!(server(json!({"name": "x", "command": ["a", null]})), None);
    assert_eq!(server(json!({"name": "x", "command": [""]})), None);
}

#[test]
fn accepts_an_empty_later_argument_and_a_delete_character() {
    let parsed = server(json!({"name": "x", "command": ["a", "", "b\u{7f}"]})).unwrap();
    assert_eq!(parsed.command, Some(strings(&["a", "", "b\u{7f}"])));
}

#[test]
fn refuses_every_control_character_below_space_in_an_argument() {
    for code in [0u32, 9, 10, 13, 27, 31] {
        let arg = format!("a{}b", char::from_u32(code).unwrap());
        assert_eq!(
            server(json!({"name": "x", "command": ["a", arg]})),
            None,
            "code {code}"
        );
    }
    assert!(server(json!({"name": "x", "command": ["a", "a b"]})).is_some());
}

#[test]
fn limits_the_argv_to_64_arguments_of_4096_units() {
    let sixty_four: Vec<String> = (0..64).map(|_| "a".to_owned()).collect();
    assert!(server(json!({"name": "x", "command": sixty_four})).is_some());
    let sixty_five: Vec<String> = (0..65).map(|_| "a".to_owned()).collect();
    assert_eq!(server(json!({"name": "x", "command": sixty_five})), None);
    assert!(server(json!({"name": "x", "command": ["a".repeat(4096)]})).is_some());
    assert_eq!(
        server(json!({"name": "x", "command": ["a".repeat(4097)]})),
        None
    );
    assert!(server(json!({"name": "x", "command": ["😀".repeat(2048)]})).is_some());
    assert_eq!(
        server(json!({"name": "x", "command": ["😀".repeat(2049)]})),
        None
    );
}

#[test]
fn limits_a_url_to_2048_units_and_refuses_text_that_is_not_a_url() {
    assert!(server(json!({"name": "x", "url": url_of_length(2048)})).is_some());
    assert_eq!(
        server(json!({"name": "x", "url": url_of_length(2049)})),
        None
    );
    for url in [
        "not a url",
        "ftp://a/b",
        "mcp.example.com",
        "//a/b",
        "https:",
    ] {
        assert_eq!(server(json!({"name": "x", "url": url})), None, "url {url}");
    }
    assert!(server(json!({"name": "x", "url": "http://localhost:3000/mcp"})).is_some());
}

#[test]
fn limits_the_server_name_to_32_characters_that_start_with_a_letter_or_digit() {
    assert!(server(json!({"name": "a".repeat(32), "command": ["a"]})).is_some());
    assert_eq!(
        server(json!({"name": "a".repeat(33), "command": ["a"]})),
        None
    );
    for name in ["-x", "_x", "x y", "x.y", "x/y", "é", "x\n"] {
        assert_eq!(
            server(json!({"name": name, "command": ["a"]})),
            None,
            "name {name:?}"
        );
    }
    for name in ["0", "A-b_c", "x9"] {
        assert!(
            server(json!({"name": name, "command": ["a"]})).is_some(),
            "name {name:?}"
        );
    }
    assert_eq!(server(json!({"name": 5, "command": ["a"]})), None);
    assert_eq!(server(json!({"command": ["a"]})), None);
}

#[test]
fn refuses_a_value_that_is_not_a_record() {
    for raw in [json!(null), json!("fs"), json!(["fs"]), json!(5)] {
        assert_eq!(server(raw.clone()), None, "raw {raw}");
    }
}

#[test]
fn is_enabled_unless_the_flag_is_false() {
    let off = server(json!({"name": "x", "command": ["a"], "enabled": false})).unwrap();
    assert!(!off.enabled);
    for flag in [json!(true), json!(null), json!(0), json!("no")] {
        let parsed = server(json!({"name": "x", "command": ["a"], "enabled": flag})).unwrap();
        assert!(parsed.enabled, "flag {flag}");
    }
}

#[test]
fn keeps_at_most_32_env_entries_in_order_and_drops_values_over_4096_units() {
    let mut env = serde_json::Map::new();
    for index in 0..40 {
        env.insert(format!("K{index}"), json!("v"));
    }
    let parsed = server(json!({"name": "x", "command": ["a"], "env": env})).unwrap();
    let keys: Vec<&str> = parsed.env.keys().map(String::as_str).collect();
    assert_eq!(keys.len(), MCP_ENV_MAX);
    assert_eq!(keys[0], "K0");
    assert_eq!(keys[MCP_ENV_MAX - 1], "K31");

    let sized = server(json!({
        "name": "x",
        "command": ["a"],
        "env": {"OK": "v".repeat(4096), "BIG": "v".repeat(4097), "EMPTY": ""},
    }))
    .unwrap();
    assert_eq!(
        sized.env.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["OK", "EMPTY"]
    );
}

#[test]
fn skips_a_bad_env_entry_without_counting_it_toward_the_cap() {
    let mut env = serde_json::Map::new();
    for index in 0..MCP_ENV_MAX {
        env.insert(format!("bad-{index}"), json!("v"));
        env.insert(format!("K{index}"), json!("v"));
    }
    let parsed = server(json!({"name": "x", "command": ["a"], "env": env})).unwrap();
    assert_eq!(parsed.env.len(), MCP_ENV_MAX);
}

#[test]
fn refuses_dangerous_and_malformed_env_keys() {
    let parsed = server(json!({
        "name": "x",
        "command": ["a"],
        "env": {"constructor": "1", "prototype": "1", "1A": "1", "_ok": "1", "A9_": "1"},
    }))
    .unwrap();
    assert_eq!(env_pairs(&parsed), vec![("_ok", "1"), ("A9_", "1")]);
}

#[test]
fn ignores_an_env_that_is_not_a_record() {
    for env in [json!(["A"]), json!("A=1"), json!(null)] {
        let parsed = server(json!({"name": "x", "command": ["a"], "env": env})).unwrap();
        assert!(parsed.env.is_empty());
    }
}

#[test]
fn keeps_at_most_8_secrets_without_duplicates_and_only_strings() {
    let secrets: Vec<String> = (0..12).map(|index| format!("S{index}")).collect();
    let parsed = server(json!({"name": "x", "command": ["a"], "secrets": secrets})).unwrap();
    assert_eq!(parsed.secrets.len(), MCP_SECRETS_MAX);
    assert_eq!(parsed.secrets[0], "S0");

    let mixed = server(json!({
        "name": "x",
        "command": ["a"],
        "secrets": [1, null, "A", "A", ["B"], "B"],
    }))
    .unwrap();
    assert_eq!(mixed.secrets, strings(&["A", "B"]));
    let not_a_list = server(json!({"name": "x", "command": ["a"], "secrets": "A"})).unwrap();
    assert!(not_a_list.secrets.is_empty());
}

#[test]
fn counts_secrets_toward_the_cap_only_when_they_are_valid() {
    let mut secrets: Vec<String> = (0..10).map(|index| format!("bad-{index}")).collect();
    secrets.extend((0..MCP_SECRETS_MAX).map(|index| format!("S{index}")));
    let parsed = server(json!({"name": "x", "command": ["a"], "secrets": secrets})).unwrap();
    assert_eq!(parsed.secrets.len(), MCP_SECRETS_MAX);
}

#[test]
fn checks_secret_names_by_transport() {
    let cases = [
        (McpTransportKind::Http, "X-Api-Key", true),
        (McpTransportKind::Http, "Authorization", true),
        (McpTransportKind::Http, "Bad Header", false),
        (McpTransportKind::Http, "-x", false),
        (McpTransportKind::Http, "constructor", false),
        (McpTransportKind::Http, "", false),
        (McpTransportKind::Http, &"a".repeat(64), true),
        (McpTransportKind::Http, &"a".repeat(65), false),
        (McpTransportKind::Stdio, "MY_TOKEN", true),
        (McpTransportKind::Stdio, "_x", true),
        (McpTransportKind::Stdio, "1A", false),
        (McpTransportKind::Stdio, "X-Api-Key", false),
        (McpTransportKind::Stdio, "__proto__", false),
        (McpTransportKind::Stdio, "prototype", false),
        (McpTransportKind::Stdio, &"a".repeat(64), true),
        (McpTransportKind::Stdio, &"a".repeat(65), false),
    ];
    for (transport, key, expected) in cases {
        assert_eq!(
            is_mcp_secret_key(transport, key),
            expected,
            "{transport:?} {key}"
        );
    }
}

#[test]
fn keeps_disabled_tools_as_unique_strings_up_to_128_units_and_256_entries() {
    let tools: Vec<String> = (0..300).map(|index| format!("t{index}")).collect();
    let parsed = server(json!({"name": "x", "command": ["a"], "disabledTools": tools})).unwrap();
    assert_eq!(parsed.disabled_tools.len(), MCP_TOOLS_PER_SERVER_MAX * 4);
    assert_eq!(parsed.disabled_tools[255], "t255");

    let mixed = server(json!({
        "name": "x",
        "command": ["a"],
        "disabledTools": ["a", "a", 1, null, "b".repeat(128), "c".repeat(129), "", ""],
    }))
    .unwrap();
    assert_eq!(
        mixed.disabled_tools,
        vec!["a".to_owned(), "b".repeat(128), String::new()]
    );
    let not_a_list = server(json!({"name": "x", "command": ["a"], "disabledTools": "a"})).unwrap();
    assert!(not_a_list.disabled_tools.is_empty());
}

#[test]
fn names_the_transport_by_whether_the_url_is_set() {
    let http = server(json!({"name": "h", "url": "https://a.example/mcp"})).unwrap();
    assert_eq!(mcp_transport_of(&http), McpTransportKind::Http);
    let stdio = server(json!({"name": "s", "command": ["a"]})).unwrap();
    assert_eq!(mcp_transport_of(&stdio), McpTransportKind::Stdio);
}

#[test]
fn stores_exactly_one_of_url_and_command() {
    let http = server(json!({"name": "h", "url": "https://a.example/mcp"})).unwrap();
    assert_eq!(http.command, None);
    let stdio = server(json!({"name": "s", "command": ["a"]})).unwrap();
    assert_eq!(stdio.url, None);
}

#[test]
fn skips_a_bad_server_without_counting_it_and_keeps_the_first_of_a_name() {
    let parsed = parse_chat_tool_settings(&json!({
        "mcpServers": [
            {"name": "bad name", "command": ["a"]},
            "text",
            {"name": "a", "command": ["one"]},
            {"name": "a", "url": "https://a.example/mcp"},
            {"name": "b", "url": "https://b.example/mcp"},
        ],
    }));
    let names: Vec<&str> = parsed
        .mcp_servers
        .iter()
        .map(|server| server.name.as_str())
        .collect();
    assert_eq!(names, vec!["a", "b"]);
    assert_eq!(parsed.mcp_servers[0].command, Some(strings(&["one"])));
}

#[test]
fn reads_empty_settings_from_a_value_that_is_not_a_record_or_has_wrong_field_types() {
    let empty = ChatToolSettings::default();
    assert_eq!(parse_chat_tool_settings(&json!("x")), empty);
    assert_eq!(parse_chat_tool_settings(&json!([])), empty);
    assert_eq!(
        parse_chat_tool_settings(&json!({"mcpServers": "x", "skillFolders": 5})),
        empty
    );
    assert_eq!(parse_chat_tool_settings(&json!({})), empty);
}

#[test]
fn caps_skill_folders_at_32_and_ignores_values_that_are_not_strings() {
    let folders: Vec<String> = (0..40).map(|index| format!("/skills/{index}")).collect();
    let parsed = parse_chat_tool_settings(&json!({"skillFolders": folders}));
    assert_eq!(parsed.skill_folders.len(), 32);
    assert_eq!(parsed.skill_folders[31], "/skills/31");
    let mixed = parse_chat_tool_settings(&json!({"skillFolders": [1, null, "/a", "/a", "/b/..c"]}));
    assert_eq!(mixed.skill_folders, strings(&["/a", "/b/..c"]));
}

#[test]
fn lists_the_default_settings_as_empty() {
    let defaults = ChatToolSettings::default();
    assert!(defaults.mcp_servers.is_empty());
    assert!(defaults.skill_folders.is_empty());
}

#[test]
fn gives_each_built_in_tool_its_access_level() {
    let expected = [
        ("read_file", ChatToolAccess::Read),
        ("list_directory", ChatToolAccess::Read),
        ("search_files", ChatToolAccess::Read),
        ("terminal_context", ChatToolAccess::Read),
        ("git_status", ChatToolAccess::Read),
        ("load_skill", ChatToolAccess::Read),
        ("propose_command", ChatToolAccess::Command),
        ("edit_file", ChatToolAccess::Write),
        ("write_file", ChatToolAccess::Write),
        ("open_file", ChatToolAccess::Act),
        ("open_url", ChatToolAccess::Act),
    ];
    assert_eq!(BUILTIN_TOOL_ACCESS.len(), expected.len());
    for (name, access) in expected {
        assert_eq!(builtin_tool_access(name), Some(access), "tool {name}");
    }
    for name in ["", "mcp__fs__x", "Read_File", "toString", "constructor"] {
        assert_eq!(builtin_tool_access(name), None, "tool {name}");
    }
}

#[test]
fn grants_standing_approval_to_act_tools_mcp_tools_and_the_read_outside_key_only() {
    assert_eq!(READ_OUTSIDE_GRANT, "read-outside");
    let allowed = [
        "read-outside",
        "open_file",
        "open_url",
        "mcp__fs__read",
        "mcp__x",
        "mcp__",
        &format!("mcp__{}", "a".repeat(59)),
    ];
    for key in allowed {
        assert!(is_standing_chat_grant(key), "key {key}");
    }
    let refused = [
        "read_file",
        "write_file",
        "edit_file",
        "propose_command",
        "load_skill",
        "git_status",
        "fs__read",
        "mcp_fs__read",
        "mcp__bad name",
        "mcp__a.b",
        "",
        "Read-Outside",
        &format!("mcp__{}", "a".repeat(60)),
    ];
    for key in refused {
        assert!(!is_standing_chat_grant(key), "key {key}");
    }
}

#[test]
fn keeps_the_limits_the_tools_and_the_ui_share() {
    assert_eq!(MCP_SERVERS_MAX, 16);
    assert_eq!(MCP_ENV_MAX, 32);
    assert_eq!(MCP_SECRETS_MAX, 8);
    assert_eq!(MCP_TOOLS_PER_SERVER_MAX, 64);
    assert_eq!(SKILL_FILE_MAX, 256 * 1024);
    assert_eq!(SKILL_DESCRIPTION_MAX, 1024);
    assert_eq!(SKILLS_MAX, 128);
    assert_eq!(CHAT_TOOL_GRANTS_MAX, 256);
    assert_eq!(CHAT_READ_LINES_MAX, 2000);
    assert_eq!(CHAT_LIST_MAX, 500);
    assert_eq!(CHAT_SEARCH_MATCHES_MAX, 100);
    assert_eq!(CHAT_SEARCH_FILES_MAX, 5000);
    assert_eq!(CHAT_SEARCH_FILE_MAX, 1024 * 1024);
    assert_eq!(CHAT_READ_FILE_MAX, 4 * 1024 * 1024);
    assert_eq!(CHAT_WRITE_MAX, 1024 * 1024);
    assert_eq!(CHAT_QUERY_MAX, 200);
    assert_eq!(CHAT_DIRTY_PATHS_MAX, 256);
}

#[test]
fn names_a_skill_with_a_letter_or_digit_first_and_at_most_64_characters() {
    for name in ["a", "Z9", "my.skill-1_x", &"a".repeat(64)] {
        assert!(SKILL_NAME.is_match(name), "name {name}");
    }
    for name in [
        "",
        ".x",
        "-x",
        "_x",
        "a b",
        "a/b",
        "é",
        "a\n",
        &"a".repeat(65),
    ] {
        assert!(!SKILL_NAME.is_match(name), "name {name:?}");
    }
}
