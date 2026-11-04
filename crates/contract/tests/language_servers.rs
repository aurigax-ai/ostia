#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_contract::capabilities::Capability;
use ostia_contract::language_server_config::{
    configuration_section, document_language_id, overlay_settings, substitute_json,
};
use ostia_contract::language_server_manifest::{
    LanguageServerParseOptions, download_url_problem, parse_language_servers,
};
use ostia_contract::language_servers::{
    LanguageServerNodeRun, LanguageServerOverride, LanguageServerOverrideProblem,
    LanguageServerProgramRun, LanguageServerRun, SERVER_JSON_MAX_BYTES, language_server_command,
    language_server_summary, parse_language_server_override, split_language_server_key,
};
use regex::Regex;
use serde_json::{Map, Value, json};

fn is_inside(path: &str) -> bool {
    !path.starts_with("..") && !path.starts_with('/')
}

fn options() -> LanguageServerParseOptions<'static> {
    LanguageServerParseOptions {
        is_inside: &is_inside,
        capabilities: &[Capability::LanguageServer],
        setting_keys: &["mode"],
    }
}

fn server(extra: Value) -> Value {
    let mut base = json!({
        "id": "demo",
        "name": "Demo",
        "languages": ["python"],
        "run": {"node": "server/main.js"},
    });
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

fn parse(list: &[Value], options: &LanguageServerParseOptions) -> Value {
    serde_json::to_value(
        parse_language_servers(Some(&Value::Array(list.to_vec())), options).unwrap(),
    )
    .unwrap()
}

fn refusal(list: &[Value], options: &LanguageServerParseOptions) -> String {
    parse_language_servers(Some(&Value::Array(list.to_vec())), options)
        .err()
        .unwrap_or_default()
}

fn problem(extra: Value) -> String {
    refusal(&[server(extra)], &options())
}

fn matches(text: &str, pattern: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}

fn is_subset(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(have), Value::Object(want)) => want
            .iter()
            .all(|(key, item)| have.get(key).is_some_and(|found| is_subset(found, item))),
        (Value::Array(have), Value::Array(want)) => {
            have.len() == want.len()
                && have
                    .iter()
                    .zip(want)
                    .all(|(found, item)| is_subset(found, item))
        }
        _ => actual == expected,
    }
}

fn assert_subset(actual: &Value, expected: &Value) {
    assert!(is_subset(actual, expected), "{actual} vs {expected}");
}

#[test]
fn fills_defaults_for_a_bundled_server_and_keeps_a_program_servers_package() {
    let parsed = parse(
        &[
            server(json!({})),
            json!({
                "id": "native",
                "name": "Native",
                "languages": ["c", "cpp", "c"],
                "run": {"program": "clangd", "package": "clang", "args": ["--log=error"]},
                "rootMarkers": ["compile_commands.json"],
            }),
        ],
        &options(),
    );
    assert_eq!(
        parsed,
        json!([
            {
                "id": "demo",
                "name": "Demo",
                "languages": ["python"],
                "run": {"node": "server/main.js", "args": []},
                "rootMarkers": [],
            },
            {
                "id": "native",
                "name": "Native",
                "languages": ["c", "cpp"],
                "run": {"program": "clangd", "package": "clang", "args": ["--log=error"]},
                "rootMarkers": ["compile_commands.json"],
            },
        ])
    );
}

#[test]
fn needs_the_language_server_capability_but_not_for_an_empty_list() {
    let without = LanguageServerParseOptions {
        capabilities: &[],
        ..options()
    };
    assert_eq!(
        refusal(&[server(json!({}))], &without),
        "contributes.languageServers needs the 'language-server' capability"
    );
    assert!(
        parse_language_servers(Some(&json!([])), &without)
            .unwrap()
            .is_empty()
    );
    assert!(parse_language_servers(None, &without).unwrap().is_empty());
}

#[test]
fn allows_at_most_eight_servers_with_unique_ids() {
    let nine: Vec<Value> = (0..9)
        .map(|index| server(json!({"id": format!("s{index}")})))
        .collect();
    assert!(matches(&refusal(&nine, &options()), "at most 8"));
    assert!(matches(
        &refusal(&[server(json!({})), server(json!({}))], &options()),
        "duplicate id 'demo'"
    ));
}

