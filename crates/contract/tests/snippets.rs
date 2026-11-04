#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_contract::snippets::{
    CommandPart, SNIPPET_LIMITS, Snippet, SnippetArgument, command_parts, default_values,
    is_argument_name, parse_snippet, placeholder_names, render_snippet, snippet_arguments,
    snippet_document, snippet_file_stem,
};
use serde_json::{Value, json};

fn text(value: &str) -> CommandPart {
    CommandPart::Text(value.to_owned())
}

fn arg(value: &str) -> CommandPart {
    CommandPart::Arg(value.to_owned())
}

fn parsed(raw: Value) -> Snippet {
    parse_snippet(&raw).unwrap()
}

fn error_of(raw: Value) -> String {
    parse_snippet(&raw).unwrap_err().to_string()
}

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn argument(name: &str) -> SnippetArgument {
    SnippetArgument {
        name: name.to_owned(),
        description: None,
        default_value: None,
    }
}

#[test]
fn splits_a_command_into_text_and_placeholders() {
    assert_eq!(
        command_parts("git checkout -b {{branch}} origin/{{base}}"),
        vec![
            text("git checkout -b "),
            arg("branch"),
            text(" origin/"),
            arg("base"),
        ]
    );
}

#[test]
fn treats_triple_braces_as_an_escaped_literal_placeholder() {
    assert_eq!(
        command_parts("echo {{{name}}} {{name}}"),
        vec![text("echo {{name}} "), arg("name")]
    );
}

#[test]
fn leaves_template_syntax_that_is_not_a_placeholder_name_alone() {
    assert_eq!(
        command_parts("docker ps --format '{{.Names}} {{ json . }}'"),
        vec![text("docker ps --format '{{.Names}} {{ json . }}'")]
    );
}

#[test]
fn lists_each_placeholder_once_in_order_of_appearance() {
    assert_eq!(
        placeholder_names("cp {{src}} {{dst}} && ls {{dst}}"),
        vec!["src", "dst"]
    );
}

#[test]
fn substitutes_every_occurrence_of_each_argument_verbatim() {
    assert_eq!(
        render_snippet(
            "cp {{src}} {{dst}}; ls {{dst}}",
            &values(&[("src", "a b"), ("dst", "/tmp")])
        ),
        "cp a b /tmp; ls /tmp"
    );
}

#[test]
fn renders_a_missing_value_as_empty_and_keeps_escaped_braces_literal() {
    assert_eq!(
        render_snippet("echo {{{x}}} {{x}}!", &BTreeMap::new()),
        "echo {{x}} !"
    );
}

#[test]
fn reads_the_warp_workflow_format() {
    let w = parsed(json!({
        "name": "Clone a repo",
        "command": "git clone {{url}} {{dir}}",
        "description": "Clones a repository",
        "tags": ["git", "git"],
        "arguments": [
            { "name": "url", "description": "Repository URL", "default_value": null },
            { "name": "dir", "default_value": 7 },
        ],
        "shells": ["zsh"],
        "author": "me",
        "source_url": "https://example.com/w",
    }));
    assert_eq!(
        w,
        Snippet {
            name: "Clone a repo".to_owned(),
            command: "git clone {{url}} {{dir}}".to_owned(),
            description: Some("Clones a repository".to_owned()),
            tags: vec!["git".to_owned()],
            arguments: vec![
                SnippetArgument {
                    name: "url".to_owned(),
                    description: Some("Repository URL".to_owned()),
                    default_value: None,
                },
                SnippetArgument {
                    name: "dir".to_owned(),
                    description: None,
                    default_value: Some("7".to_owned()),
                },
            ],
            shells: Some(vec!["zsh".to_owned()]),
            author: Some("me".to_owned()),
            source_url: Some("https://example.com/w".to_owned()),
        }
    );
}

#[test]
fn rejects_a_snippet_without_a_name_or_command() {
    assert!(parse_snippet(&json!({ "command": "ls" })).is_err());
    assert!(parse_snippet(&json!({ "name": "x", "command": "   " })).is_err());
    assert!(parse_snippet(&json!(["name"])).is_err());
}

