#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::browse_snapshot::{SnapshotNode, SnapshotOptions, format_snapshot};
use serde_json::{Value, json};

fn node(role: &str, name: &str, extra: Value) -> Value {
    let mut node = json!({"role": role, "name": name, "children": []});
    if let (Some(map), Some(extra)) = (node.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            map.insert(key.clone(), value.clone());
        }
    }
    node
}

fn nodes(list: Value) -> Vec<SnapshotNode> {
    serde_json::from_value(list).unwrap()
}

fn options(value: Value) -> SnapshotOptions {
    serde_json::from_value(value).unwrap()
}

fn page() -> Vec<SnapshotNode> {
    nodes(json!([
        node(
            "heading",
            "Example Domain",
            json!({"ref": "e1", "level": 1})
        ),
        node(
            "navigation",
            "",
            json!({"ref": "e2", "children": [
                node("list", "", json!({"ref": "e3", "children": [
                    node("listitem", "", json!({"ref": "e4", "children": [
                        node("link", "Docs", json!({"ref": "e5", "interactive": true, "url": "https://x.test/docs"})),
                    ]})),
                ]})),
            ]})
        ),
        node(
            "paragraph",
            "",
            json!({"ref": "e6", "children": [node("text", "Hello there", json!({}))]})
        ),
        node(
            "form",
            "",
            json!({"ref": "e7", "children": [
                node("textbox", "Email", json!({"ref": "e8", "interactive": true, "value": "a@b.c"})),
                node("checkbox", "Remember me", json!({"ref": "e9", "interactive": true, "checked": true})),
                node("button", "Submit", json!({"ref": "e10", "interactive": true, "disabled": true})),
            ]})
        ),
    ]))
}

fn lines(root: &[SnapshotNode], opts: Value) -> Vec<String> {
    let formatted = format_snapshot(root, &options(opts));
    if formatted.snapshot.is_empty() {
        return Vec::new();
    }
    formatted.snapshot.split('\n').map(str::to_owned).collect()
}

fn text_of(list: Value, opts: Value) -> String {
    format_snapshot(&nodes(list), &options(opts)).snapshot
}

fn ref_keys(root: &[SnapshotNode], opts: Value) -> Vec<String> {
    format_snapshot(root, &options(opts))
        .refs
        .keys()
        .cloned()
        .collect()
}

#[test]
fn prints_an_indented_aria_tree_with_ref_en_tags_and_states() {
    assert_eq!(
        lines(&page(), json!({})),
        [
            "- heading \"Example Domain\" [ref=e1] [level=1]",
            "- navigation [ref=e2]",
            "  - list [ref=e3]",
            "    - listitem [ref=e4]",
            "      - link \"Docs\" [ref=e5]",
            "- paragraph [ref=e6]",
            "  - text: Hello there",
            "- form [ref=e7]",
            "  - textbox \"Email\" [ref=e8]: a@b.c",
            "  - checkbox \"Remember me\" [ref=e9] [checked]",
            "  - button \"Submit\" [ref=e10] [disabled]",
        ]
    );
}

#[test]
fn returns_a_ref_map_with_role_and_name_for_every_printed_ref() {
    let refs = format_snapshot(&page(), &options(json!({}))).refs;
    assert_eq!(
        refs.get("e1"),
        Some(&json!({"role": "heading", "name": "Example Domain"}))
    );
    assert_eq!(
        refs.get("e10"),
        Some(&json!({"role": "button", "name": "Submit"}))
    );
    assert_eq!(refs.len(), 10);
}

#[test]
fn keeps_only_interactive_elements_with_i_lifting_them_out_of_their_containers() {
    let formatted = format_snapshot(&page(), &options(json!({"interactive": true})));
    assert_eq!(
        formatted.snapshot,
        [
            "- link \"Docs\" [ref=e5]",
            "- textbox \"Email\" [ref=e8]: a@b.c",
            "- checkbox \"Remember me\" [ref=e9] [checked]",
            "- button \"Submit\" [ref=e10] [disabled]",
        ]
        .join("\n")
    );
    assert_eq!(
        formatted.refs.keys().collect::<Vec<_>>(),
        ["e5", "e8", "e9", "e10"]
    );
}

