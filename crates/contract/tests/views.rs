#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::view_parse::{ViewParseResult, parse_view_text};
use ostia_contract::view_schema::view_json_schema;
use ostia_contract::views::{
    VIEW_MAX_DEPTH, VIEW_MAX_LIST_ITEMS, VIEW_MAX_NODES, VIEW_NODE_TYPES, VIEW_URL_MAX, ViewDoc,
    ViewIcon, ViewNodeType, ViewPlacement, ViewProblem, ViewSource, format_view_problem,
    is_http_url, node_keys, view_name_of,
};
use regex::Regex;
use serde_json::{Map, Value, json};

fn doc(root: Value, extra: Value) -> String {
    let mut object = Map::new();
    object.insert("version".to_owned(), json!(1));
    object.insert("title".to_owned(), json!("Agents"));
    object.insert("placement".to_owned(), json!("sidebar"));
    object.insert("root".to_owned(), root);
    if let Value::Object(more) = extra {
        object.extend(more);
    }
    Value::Object(object).to_string()
}

fn plain(root: Value) -> String {
    doc(root, json!({}))
}

fn ok(text: &str) -> ViewDoc {
    match parse_view_text(text) {
        ViewParseResult::Ok(view) => *view,
        ViewParseResult::Failed(problems) => panic!("{problems:?}"),
    }
}

fn failed(text: &str) -> Vec<ViewProblem> {
    match parse_view_text(text) {
        ViewParseResult::Ok(_) => panic!("expected problems"),
        ViewParseResult::Failed(problems) => problems,
    }
}

fn problems(text: &str) -> Vec<String> {
    failed(text)
        .iter()
        .map(|p| format!("{}: {}", p.path, p.message))
        .collect()
}

fn first_problem(text: &str) -> String {
    problems(text).remove(0)
}

fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}

const GOOD: &str = r#"{
  "version": 1,
  "title": "Workspaces",
  "placement": "sidebar",
  "icon": "robot",
  "root": {
    "type": "stack",
    "children": [
      { "type": "text", "text": "{{clock.now | time}}", "tone": "muted", "size": "xs" },
      {
        "type": "list",
        "for": "workspaces",
        "as": "ws",
        "limit": 10,
        "empty": "No workspaces",
        "item": {
          "type": "row",
          "justify": "between",
          "children": [
            { "type": "text", "text": "{{ws.name}}", "truncate": true },
            { "type": "badge", "text": "{{ws.unread}}", "tone": "warn", "if": "{{ws.unread}}" },
            {
              "type": "button",
              "label": "Open",
              "icon": "arrow-right",
              "variant": "ghost",
              "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } }
            }
          ]
        }
      },
      { "type": "progress", "value": "{{approvals.pending}}", "max": 5, "label": "Approvals" },
      { "type": "kv", "items": [{ "key": "Ports", "value": "{{ports | count}}" }] },
      { "type": "link", "label": "Docs", "url": "https://example.com/docs" },
      { "type": "divider" },
      { "type": "icon", "name": "check", "tone": "ok", "label": "fine" },
      { "type": "section", "title": "More", "collapsed": true, "children": [] }
    ]
  }
}"#;

#[test]
fn accepts_a_view_that_uses_every_component() {
    let view = ok(GOOD);
    assert_eq!(view.placement, ViewPlacement::Sidebar);
    assert_eq!(view.icon, Some(ViewIcon::Robot));
    assert_eq!(
        view.sources,
        [
            ViewSource::Workspaces,
            ViewSource::Ports,
            ViewSource::Approvals,
            ViewSource::Clock
        ]
    );
    assert!(view.ticks);
}

#[test]
fn reports_the_line_of_a_bad_property() {
    let text = GOOD.replace("\"tone\": \"warn\"", "\"tone\": \"loud\"");
    let found = failed(&text);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, "root.children[1].item.children[1].tone");
    let warn_line = GOOD
        .split('\n')
        .position(|line| line.contains("\"warn\""))
        .unwrap()
        + 1;
    assert_eq!(found[0].line, Some(warn_line));
    let formatted = format_view_problem("agents.json", &found[0]);
    assert!(
        matches(
            r"^agents\.json:\d+: root\.children\[1\]\.item\.children\[1\]\.tone: must be one of",
            &formatted
        ),
        "{formatted}"
    );
}

#[test]
fn reports_json_syntax_errors_with_line_and_column() {
    let found = failed("{\n  \"version\": 1,\n  \"title\": }");
    assert_eq!(found[0].line, Some(3));
    assert!(
        found[0].message.contains("invalid JSON at column 12"),
        "{}",
        found[0].message
    );
}