#[test]
fn refuses_a_bad_id_name_or_language_list() {
    assert!(matches(&problem(json!({"id": "Bad Id"})), "invalid id"));
    assert!(matches(
        &problem(json!({"name": ""})),
        "name must be 1-200 characters"
    ));
    assert!(matches(
        &problem(json!({"name": "x".repeat(201)})),
        "name must be"
    ));
    assert!(matches(
        &problem(json!({"languages": []})),
        "1-16 editor language ids"
    ));
    assert!(matches(
        &problem(json!({"languages": ["Python"]})),
        "editor language ids"
    ));
    let many: Vec<String> = (0..17).map(|index| format!("l{index}")).collect();
    assert!(matches(&problem(json!({"languages": many})), "1-16"));
}

#[test]
fn takes_exactly_one_run_form_a_script_inside_the_extension_or_a_bare_program_name() {
    let cases = [
        (
            json!({"run": {}}),
            "exactly one of node, program, download or goInstall",
        ),
        (
            json!({"run": {"node": "a.js", "program": "a"}}),
            "exactly one",
        ),
        (
            json!({"run": {"node": "../outside.js"}}),
            "inside the extension",
        ),
        (
            json!({"run": {"node": "server.py"}}),
            r"\.js, \.mjs or \.cjs",
        ),
        (
            json!({"run": {"node": "a.js", "package": "x"}}),
            "package is not allowed",
        ),
        (
            json!({"run": {"program": "/usr/bin/clangd"}}),
            "without a path",
        ),
        (json!({"run": {"program": "a b"}}), "without a path"),
        (
            json!({"run": {"program": "clangd", "package": "bad/name"}}),
            "package name",
        ),
        (
            json!({"run": {"program": "clangd", "shell": true}}),
            "shell is not allowed",
        ),
    ];
    for (extra, expected) in cases {
        let text = problem(extra.clone());
        assert!(matches(&text, expected), "{extra}: {text}");
    }
    assert_eq!(problem(json!({"run": {"node": "main.mjs"}})), "");
    assert_eq!(problem(json!({"run": {"node": "main.cjs"}})), "");
}

#[test]
fn limits_arguments_to_32_strings_of_200_characters() {
    assert!(matches(
        &problem(json!({"run": {"program": "x", "args": vec!["a"; 33]}})),
        "at most 32"
    ));
    assert!(matches(
        &problem(json!({"run": {"program": "x", "args": ["a".repeat(201)]}})),
        "200 characters"
    ));
    assert!(matches(
        &problem(json!({"run": {"program": "x", "args": [1]}})),
        "strings"
    ));
}

#[test]
fn takes_root_markers_as_plain_file_names() {
    assert!(matches(
        &problem(json!({"rootMarkers": ["a/b"]})),
        "file names"
    ));
    assert!(matches(
        &problem(json!({"rootMarkers": [".."]})),
        "file names"
    ));
    let many: Vec<String> = (0..17).map(|index| format!("m{index}")).collect();
    assert!(matches(&problem(json!({"rootMarkers": many})), "16"));
    assert_eq!(problem(json!({"rootMarkers": [".git", "go.mod"]})), "");
}

#[test]
fn maps_editor_language_ids_and_file_suffixes_to_document_language_ids() {
    assert_eq!(
        problem(
            json!({"documentLanguageIds": {"shell": "shellscript", ".tsx": "typescriptreact"}})
        ),
        ""
    );
    assert!(matches(
        &problem(json!({"documentLanguageIds": {"Not An Id": "x"}})),
        "editor language id"
    ));
    assert!(matches(
        &problem(json!({"documentLanguageIds": {"shell": "has space"}})),
        "language id"
    ));
    assert!(matches(
        &problem(json!({"documentLanguageIds": []})),
        "must be an object"
    ));
}