#[test]
fn collapses_unnamed_single_child_wrappers_with_c() {
    let snapshot = text_of(page_json(), json!({"compact": true}));
    assert!(snapshot.contains("- link \"Docs\" [ref=e5]"));
    assert!(!snapshot.contains("listitem"));
    assert!(!snapshot.contains("- list "));
    assert!(snapshot.contains("- text: Hello there"));
}

fn page_json() -> Value {
    json!([
        node(
            "heading",
            "Example Domain",
            json!({"ref": "e1", "level": 1})
        ),
        node(
            "navigation",
            "",
            json!({"ref": "e2", "children": [
                node("list", "", json!({"ref": "e3", "children": [
                    node("listitem", "", json!({"ref": "e4", "children": [
                        node("link", "Docs", json!({"ref": "e5", "interactive": true, "url": "https://x.test/docs"})),
                    ]})),
                ]})),
            ]})
        ),
        node(
            "paragraph",
            "",
            json!({"ref": "e6", "children": [node("text", "Hello there", json!({}))]})
        ),
    ])
}

#[test]
fn drops_empty_structural_nodes_with_c() {
    let snapshot = text_of(
        json!([
            node("group", "", json!({"ref": "e1"})),
            node("main", "Body", json!({}))
        ]),
        json!({"compact": true}),
    );
    assert_eq!(snapshot, "- main \"Body\"");
}

#[test]
fn stops_at_the_requested_depth_with_d() {
    let formatted = format_snapshot(&page(), &options(json!({"depth": 1})));
    assert_eq!(
        formatted.snapshot,
        [
            "- heading \"Example Domain\" [ref=e1] [level=1]",
            "- navigation [ref=e2]",
            "- paragraph [ref=e6]",
            "- form [ref=e7]",
        ]
        .join("\n")
    );
    assert_eq!(formatted.refs.get("e5"), None);
}

#[test]
fn adds_link_urls_with_u() {
    let all = lines(&page(), json!({"interactive": true, "urls": true}));
    assert_eq!(
        all[..2],
        ["- link \"Docs\" [ref=e5]", "  - /url: https://x.test/docs"]
    );
}

#[test]
fn quotes_names_as_json_strings_so_embedded_quotes_stay_unambiguous() {
    let snapshot = text_of(
        json!([node("button", "Say \"hi\"", json!({"ref": "e1"}))]),
        json!({}),
    );
    assert_eq!(snapshot, "- button \"Say \\\"hi\\\"\" [ref=e1]");
}

#[test]
fn escapes_control_characters_in_a_name_and_keeps_other_text_as_it_is() {
    let snapshot = text_of(
        json!([
            node("button", "a\nb\u{1}", json!({})),
            node("button", "Caf\u{e9} \u{65e5}\u{672c}", json!({}))
        ]),
        json!({}),
    );
    assert_eq!(
        snapshot,
        "- button \"a\\nb\\u0001\"\n- button \"Caf\u{e9} \u{65e5}\u{672c}\""
    );
}

#[test]
fn prints_an_empty_snapshot_for_no_nodes() {
    let formatted = format_snapshot(&[], &options(json!({})));
    assert_eq!(formatted.snapshot, "");
    assert!(formatted.refs.is_empty());
}

#[test]
fn prints_each_state_tag_in_a_fixed_order() {
    let snapshot = text_of(
        json!([node(
            "treeitem",
            "Row",
            json!({"ref": "e1", "level": 2, "checked": true, "disabled": true, "expanded": true, "selected": true, "value": "v"})
        )]),
        json!({}),
    );
    assert_eq!(
        snapshot,
        "- treeitem \"Row\" [ref=e1] [level=2] [checked] [disabled] [expanded=true] [selected]: v"
    );
}