#[test]
fn rejects_unknown_properties_node_types_and_duplicate_keys() {
    let unknown = problems(&plain(
        json!({"type": "text", "text": "hi", "onClick": "x"}),
    ));
    assert_eq!(unknown.len(), 1);
    assert!(
        unknown[0].starts_with("root.onClick: unknown property 'onClick'"),
        "{unknown:?}"
    );
    let html = first_problem(&plain(json!({"type": "html", "html": "<b>"})));
    assert!(html.starts_with("root.type: must be one of"), "{html}");
    let duplicate = first_problem(r#"{"version":1,"version":1}"#);
    assert!(
        duplicate.contains("duplicate property 'version'"),
        "{duplicate}"
    );
    let script = first_problem(&doc(
        json!({"type": "divider"}),
        json!({"script": "alert(1)"}),
    ));
    assert!(script.starts_with("script: unknown property"), "{script}");
}

#[test]
fn requires_version_title_placement_and_root() {
    assert_eq!(
        problems("{}"),
        [
            "version: must be 1",
            "title: is required",
            "placement: is required (sidebar or panel)",
            "root: is required",
        ]
    );
}

#[test]
fn rejects_unknown_data_sources_filters_and_prototype_paths() {
    let table: [(&str, &str); 6] = [
        ("{{process.env}}", "unknown data source 'process'"),
        ("{{workspace.name | eval}}", "unknown filter 'eval'"),
        ("{{workspace.__proto__}}", "'__proto__' is not allowed"),
        (
            "{{workspace.constructor.name}}",
            "'constructor' is not allowed",
        ),
        ("{{workspace[\"x\"]}}", "not a property path"),
        ("{{ workspace.name", "unbalanced"),
    ];
    for (text, expected) in table {
        let found = first_problem(&plain(json!({"type": "text", "text": text})));
        assert!(found.contains(expected), "{text}: {found}");
    }
}

#[test]
fn scopes_a_list_variable_to_its_item() {
    let list = json!({
        "type": "list",
        "for": "panes",
        "as": "p",
        "item": {"type": "text", "text": "{{p.title}}"},
    });
    assert_eq!(ok(&plain(list.clone())).sources, [ViewSource::Panes]);
    let outside = first_problem(&plain(json!({
        "type": "stack",
        "children": [list.clone(), {"type": "text", "text": "{{p.title}}"}],
    })));
    assert!(
        outside.starts_with("root.children[1].text: unknown data source 'p'"),
        "{outside}"
    );
    let mut shadow = list;
    shadow["as"] = json!("workspace");
    let shadowed = first_problem(&plain(shadow));
    assert!(shadowed.contains("already a data source"), "{shadowed}");
}

#[test]
fn allows_only_http_and_https_urls() {
    let link = |url: &str| plain(json!({"type": "link", "label": "x", "url": url}));
    for url in [
        "https://example.com",
        "{{workspace.name}}",
        "http://localhost:{{workspace.name}}/",
    ] {
        assert_eq!(ok(&link(url)).root.node_type(), ViewNodeType::Link, "{url}");
    }
    for url in ["javascript:alert(1)", "file:///etc/passwd"] {
        let found = first_problem(&link(url));
        assert!(found.contains("http:// or https://"), "{url}: {found}");
    }
    let templated = first_problem(&link("javascript:{{workspace.name}}"));
    assert!(templated.contains("must start with"), "{templated}");
    let button = plain(json!({
        "type": "button",
        "label": "x",
        "action": {"openUrl": "data:text/html,hi"},
    }));
    assert!(first_problem(&button).starts_with("root.action.openUrl:"));
}

#[test]
fn checks_button_actions() {
    let button = |action: Value| plain(json!({"type": "button", "label": "Go", "action": action}));
    assert_eq!(
        ok(&button(
            json!({"command": "workspace.new", "args": {"name": "x"}})
        ))
        .root
        .node_type(),
        ViewNodeType::Button
    );
    assert!(first_problem(&button(json!({"command": "rm -rf /"}))).contains("palette command id"));
    assert!(
        first_problem(&button(json!({"command": "a", "run": "x"})))
            .contains("unknown property 'run'")
    );
    assert!(
        first_problem(&button(
            json!({"command": "a", "args": {"big": "x".repeat(5000)}})
        ))
        .contains("larger than")
    );
    assert!(
        first_problem(&button(json!({"command": "a", "args": {"id": "{{nope}}"}})))
            .starts_with("root.action.args.id: unknown data source")
    );
}

#[test]
fn enforces_the_node_and_depth_budget() {
    let many = json!({
        "type": "stack",
        "children": vec![json!({"type": "divider"}); VIEW_MAX_NODES],
    });
    let over_budget = problems(&plain(many));
    assert_eq!(over_budget.len(), 1);
    assert!(
        over_budget[0].contains(&format!("more than {VIEW_MAX_NODES} nodes")),
        "{over_budget:?}"
    );
    let mut deep = json!({"type": "divider"});
    for _ in 0..VIEW_MAX_DEPTH {
        deep = json!({"type": "stack", "children": [deep]});
    }
    let too_deep = first_problem(&plain(deep));
    assert!(
        too_deep.contains(&format!("deeper than {VIEW_MAX_DEPTH}")),
        "{too_deep}"
    );
    let list = json!({
        "type": "list",
        "for": "workspaces",
        "limit": VIEW_MAX_LIST_ITEMS + 1,
        "item": {"type": "divider"},
    });
    let limit = first_problem(&plain(list));
    assert!(
        limit.starts_with("root.limit: must be a whole number"),
        "{limit}"
    );
}

#[test]
fn requires_single_bindings_for_if_and_progress_values() {
    let condition = first_problem(&plain(
        json!({"type": "divider", "if": "yes {{workspace}}"}),
    ));
    assert!(condition.contains("single {{binding}}"), "{condition}");
    let progress = first_problem(&plain(json!({"type": "progress", "value": "half"})));
    assert!(progress.contains("single {{binding}}"), "{progress}");
}

#[test]
fn takes_lowercase_names_from_json_files_only() {
    assert_eq!(view_name_of("agents.json").as_deref(), Some("agents"));
    assert_eq!(view_name_of("my-view-2.json").as_deref(), Some("my-view-2"));
    assert_eq!(view_name_of("Agents.json"), None);
    assert_eq!(view_name_of("agents.js"), None);
    assert_eq!(view_name_of(".json"), None);
}

#[test]
fn describes_every_node_type_the_validator_accepts() {
    let schema = view_json_schema();
    let mut types: Vec<String> = schema
        .pointer("/$defs/node/oneOf")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|node| {
            node.pointer("/properties/type/const")
                .and_then(Value::as_str)
                .unwrap()
                .to_owned()
        })
        .collect();
    types.sort();
    let mut expected: Vec<String> = VIEW_NODE_TYPES.iter().map(|t| (*t).to_owned()).collect();
    expected.sort();
    assert_eq!(types, expected);
}