#[test]
fn rejects_bad_argument_names_duplicates_and_non_web_source_urls() {
    assert!(
        parse_snippet(&json!({ "name": "x", "command": "ls", "arguments": [{ "name": "a b" }] }))
            .is_err()
    );
    assert!(
        parse_snippet(&json!({
            "name": "x",
            "command": "ls",
            "arguments": [{ "name": "a" }, { "name": "a" }],
        }))
        .is_err()
    );
    assert!(
        error_of(json!({ "name": "x", "command": "ls", "source_url": "javascript:alert(1)" }))
            .contains("source_url")
    );
}

#[test]
fn rejects_oversized_fields() {
    assert!(parse_snippet(&json!({ "name": "x", "command": "a".repeat(9000) })).is_err());
    assert!(
        parse_snippet(&json!({ "name": "x", "command": "ls", "tags": vec!["t"; 40] })).is_err()
    );
}

#[test]
fn follows_the_placeholders_and_takes_metadata_from_the_declared_arguments() {
    let w = parsed(json!({
        "name": "x",
        "command": "ssh {{host}} -p {{port}}",
        "arguments": [{ "name": "port", "default_value": "22" }, { "name": "unused" }],
    }));
    assert_eq!(
        snippet_arguments(&w),
        vec![
            argument("host"),
            SnippetArgument {
                name: "port".to_owned(),
                description: None,
                default_value: Some("22".to_owned()),
            },
        ]
    );
    assert_eq!(default_values(&w), values(&[("host", ""), ("port", "22")]));
}

#[test]
fn round_trips_through_parse_snippet() {
    let w = parsed(json!({
        "name": "x",
        "command": "echo {{a}}",
        "tags": ["t"],
        "arguments": [{ "name": "a", "description": "d", "default_value": "v" }],
    }));
    assert_eq!(
        snippet_document(&w),
        json!({
            "name": "x",
            "command": "echo {{a}}",
            "tags": ["t"],
            "arguments": [{ "name": "a", "description": "d", "default_value": "v" }],
        })
    );
    assert_eq!(parsed(snippet_document(&w)), w);
}

#[test]
fn makes_a_safe_file_name_from_any_snippet_name() {
    assert_eq!(snippet_file_stem("Deploy to Prod!"), "deploy-to-prod");
    assert_eq!(snippet_file_stem("../../etc/passwd"), "etc-passwd");
    assert_eq!(snippet_file_stem("部署"), "snippet");
}

#[test]
fn keeps_the_limits_and_the_argument_name_pattern_of_ts() {
    assert_eq!(SNIPPET_LIMITS.name, 200);
    assert_eq!(SNIPPET_LIMITS.command, 8192);
    assert_eq!(SNIPPET_LIMITS.description, 1000);
    assert_eq!(SNIPPET_LIMITS.tags, 32);
    assert_eq!(SNIPPET_LIMITS.tag, 64);
    assert_eq!(SNIPPET_LIMITS.arguments, 32);
    assert_eq!(SNIPPET_LIMITS.argument_description, 500);
    assert_eq!(SNIPPET_LIMITS.default_value, 1000);
    assert_eq!(SNIPPET_LIMITS.shells, 8);
    assert_eq!(SNIPPET_LIMITS.author, 200);
    assert_eq!(SNIPPET_LIMITS.source_url, 2000);
    let cases = [
        ("a", true),
        ("_a-1", true),
        ("1a", false),
        ("-a", false),
        ("a b", false),
        ("", false),
        ("é", false),
        ("٣", false),
        (&"a".repeat(64), true),
        (&"a".repeat(65), false),
        ("a\n", false),
    ];
    for (name, expected) in cases {
        assert_eq!(is_argument_name(name), expected, "{name:?}");
    }
}