#[test]
fn prints_a_mixed_checkbox_and_hides_an_unchecked_one() {
    let snapshot = text_of(
        json!([
            node("checkbox", "A", json!({"checked": "mixed"})),
            node("checkbox", "B", json!({"checked": false})),
            node("checkbox", "C", json!({}))
        ]),
        json!({}),
    );
    assert_eq!(
        snapshot,
        "- checkbox \"A\" [checked=mixed]\n- checkbox \"B\"\n- checkbox \"C\""
    );
}

#[test]
fn prints_a_level_of_zero_and_an_expanded_of_false() {
    let snapshot = text_of(
        json!([node(
            "heading",
            "H",
            json!({"level": 0, "expanded": false, "selected": false, "disabled": false})
        )]),
        json!({}),
    );
    assert_eq!(snapshot, "- heading \"H\" [level=0] [expanded=false]");
}

#[test]
fn leaves_out_an_empty_value_and_an_unnamed_role_name() {
    let snapshot = text_of(
        json!([
            node("textbox", "", json!({"value": ""})),
            node("textbox", "", json!({"value": "x"}))
        ]),
        json!({}),
    );
    assert_eq!(snapshot, "- textbox\n- textbox: x");
}

#[test]
fn prints_a_text_node_without_quotes_and_never_adds_its_value() {
    let snapshot = text_of(
        json!([node(
            "text",
            "He said \"hi\"",
            json!({"value": "ignored", "ref": "e1"})
        )]),
        json!({}),
    );
    assert_eq!(snapshot, "- text: He said \"hi\"");
}

#[test]
fn records_a_ref_on_a_text_node_and_none_for_a_node_without_one() {
    let formatted = format_snapshot(
        &nodes(json!([
            node("text", "T", json!({"ref": "e7"})),
            node("button", "B", json!({}))
        ])),
        &options(json!({})),
    );
    assert_eq!(formatted.refs.keys().collect::<Vec<_>>(), ["e7"]);
    assert_eq!(
        formatted.refs.get("e7"),
        Some(&json!({"role": "text", "name": "T"}))
    );
}

#[test]
fn keeps_the_position_of_a_repeated_ref_and_the_last_role_and_name() {
    let formatted = format_snapshot(
        &nodes(json!([
            node("button", "One", json!({"ref": "e1"})),
            node("button", "Two", json!({"ref": "e2"})),
            node("link", "Three", json!({"ref": "e1"}))
        ])),
        &options(json!({})),
    );
    assert_eq!(formatted.refs.keys().collect::<Vec<_>>(), ["e1", "e2"]);
    assert_eq!(
        formatted.refs.get("e1"),
        Some(&json!({"role": "link", "name": "Three"}))
    );
}

#[test]
fn treats_a_depth_of_zero_or_less_as_no_limit() {
    let full = lines(&page(), json!({}));
    assert_eq!(lines(&page(), json!({"depth": 0})), full);
    assert_eq!(lines(&page(), json!({"depth": -1})), full);
}

#[test]
fn counts_depth_after_the_interactive_filter() {
    assert_eq!(
        lines(&page(), json!({"interactive": true, "depth": 1})).len(),
        4
    );
}

#[test]
fn prints_a_url_line_under_a_node_that_has_one_and_only_with_u() {
    let list = json!([
        node("link", "A", json!({"url": "https://a.test"})),
        node("link", "B", json!({"url": ""})),
        node("link", "C", json!({}))
    ]);
    assert_eq!(
        text_of(list.clone(), json!({"urls": true})),
        "- link \"A\"\n  - /url: https://a.test\n- link \"B\"\n- link \"C\""
    );
    assert_eq!(
        text_of(list, json!({})),
        "- link \"A\"\n- link \"B\"\n- link \"C\""
    );
}

#[test]
fn indents_a_url_line_one_level_below_its_node() {
    let snapshot = text_of(
        json!([node(
            "list",
            "",
            json!({"children": [node("link", "A", json!({"url": "https://a.test"}))]})
        )]),
        json!({"urls": true}),
    );
    assert_eq!(
        snapshot,
        "- list\n  - link \"A\"\n    - /url: https://a.test"
    );
}