#[test]
fn keeps_initialization_options_and_settings_as_json_without_prototype_keys_up_to_16_kib() {
    let initialization: Value =
        serde_json::from_str(r#"{"a":{"__proto__":{"x":1},"b":[1,"two",null]}}"#).unwrap();
    let parsed = parse(
        &[server(json!({
            "initializationOptions": initialization,
            "settings": {"python": {"analysis": {"mode": "standard"}}},
        }))],
        &options(),
    );
    assert_subset(
        &parsed,
        &json!([{
            "initializationOptions": {"a": {"b": [1, "two", null]}},
            "settings": {"python": {"analysis": {"mode": "standard"}}},
        }]),
    );
    assert!(
        parsed[0]["initializationOptions"]["a"]
            .get("__proto__")
            .is_none()
    );
    assert!(matches(
        &problem(json!({"settings": {"big": "x".repeat(SERVER_JSON_MAX_BYTES)}})),
        "larger than 16384 bytes"
    ));
    assert!(matches(
        &problem(json!({"initializationOptions": []})),
        "must be an object"
    ));
}

#[test]
fn maps_only_the_extensions_own_settings_to_dotted_paths() {
    assert_eq!(
        problem(json!({"settingPaths": {"mode": "python.analysis.mode"}})),
        ""
    );
    assert!(matches(
        &problem(json!({"settingPaths": {"other": "a.b"}})),
        "not one of the extension's settings"
    ));
    assert!(matches(
        &problem(json!({"settingPaths": {"mode": "a..b"}})),
        "dotted path"
    ));
    assert!(matches(
        &problem(json!({"settingPaths": {"mode": "a.__proto__.b"}})),
        "dotted path"
    ));
}

fn asset() -> Value {
    json!({
        "url": "https://github.com/owner/repo/releases/download/1.2.3/tool-linux.gz",
        "sha256": "a".repeat(64),
        "archive": "gz",
        "executable": "tool",
    })
}

fn merged(mut base: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

fn download(extra: Value, asset_extra: Value) -> Value {
    let body = merged(
        json!({
            "program": "tool",
            "version": "1.2.3",
            "assets": {"linux-x64": merged(asset(), asset_extra)},
        }),
        extra,
    );
    json!({"run": {"download": body}})
}

fn go_install(extra: Value) -> Value {
    json!({"run": {"goInstall": merged(json!({
        "module": "golang.org/x/tools/gopls",
        "version": "v0.20.0",
        "binary": "gopls",
    }), extra)}})
}

#[test]
fn takes_a_pinned_checksummed_download_per_platform() {
    let parsed = parse(&[server(download(json!({}), json!({})))], &options());
    assert_subset(
        &parsed,
        &json!([{
            "run": {
                "download": {
                    "program": "tool",
                    "version": "1.2.3",
                    "assets": {"linux-x64": asset()},
                },
                "args": [],
            },
        }]),
    );
    assert_eq!(
        problem(download(
            json!({}),
            json!({"archive": "zip", "executable": "tool_1.2.3/bin/tool.exe"})
        )),
        ""
    );
}

#[test]
fn refuses_a_download_that_is_not_https_on_an_allowed_host() {
    let urls = [
        json!("http://github.com/o/r/tool.gz"),
        json!("https://evil.example/tool.gz"),
        json!("https://github.com.evil.example/tool.gz"),
        json!("https://user:pw@github.com/o/r/tool.gz"),
        json!("https://github.com:444/o/r/tool.gz"),
        json!("https://github.com/o/r/../../tool.gz"),
        json!("file:///etc/passwd"),
        json!(42),
    ];
    for url in urls {
        let text = problem(download(json!({}), json!({"url": url})));
        assert!(matches(&text, r"assets\.linux-x64\.url"), "{url}: {text}");
    }
    assert_eq!(
        download_url_problem("https://objects.githubusercontent.com/a/b"),
        None
    );
    assert_eq!(
        download_url_problem("https://release-assets.githubusercontent.com/a/b?x=1"),
        None
    );
}

#[test]
fn needs_a_pinned_version_a_sha256_a_known_archive_kind_and_platform() {
    let pinned = "pinned version";
    for version in ["latest", "LATEST", ""] {
        assert!(
            matches(
                &problem(download(json!({"version": version}), json!({}))),
                pinned
            ),
            "{version}"
        );
    }
    assert!(matches(
        &problem(download(json!({}), json!({"sha256": "abc"}))),
        "sha256 must be 64"
    ));
    assert!(matches(
        &problem(download(json!({}), json!({"sha256": "A".repeat(64)}))),
        "sha256"
    ));
    let mut no_sha = download(json!({}), json!({}));
    no_sha["run"]["download"]["assets"]["linux-x64"]
        .as_object_mut()
        .unwrap()
        .remove("sha256");
    assert!(matches(&problem(no_sha), "sha256"));
    assert!(matches(
        &problem(download(json!({}), json!({"archive": "rar"}))),
        "archive must be one of"
    ));
    assert!(matches(
        &problem(download(json!({"assets": {}}), json!({}))),
        "at least one platform"
    ));
    assert!(matches(
        &problem(download(
            json!({"assets": {"solaris-x64": asset()}}),
            json!({})
        )),
        "must be one of linux-x64"
    ));
    assert!(matches(
        &problem(download(json!({"program": "/usr/bin/tool"}), json!({}))),
        "program name"
    ));
    assert!(matches(
        &problem(download(json!({"extra": 1}), json!({}))),
        "extra is not allowed"
    ));
    assert!(matches(
        &problem(download(json!({}), json!({"run": "sh"}))),
        "run is not allowed"
    ));
}

#[test]
fn keeps_the_executable_inside_the_download() {
    for executable in [
        "../tool",
        "/bin/sh",
        "a/../../tool",
        "bin\\tool",
        "a/./tool",
        "",
    ] {
        let text = problem(download(
            json!({}),
            json!({"archive": "zip", "executable": executable}),
        ));
        assert!(
            matches(&text, "relative path inside the download"),
            "{executable}: {text}"
        );
    }
    assert!(matches(
        &problem(download(
            json!({}),
            json!({"archive": "gz", "executable": "bin/tool"})
        )),
        "file name for a gz download"
    ));
    assert!(matches(
        &problem(download(
            json!({}),
            json!({"archive": "plain", "executable": "bin/tool"})
        )),
        "file name for a plain download"
    ));
}

#[test]
fn takes_go_install_of_a_pinned_module_version_and_nothing_that_could_be_a_flag() {
    let parsed = parse(&[server(go_install(json!({})))], &options());
    assert_subset(
        &parsed,
        &json!([{
            "run": {"goInstall": {
                "module": "golang.org/x/tools/gopls",
                "version": "v0.20.0",
                "binary": "gopls",
            }},
        }]),
    );
    let modules = [
        "-modfile=x",
        "golang.org/x/tools/gopls@latest",
        "golang.org/x/tools/gopls -ldflags=x",
        "Golang.org/x/tools/gopls",
        "gopls",
        "./local",
        "golang.org",
        "golang.org/x/../y",
        "golang.org//x",
    ];
    for module in modules {
        let text = problem(go_install(json!({"module": module})));
        assert!(matches(&text, "Go module path"), "{module}: {text}");
    }
    let versions = [
        "latest",
        "master",
        "v1.2",
        "1.2.3",
        "v1.2.3-rc1",
        "v1.2.3 -x",
        "",
    ];
    for version in versions {
        let text = problem(go_install(json!({"version": version})));
        assert!(
            matches(&text, "pinned version such as"),
            "{version}: {text}"
        );
    }
    assert!(matches(
        &problem(go_install(json!({"binary": "bin/gopls"}))),
        "program name"
    ));
    assert!(matches(
        &problem(go_install(json!({"args": ["-x"]}))),
        "args is not allowed"
    ));
    let both = json!({"run": {
        "goInstall": go_install(json!({}))["run"]["goInstall"].clone(),
        "program": "gopls",
    }});
    assert!(matches(&problem(both), "exactly one"));
}

#[test]
fn describes_what_a_server_runs_and_what_the_app_would_fetch_for_it() {
    let list = parse_language_servers(
        Some(&json!([
            server(download(json!({}), json!({}))),
            server(merged(json!({"id": "go"}), go_install(json!({})))),
        ])),
        &options(),
    )
    .unwrap();
    assert_subset(
        &serde_json::to_value(language_server_summary(&list[0])).unwrap(),
        &json!({
            "command": "tool",
            "download": {"program": "tool", "version": "1.2.3", "host": "github.com"},
        }),
    );
    assert_subset(
        &serde_json::to_value(language_server_summary(&list[1])).unwrap(),
        &json!({
            "command": "gopls",
            "goInstall": {
                "command": "go install golang.org/x/tools/gopls@v0.20.0",
                "binary": "gopls",
            },
        }),
    );
}

#[test]
fn shows_the_command_line_a_server_runs() {
    let program = LanguageServerRun::Program(LanguageServerProgramRun {
        program: "gopls".to_owned(),
        package: None,
        args: vec!["serve".to_owned()],
    });
    assert_eq!(language_server_command(&program), "gopls serve");
    let node = LanguageServerRun::Node(LanguageServerNodeRun {
        node: "server/cli.mjs".to_owned(),
        args: vec!["--stdio".to_owned()],
    });
    assert_eq!(language_server_command(&node), "server/cli.mjs --stdio");
}

#[test]
fn splits_a_server_key_into_extension_and_server() {
    let split = split_language_server_key(&json!("lsp-gopls/gopls")).unwrap();
    assert_eq!(split.ext_id, "lsp-gopls");
    assert_eq!(split.server_id, "gopls");
    for bad in [
        json!("gopls"),
        json!("/gopls"),
        json!("a/"),
        json!("a/b/c"),
        json!(7),
        Value::Null,
    ] {
        assert!(split_language_server_key(&bad).is_none(), "{bad}");
    }
}

#[test]
fn replaces_the_two_placeholders_in_every_string_leaf() {
    assert_eq!(
        substitute_json(
            &json!({
                "a": "{extensionDir}/lib",
                "b": ["{root}", 2, {"c": "{root}/{root}"}],
                "d": null,
            }),
            "/ext",
            "/work",
        ),
        json!({"a": "/ext/lib", "b": ["/work", 2, {"c": "/work//work"}], "d": null})
    );
}

fn paths(pairs: &[(&str, &str)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, path)| ((*key).to_owned(), json!(path)))
        .collect()
}

#[test]
fn lays_the_humans_values_over_the_declared_settings_without_touching_the_original() {
    let base = json!({"python": {"analysis": {"mode": "standard", "depth": 1}}});
    let values = json!({"mode": "strict", "lint": true});
    let laid = overlay_settings(
        &base,
        &paths(&[
            ("mode", "python.analysis.mode"),
            ("lint", "python.lint.on"),
            ("unset", "python.unset"),
        ]),
        values.as_object().unwrap(),
    );
    assert_eq!(
        laid,
        json!({"python": {"analysis": {"mode": "strict", "depth": 1}, "lint": {"on": true}}})
    );
    assert_eq!(base["python"]["analysis"]["mode"], "standard");
}

#[test]
fn answers_a_configuration_section_by_own_properties_only() {
    let settings = json!({"python": {"analysis": {"mode": "strict"}}});
    assert_eq!(
        configuration_section(&settings, Some("python.analysis")),
        Some(&json!({"mode": "strict"}))
    );
    assert_eq!(
        configuration_section(&settings, Some("python.analysis.mode")),
        Some(&json!("strict"))
    );
    assert_eq!(configuration_section(&settings, None), Some(&settings));
    assert_eq!(configuration_section(&settings, Some("")), Some(&settings));
    assert_eq!(
        configuration_section(&settings, Some("python.missing")),
        None
    );
    assert_eq!(
        configuration_section(&settings, Some("python.constructor")),
        None
    );
    assert_eq!(
        configuration_section(&settings, Some("python.analysis.mode.length")),
        None
    );
}

fn language_ids(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, id)| ((*key).to_owned(), (*id).to_owned()))
        .collect()
}