#[test]
fn keeps_a_placeholder_only_when_its_name_matches_the_argument_pattern() {
    let cases: [(&str, Vec<CommandPart>); 6] = [
        ("{{1a}}", vec![text("{{1a}}")]),
        ("{{a b}}", vec![text("{{a b}}")]),
        ("{{}}", vec![text("{{}}")]),
        ("{{{}}}", vec![text("{{{}}}")]),
        ("{{a}}{{b}}", vec![arg("a"), arg("b")]),
        ("{{{a b}}}x", vec![text("{{a b}}x")]),
    ];
    for (command, expected) in cases {
        assert_eq!(command_parts(command), expected, "{command:?}");
    }
    assert_eq!(command_parts(""), Vec::<CommandPart>::new());
    assert_eq!(
        command_parts(&format!("{{{{{}}}}}", "a".repeat(65))),
        vec![text(&format!("{{{{{}}}}}", "a".repeat(65)))]
    );
}

#[test]
fn renders_text_around_an_escaped_placeholder_as_one_part() {
    assert_eq!(
        command_parts("a{{{b}}}c{{d}}e"),
        vec![text("a{{b}}c"), arg("d"), text("e")]
    );
}

#[test]
fn renders_a_value_that_looks_like_a_placeholder_without_expanding_it() {
    assert_eq!(
        render_snippet("echo {{a}}", &values(&[("a", "{{b}}"), ("b", "x")])),
        "echo {{b}}"
    );
}

#[test]
fn gives_a_declared_default_or_an_empty_string_for_each_placeholder() {
    let w = parsed(json!({
        "name": "x",
        "command": "{{a}} {{b}} {{a}}",
        "arguments": [{ "name": "a", "default_value": false }],
    }));
    assert_eq!(default_values(&w), values(&[("a", "false"), ("b", "")]));
}

#[test]
fn treats_a_null_or_whitespace_only_optional_text_as_absent() {
    let w = parsed(json!({
        "name": "x",
        "command": "ls",
        "description": "   ",
        "author": null,
        "source_url": "  ",
        "tags": null,
        "shells": [],
        "arguments": null,
    }));
    assert_eq!(w.description, None);
    assert_eq!(w.author, None);
    assert_eq!(w.source_url, None);
    assert!(w.tags.is_empty());
    assert_eq!(w.shells, None);
    assert!(w.arguments.is_empty());
}

#[test]
fn trims_the_name_description_author_and_source_url_but_not_the_command() {
    let w = parsed(json!({
        "name": "  x  ",
        "command": "  ls  ",
        "description": " d ",
        "author": " a ",
        "source_url": " http://example.com ",
    }));
    assert_eq!(w.name, "x");
    assert_eq!(w.command, "  ls  ");
    assert_eq!(w.description.as_deref(), Some("d"));
    assert_eq!(w.author.as_deref(), Some("a"));
    assert_eq!(w.source_url.as_deref(), Some("http://example.com"));
}

#[test]
fn reports_a_missing_name_or_command_by_name() {
    assert_eq!(error_of(json!({ "command": "ls" })), "missing name");
    assert_eq!(error_of(json!({ "name": "x" })), "missing command");
    assert_eq!(
        error_of(json!({ "name": " ", "command": "ls" })),
        "missing name"
    );
    assert_eq!(error_of(json!(null)), "a snippet must be a mapping");
    assert_eq!(error_of(json!("x")), "a snippet must be a mapping");
}

#[test]
fn reports_a_field_of_the_wrong_type() {
    assert_eq!(
        error_of(json!({ "name": 5, "command": "ls" })),
        "name must be a string"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": ["ls"] })),
        "command must be a string"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "description": true })),
        "description must be a string"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "author": 1 })),
        "author must be a string"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "source_url": {} })),
        "source_url must be a string"
    );
}

#[test]
fn reports_a_field_that_is_too_long() {
    assert_eq!(
        error_of(json!({ "name": "n".repeat(201), "command": "ls" })),
        "name is longer than 200 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "a".repeat(8193) })),
        "command is longer than 8192 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "description": "d".repeat(1001) })),
        "description is longer than 1000 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "author": "a".repeat(201) })),
        "author is longer than 200 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "source_url": "h".repeat(2001) })),
        "source_url is longer than 2000 characters"
    );
    assert!(
        parse_snippet(&json!({ "name": "n".repeat(200), "command": "a".repeat(8192) })).is_ok()
    );
}

#[test]
fn counts_the_length_limit_in_utf16_units() {
    assert!(parse_snippet(&json!({ "name": "😀".repeat(100), "command": "ls" })).is_ok());
    assert_eq!(
        error_of(json!({ "name": "😀".repeat(101), "command": "ls" })),
        "name is longer than 200 characters"
    );
}