#[test]
fn limits_a_view_name_to_forty_characters_that_start_with_a_letter_or_digit() {
    let longest = format!("a{}", "b".repeat(39));
    assert_eq!(
        view_name_of(&format!("{longest}.json")).as_deref(),
        Some(longest.as_str())
    );
    assert_eq!(view_name_of(&format!("{longest}c.json")), None);
    assert_eq!(view_name_of("9lives.json").as_deref(), Some("9lives"));
    assert_eq!(view_name_of("-dash.json"), None);
    assert_eq!(view_name_of("has_underscore.json"), None);
    assert_eq!(view_name_of("agents.json.json"), None);
    assert_eq!(view_name_of("agents"), None);
}

#[test]
fn formats_a_problem_with_and_without_a_line() {
    let with_line = ViewProblem {
        path: "root.text".to_owned(),
        line: Some(7),
        message: "is required".to_owned(),
    };
    let without_line = ViewProblem {
        line: None,
        ..with_line.clone()
    };
    let at_zero = ViewProblem {
        line: Some(0),
        ..with_line.clone()
    };
    assert_eq!(
        format_view_problem("a.json", &with_line),
        "a.json:7: root.text: is required"
    );
    assert_eq!(
        format_view_problem("a.json", &without_line),
        "a.json: root.text: is required"
    );
    assert_eq!(
        format_view_problem("a.json", &at_zero),
        "a.json: root.text: is required"
    );
}

#[test]
fn accepts_http_and_https_urls_and_refuses_other_schemes_and_long_urls() {
    assert!(is_http_url("http://example.com"));
    assert!(is_http_url("https://example.com/a?b=c#d"));
    assert!(is_http_url("HTTPS://EXAMPLE.COM"));
    assert!(!is_http_url("ftp://example.com"));
    assert!(!is_http_url("javascript:alert(1)"));
    assert!(!is_http_url("file:///etc/passwd"));
    assert!(!is_http_url("example.com"));
    assert!(!is_http_url(""));
    let padding = "a".repeat(VIEW_URL_MAX - "https://e.co/".len());
    assert!(is_http_url(&format!("https://e.co/{padding}")));
    assert!(!is_http_url(&format!("https://e.co/{padding}a")));
}

#[test]
fn lists_the_property_names_each_node_type_allows() {
    let table: [(ViewNodeType, &[&str]); 12] = [
        (ViewNodeType::Stack, &["children", "gap"]),
        (ViewNodeType::Row, &["children", "gap", "justify", "wrap"]),
        (ViewNodeType::Section, &["title", "children", "collapsed"]),
        (
            ViewNodeType::Text,
            &["text", "tone", "size", "weight", "mono", "truncate"],
        ),
        (ViewNodeType::Badge, &["text", "tone"]),
        (ViewNodeType::Icon, &["name", "tone", "label"]),
        (
            ViewNodeType::List,
            &["for", "as", "limit", "item", "empty", "gap"],
        ),
        (
            ViewNodeType::Button,
            &["label", "icon", "variant", "action"],
        ),
        (ViewNodeType::Link, &["label", "url"]),
        (ViewNodeType::Progress, &["value", "max", "label", "tone"]),
        (ViewNodeType::Kv, &["items"]),
        (ViewNodeType::Divider, &[]),
    ];
    for (node_type, keys) in table {
        assert_eq!(node_keys(node_type), keys, "{node_type:?}");
    }
    assert_eq!(
        VIEW_NODE_TYPES,
        [
            "stack", "row", "section", "text", "badge", "icon", "list", "button", "link",
            "progress", "kv", "divider"
        ]
    );
}