#[test]
fn names_a_document_by_file_suffix_first_then_by_editor_language() {
    let ids = language_ids(&[("typescript", "typescript"), (".tsx", "typescriptreact")]);
    assert_eq!(
        document_language_id(Some(&ids), "/p/App.TSX", "typescript"),
        "typescriptreact"
    );
    assert_eq!(
        document_language_id(Some(&ids), "/p/app.ts", "typescript"),
        "typescript"
    );
    assert_eq!(
        document_language_id(
            Some(&language_ids(&[("shell", "shellscript")])),
            "/p/a.sh",
            "shell"
        ),
        "shellscript"
    );
    assert_eq!(document_language_id(None, "/p/a.go", "go"), "go");
}

#[test]
fn takes_a_program_override_only_as_an_absolute_path_with_an_argument_list() {
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/ls", "args": ["--stdio"]})),
        Ok(LanguageServerOverride {
            path: "/opt/ls".to_owned(),
            args: vec!["--stdio".to_owned()],
        })
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": "C:\\tools\\ls.exe"})),
        Ok(LanguageServerOverride {
            path: "C:\\tools\\ls.exe".to_owned(),
            args: vec![],
        })
    );
    let not_absolute = Err(LanguageServerOverrideProblem::NotAbsolute);
    assert_eq!(
        parse_language_server_override(&json!({"path": "./ls"})),
        not_absolute
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": "~/bin/ls"})),
        not_absolute
    );
    assert_eq!(
        parse_language_server_override(&json!("/opt/ls --stdio")),
        not_absolute
    );
    let bad_arguments = Err(LanguageServerOverrideProblem::BadArguments);
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/ls", "args": "--stdio"})),
        bad_arguments
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/ls", "args": [""]})),
        bad_arguments
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/ls", "args": vec!["x"; 33]})),
        bad_arguments
    );
}

#[test]
fn refuses_a_server_that_is_not_an_object_and_names_its_index() {
    let text = refusal(&[server(json!({})), json!(7)], &options());
    assert!(matches(&text, r"languageServers\[1\]"), "{text}");
}

#[test]
fn refuses_an_override_path_with_a_control_character_or_past_the_length_cap() {
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/l\ns"})),
        Err(LanguageServerOverrideProblem::NotAbsolute)
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": format!("/{}", "a".repeat(4096))})),
        Err(LanguageServerOverrideProblem::NotAbsolute)
    );
    assert_eq!(
        parse_language_server_override(&json!({"path": "/opt/ls", "args": ["a\u{7f}"]})),
        Err(LanguageServerOverrideProblem::BadArguments)
    );
}