#[test]
fn rejects_a_text_list_that_is_not_a_list_or_is_too_long() {
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "tags": "git" })),
        "tags must be a list of at most 32 strings"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "tags": vec!["t"; 33] })),
        "tags must be a list of at most 32 strings"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "shells": vec!["z"; 9] })),
        "shells must be a list of at most 8 strings"
    );
    assert!(parse_snippet(&json!({ "name": "x", "command": "ls", "tags": vec!["t"; 32] })).is_ok());
}

#[test]
fn rejects_a_text_list_item_that_is_empty_not_a_string_or_too_long() {
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "tags": [""] })),
        "tags must hold non-empty strings of at most 64 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "tags": ["  "] })),
        "tags must hold non-empty strings of at most 64 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "tags": [1] })),
        "tags must hold non-empty strings of at most 64 characters"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "shells": ["s".repeat(65)] })),
        "shells must hold non-empty strings of at most 64 characters"
    );
}

#[test]
fn trims_text_list_items_and_drops_duplicates_after_trimming() {
    let w = parsed(json!({
        "name": "x",
        "command": "ls",
        "tags": [" git ", "git", "ops", "git "],
        "shells": ["zsh", " zsh", "bash"],
    }));
    assert_eq!(w.tags, vec!["git", "ops"]);
    assert_eq!(w.shells, Some(vec!["zsh".to_owned(), "bash".to_owned()]));
}

#[test]
fn rejects_arguments_that_are_not_a_list_or_are_too_many() {
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "arguments": "a" })),
        "arguments must be a list of at most 32"
    );
    let many: Vec<Value> = (0..33)
        .map(|i| json!({ "name": format!("a{i}") }))
        .collect();
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "arguments": many })),
        "arguments must be a list of at most 32"
    );
    let allowed: Vec<Value> = (0..32)
        .map(|i| json!({ "name": format!("a{i}") }))
        .collect();
    assert_eq!(
        parsed(json!({ "name": "x", "command": "ls", "arguments": allowed }))
            .arguments
            .len(),
        32
    );
}

#[test]
fn reports_the_index_of_a_bad_argument() {
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "arguments": [{ "name": "a" }, "b"] })),
        "arguments[1] must be a mapping"
    );
    assert_eq!(
        error_of(
            json!({ "name": "x", "command": "ls", "arguments": [{ "name": "a" }, { "name": "1" }] })
        ),
        "arguments[1].name must be letters, digits, _ or -"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "arguments": [{}] })),
        "arguments[0].name must be letters, digits, _ or -"
    );
    assert_eq!(
        error_of(json!({ "name": "x", "command": "ls", "arguments": [{ "name": 3 }] })),
        "arguments[0].name must be letters, digits, _ or -"
    );
    assert_eq!(
        error_of(
            json!({ "name": "x", "command": "ls", "arguments": [{ "name": "a" }, { "name": "a" }] })
        ),
        "duplicate argument 'a'"
    );
}

#[test]
fn checks_the_description_and_default_value_of_an_argument() {
    assert_eq!(
        error_of(json!({
            "name": "x",
            "command": "ls",
            "arguments": [{ "name": "a", "description": 1 }],
        })),
        "arguments[0].description must be a string"
    );
    assert_eq!(
        error_of(json!({
            "name": "x",
            "command": "ls",
            "arguments": [{ "name": "a", "description": "d".repeat(501) }],
        })),
        "arguments[0].description is longer than 500 characters"
    );
    assert_eq!(
        error_of(json!({
            "name": "x",
            "command": "ls",
            "arguments": [{ "name": "a", "default_value": "v".repeat(1001) }],
        })),
        "arguments[0].default_value is longer than 1000 characters"
    );
    assert_eq!(
        error_of(json!({
            "name": "x",
            "command": "ls",
            "arguments": [{ "name": "a", "default_value": ["v"] }],
        })),
        "arguments[0].default_value must be a string"
    );
}