#[test]
fn keeps_the_interactive_children_of_an_interactive_node() {
    let root = nodes(json!([node(
        "tablist",
        "",
        json!({"children": [node("tab", "One", json!({"interactive": true, "children": [
            node("button", "Close", json!({"interactive": true})),
            node("text", "label", json!({}))
        ]}))]})
    )]));
    assert_eq!(
        lines(&root, json!({"interactive": true})),
        ["- tab \"One\"", "  - button \"Close\""]
    );
}

#[test]
fn drops_text_nodes_with_the_interactive_filter() {
    let root = nodes(json!([node("text", "plain", json!({}))]));
    assert_eq!(
        lines(&root, json!({"interactive": true})),
        Vec::<String>::new()
    );
}

#[test]
fn drops_a_text_node_with_no_content_with_c_and_keeps_one_with_content() {
    let snapshot = text_of(
        json!([node("text", "", json!({})), node("text", "kept", json!({}))]),
        json!({"compact": true}),
    );
    assert_eq!(snapshot, "- text: kept");
}

#[test]
fn keeps_a_structural_node_with_two_children_with_c() {
    let snapshot = text_of(
        json!([node(
            "group",
            "",
            json!({"children": [
                node("button", "A", json!({})),
                node("button", "B", json!({}))
            ]})
        )]),
        json!({"compact": true}),
    );
    assert_eq!(snapshot, "- group\n  - button \"A\"\n  - button \"B\"");
}

#[test]
fn keeps_an_interactive_node_with_no_name_with_c() {
    let snapshot = text_of(
        json!([node(
            "textbox",
            "",
            json!({"interactive": true, "children": [
                node("group", "", json!({"children": [node("button", "X", json!({}))]}))
            ]})
        )]),
        json!({"compact": true}),
    );
    assert_eq!(snapshot, "- textbox\n  - button \"X\"");
}

#[test]
fn lifts_a_wrapper_chain_down_to_the_first_node_that_has_a_name() {
    let snapshot = text_of(
        json!([node(
            "group",
            "",
            json!({"children": [
                node("group", "", json!({"children": [node("main", "Body", json!({}))]}))
            ]})
        )]),
        json!({"compact": true}),
    );
    assert_eq!(snapshot, "- main \"Body\"");
}

#[test]
fn lifts_a_wrapper_chain_and_loses_the_ref_of_the_wrapper_with_c() {
    let formatted = format_snapshot(
        &nodes(json!([node(
            "group",
            "",
            json!({"ref": "e1", "children": [
                node("button", "Go", json!({"ref": "e2"}))
            ]})
        )])),
        &options(json!({"compact": true})),
    );
    assert_eq!(formatted.refs.keys().collect::<Vec<_>>(), ["e2"]);
}

#[test]
fn applies_the_interactive_filter_before_compact() {
    assert_eq!(
        lines(&page(), json!({"interactive": true, "compact": true})),
        lines(&page(), json!({"interactive": true}))
    );
}

#[test]
fn lists_only_interactive_refs_with_the_interactive_filter() {
    assert_eq!(
        ref_keys(&page(), json!({"interactive": true})),
        ["e5", "e8", "e9", "e10"]
    );
}

#[test]
fn prints_a_fractional_or_huge_level_as_js_prints_it() {
    let root = nodes(json!([
        node("heading", "a", json!({"level": 2.5})),
        node("heading", "b", json!({"level": 1e20})),
    ]));
    assert_eq!(
        lines(&root, json!({})),
        vec![
            "- heading \"a\" [level=2.5]".to_owned(),
            "- heading \"b\" [level=100000000000000000000]".to_owned(),
        ]
    );
}

#[test]
fn takes_a_fractional_depth_as_the_limit() {
    let root = nodes(json!([node(
        "list",
        "l",
        json!({"children": [node("listitem", "i", json!({"children": [node("link", "k", json!({}))]}))]})
    )]));
    assert_eq!(lines(&root, json!({"depth": 1.5})).len(), 2);
}