#[test]
fn reads_a_scalar_default_value_as_text_and_keeps_an_empty_or_blank_one_as_absent() {
    let w = parsed(json!({
        "name": "x",
        "command": "ls",
        "arguments": [
            { "name": "a", "default_value": true },
            { "name": "b", "default_value": 1.5 },
            { "name": "c", "default_value": "" },
            { "name": "d", "default_value": "  " },
            { "name": "e", "default_value": " v " },
            { "name": "f", "description": "  " },
        ],
    }));
    let defaults: Vec<Option<&str>> = w
        .arguments
        .iter()
        .map(|a| a.default_value.as_deref())
        .collect();
    assert_eq!(
        defaults,
        vec![Some("true"), Some("1.5"), None, None, Some(" v "), None]
    );
    assert_eq!(w.arguments[5].description, None);
}

#[test]
fn accepts_only_http_and_https_source_urls() {
    let cases = [
        ("https://example.com/a", true),
        ("http://example.com", true),
        ("HTTP://EXAMPLE.COM", true),
        ("ftp://example.com", false),
        ("file:///etc/passwd", false),
        ("data:text/plain,hi", false),
        ("example.com", false),
        ("/relative", false),
        ("http://", false),
    ];
    for (url, ok) in cases {
        let result = parse_snippet(&json!({ "name": "x", "command": "ls", "source_url": url }));
        assert_eq!(result.is_ok(), ok, "{url}");
        if !ok {
            assert_eq!(
                result.unwrap_err().to_string(),
                "source_url must be an http(s) URL",
                "{url}"
            );
        }
    }
}

#[test]
fn omits_empty_fields_from_the_document_and_keeps_the_ts_key_order() {
    let w = parsed(json!({ "name": "x", "command": "ls" }));
    assert_eq!(
        serde_json::to_string(&snippet_document(&w)).unwrap(),
        r#"{"name":"x","command":"ls"}"#
    );
    let full = parsed(json!({
        "source_url": "https://example.com",
        "author": "me",
        "shells": ["zsh"],
        "arguments": [{ "default_value": "", "name": "a" }],
        "tags": ["t"],
        "description": "d",
        "command": "echo {{a}}",
        "name": "x",
    }));
    assert_eq!(
        serde_json::to_string(&snippet_document(&full)).unwrap(),
        concat!(
            r#"{"name":"x","command":"echo {{a}}","description":"d","tags":["t"],"#,
            r#""arguments":[{"name":"a"}],"shells":["zsh"],"author":"me","#,
            r#""source_url":"https://example.com"}"#
        )
    );
}

#[test]
fn keeps_an_empty_default_value_out_of_the_document_only_when_it_was_absent() {
    let w = Snippet {
        name: "x".to_owned(),
        command: "ls".to_owned(),
        description: None,
        tags: Vec::new(),
        arguments: vec![SnippetArgument {
            name: "a".to_owned(),
            description: None,
            default_value: Some(String::new()),
        }],
        shells: None,
        author: None,
        source_url: None,
    };
    assert_eq!(
        snippet_document(&w),
        json!({ "name": "x", "command": "ls", "arguments": [{ "name": "a", "default_value": "" }] })
    );
}

#[test]
fn folds_accents_and_collapses_runs_in_a_file_stem() {
    assert_eq!(snippet_file_stem("Café Déjà Vu"), "cafe-deja-vu");
    assert_eq!(snippet_file_stem("  --a__b--  "), "a-b");
    assert_eq!(snippet_file_stem(""), "snippet");
    assert_eq!(snippet_file_stem("!!!"), "snippet");
    assert_eq!(snippet_file_stem("ﬁle"), "file");
}

#[test]
fn cuts_a_file_stem_at_sixty_characters_and_drops_a_trailing_dash() {
    assert_eq!(snippet_file_stem(&"a".repeat(80)), "a".repeat(60));
    let cut_at_dash = format!("{}-{}", "a".repeat(59), "b".repeat(10));
    assert_eq!(snippet_file_stem(&cut_at_dash), "a".repeat(59));
    let before_dash = format!("{}-{}", "a".repeat(58), "b".repeat(10));
    assert_eq!(
        snippet_file_stem(&before_dash),
        format!("{}-b", "a".repeat(58))
    );
}
