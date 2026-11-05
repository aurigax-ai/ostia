use ostia_contract::view_bindings::ViewFormat;
use ostia_contract::view_parse::{ViewParseResult, parse_view_text};
use ostia_contract::views::{
    VIEW_MAX_LIST_ITEMS, VIEW_MAX_RENDERED_NODES, ViewButtonVariant, ViewDoc, ViewGap, ViewIcon,
    ViewIconTone, ViewJustify, ViewTextSize, ViewTone, ViewWeight,
};
use ostia_model::views::view_expand::{
    BudgetProblem, RenderKind, RenderNode, ViewActionTarget, expand_view,
};
use serde_json::{Map, Value, json};

fn fmt() -> ViewFormat {
    ViewFormat {
        now: 0.0,
        locale: "en".to_owned(),
    }
}

fn view(root: Value) -> ViewDoc {
    let text =
        json!({ "version": 1, "title": "T", "placement": "panel", "root": root }).to_string();
    match parse_view_text(&text) {
        ViewParseResult::Ok(doc) => *doc,
        ViewParseResult::Failed(problems) => panic!("{problems:?}"),
    }
}

fn scope(data: Value) -> Map<String, Value> {
    data.as_object().unwrap().clone()
}

fn expanded(doc: &ViewDoc, data: Value) -> RenderNode {
    expand_view(doc, &scope(data), &fmt())
        .expect("a render")
        .expect("a root")
}

fn list_of(item: Value, extra: Value) -> Value {
    let mut node = json!({ "type": "list", "for": "workspaces", "as": "ws", "item": item });
    node.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    node
}

fn list_items(node: &RenderNode) -> &[RenderNode] {
    match &node.kind {
        RenderKind::List { items, .. } => items,
        other => panic!("expected a list, got {other:?}"),
    }
}

fn children(node: &RenderNode) -> &[RenderNode] {
    match &node.kind {
        RenderKind::Stack { children, .. }
        | RenderKind::Row { children, .. }
        | RenderKind::Section { children, .. } => children,
        other => panic!("expected children, got {other:?}"),
    }
}

fn text_of(node: &RenderNode) -> &str {
    match &node.kind {
        RenderKind::Text { text, .. } => text,
        _ => "",
    }
}

fn ratio_of(node: &RenderNode) -> f64 {
    match &node.kind {
        RenderKind::Progress { ratio, .. } => *ratio,
        other => panic!("expected progress, got {other:?}"),
    }
}

fn workspaces_of(count: usize, item: impl Fn(usize) -> Value) -> Value {
    json!({ "workspaces": (0..count).map(item).collect::<Vec<_>>() })
}

#[test]
fn repeats_a_list_item_for_each_entry_with_its_own_scope() {
    let doc = view(list_of(
        json!({ "type": "text", "text": "{{ws.name}} ({{ws.unread}})" }),
        json!({}),
    ));
    let root = expanded(
        &doc,
        json!({ "workspaces": [{ "id": "w1", "name": "ostia", "unread": 2 }, { "name": "x" }] }),
    );
    let items = list_items(&root);
    assert_eq!(
        items.iter().map(text_of).collect::<Vec<_>>(),
        ["ostia (2)", "x ()"]
    );
    assert_eq!(
        items.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
        ["root#w1", "root@1"]
    );
}

#[test]
fn shows_the_empty_text_when_the_list_has_nothing() {
    let doc = view(list_of(
        json!({ "type": "divider" }),
        json!({ "empty": "None" }),
    ));
    let root = expanded(&doc, json!({ "workspaces": [] }));
    match root.kind {
        RenderKind::List { items, empty, .. } => {
            assert!(items.is_empty());
            assert_eq!(empty.as_deref(), Some("None"));
        }
        other => panic!("expected a list, got {other:?}"),
    }
}

#[test]
fn skips_nodes_whose_if_binding_is_falsy() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            { "type": "badge", "text": "unread", "if": "{{workspace.unread}}" },
            { "type": "badge", "text": "clear", "if": "{{workspace.unread | not}}" },
        ],
    }));
    let root = expanded(&doc, json!({ "workspace": { "unread": 0 } }));
    let texts: Vec<&str> = children(&root)
        .iter()
        .map(|child| match &child.kind {
            RenderKind::Badge { text, .. } => text.as_str(),
            other => panic!("expected a badge, got {other:?}"),
        })
        .collect();
    assert_eq!(texts, ["clear"]);
}

#[test]
fn resolves_command_args_per_item_and_keeps_the_template_for_trust() {
    let doc = view(list_of(
        json!({
            "type": "button",
            "label": "Go",
            "action": { "command": "workspace.goto", "args": { "index": "{{ws.index}}" } },
        }),
        json!({}),
    ));
    let root = expanded(&doc, json!({ "workspaces": [{ "index": 3 }] }));
    let RenderKind::Button { action, .. } = &list_items(&root)[0].kind else {
        panic!("expected a button");
    };
    assert_eq!(
        action,
        &ViewActionTarget::Command {
            command: "workspace.goto".to_owned(),
            template: Some(scope(json!({ "index": "{{ws.index}}" }))),
            args: Some(scope(json!({ "index": 3 }))),
        }
    );
}

#[test]
fn drops_urls_that_do_not_resolve_to_http_or_https() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            { "type": "link", "label": "a", "url": "{{workspace.url}}" },
            { "type": "button", "label": "b", "action": { "openUrl": "{{workspace.url}}" } },
        ],
    }));
    let bad = expanded(
        &doc,
        json!({ "workspace": { "url": "javascript:alert(1)" } }),
    );
    let kids = children(&bad);
    assert!(matches!(&kids[0].kind, RenderKind::Link { url: None, .. }));
    assert!(matches!(
        &kids[1].kind,
        RenderKind::Button {
            action: ViewActionTarget::Url { url: None },
            ..
        }
    ));
    let good = expanded(
        &doc,
        json!({ "workspace": { "url": "http://localhost:5173/" } }),
    );
    let RenderKind::Link { url, .. } = &children(&good)[0].kind else {
        panic!("expected a link");
    };
    assert_eq!(url.as_deref(), Some("http://localhost:5173/"));
}

#[test]
fn clamps_progress_to_0_to_1_of_max() {
    let doc = view(json!({ "type": "progress", "value": "{{approvals.pending}}", "max": 4 }));
    let table = [
        (json!({ "approvals": { "pending": 1 } }), 0.25),
        (json!({ "approvals": { "pending": 9 } }), 1.0),
        (json!({ "approvals": {} }), 0.0),
    ];
    for (data, want) in table {
        assert_eq!(ratio_of(&expanded(&doc, data.clone())), want, "{data}");
    }
}

#[test]
fn fails_the_budget_when_a_list_without_a_limit_is_too_long() {
    let doc = view(list_of(json!({ "type": "divider" }), json!({})));
    let data = workspaces_of(VIEW_MAX_LIST_ITEMS + 1, |i| json!({ "i": i }));
    assert_eq!(
        expand_view(&doc, &scope(data.clone()), &fmt()),
        Err(BudgetProblem::List {
            path: "root".to_owned(),
            count: VIEW_MAX_LIST_ITEMS + 1,
            max: VIEW_MAX_LIST_ITEMS,
        })
    );
    let limited = view(list_of(json!({ "type": "divider" }), json!({ "limit": 5 })));
    let root = expanded(&limited, data);
    assert_eq!(list_items(&root).len(), 5);
}

#[test]
fn fails_the_budget_when_nested_lists_draw_too_many_nodes() {
    let doc = view(list_of(
        json!({
            "type": "list",
            "for": "ws.items",
            "as": "it",
            "item": { "type": "row", "children": [{ "type": "text", "text": "{{it}}" }] },
        }),
        json!({}),
    ));
    let items: Vec<usize> = (0..VIEW_MAX_LIST_ITEMS).collect();
    let data = workspaces_of(VIEW_MAX_LIST_ITEMS, |_| json!({ "items": items }));
    assert_eq!(
        expand_view(&doc, &scope(data), &fmt()),
        Err(BudgetProblem::Nodes {
            max: VIEW_MAX_RENDERED_NODES
        })
    );
}

#[test]
fn renders_no_root_when_the_root_if_binding_is_falsy() {
    let doc = view(json!({ "type": "divider", "if": "{{workspace}}" }));
    assert_eq!(
        expand_view(&doc, &scope(json!({ "workspace": null })), &fmt()),
        Ok(None)
    );
}

#[test]
fn fills_every_default_of_the_container_and_text_nodes() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            { "type": "row", "children": [] },
            { "type": "section", "title": "Hi {{workspace.who}}", "children": [] },
            { "type": "text", "text": "t" },
            { "type": "badge", "text": "b" },
            { "type": "icon", "name": "bell" },
            { "type": "divider" },
        ],
    }));
    let root = expanded(&doc, json!({ "workspace": { "who": "you" } }));
    let RenderKind::Stack { gap, .. } = &root.kind else {
        panic!("expected a stack");
    };
    assert_eq!(*gap, ViewGap::Sm);
    let kids = children(&root);
    assert_eq!(
        kids.iter().map(|k| k.key.as_str()).collect::<Vec<_>>(),
        ["root/0", "root/1", "root/2", "root/3", "root/4", "root/5"]
    );
    assert_eq!(
        kids[0].kind,
        RenderKind::Row {
            gap: ViewGap::Sm,
            justify: ViewJustify::Start,
            wrap: false,
            children: vec![]
        }
    );
    assert_eq!(
        kids[1].kind,
        RenderKind::Section {
            title: "Hi you".to_owned(),
            collapsed: false,
            children: vec![]
        }
    );
    assert_eq!(
        kids[2].kind,
        RenderKind::Text {
            text: "t".to_owned(),
            tone: ViewTone::Neutral,
            size: ViewTextSize::Sm,
            weight: ViewWeight::Regular,
            mono: false,
            truncate: false
        }
    );
    assert_eq!(
        kids[3].kind,
        RenderKind::Badge {
            text: "b".to_owned(),
            tone: ViewTone::Neutral
        }
    );
    assert_eq!(
        kids[4].kind,
        RenderKind::Icon {
            name: ViewIcon::Bell,
            tone: ViewIconTone::Muted,
            label: String::new()
        }
    );
    assert_eq!(kids[5].kind, RenderKind::Divider);
}

#[test]
fn fills_every_default_of_the_list_button_and_progress_nodes() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            list_of(json!({ "type": "divider" }), json!({ "empty": "None" })),
            { "type": "button", "label": "Go", "action": { "command": "a.b" } },
            { "type": "progress", "value": 50, "label": "Half" },
        ],
    }));
    let root = expanded(&doc, json!({ "workspaces": [{}] }));
    let kids = children(&root);
    assert!(matches!(
        &kids[0].kind,
        RenderKind::List { gap: ViewGap::None, empty: None, items, .. } if items.len() == 1
    ));
    assert_eq!(
        kids[1].kind,
        RenderKind::Button {
            label: "Go".to_owned(),
            icon: None,
            variant: ViewButtonVariant::Outline,
            action: ViewActionTarget::Command {
                command: "a.b".to_owned(),
                template: None,
                args: None
            }
        }
    );
    assert_eq!(
        kids[2].kind,
        RenderKind::Progress {
            ratio: 0.5,
            label: "Half".to_owned(),
            tone: ViewTone::Brand
        }
    );
}

#[test]
fn keys_list_items_by_a_string_or_number_id_and_by_index_otherwise() {
    let doc = view(list_of(json!({ "type": "divider" }), json!({})));
    let root = expanded(
        &doc,
        json!({ "workspaces": [{ "id": 7 }, { "id": "a" }, { "id": true }, { "id": null }, 5, "s"] }),
    );
    assert_eq!(
        list_items(&root)
            .iter()
            .map(|i| i.key.as_str())
            .collect::<Vec<_>>(),
        ["root#7", "root#a", "root@2", "root@3", "root@4", "root@5"]
    );
}

#[test]
fn treats_a_missing_or_non_array_list_source_as_empty() {
    let doc = view(list_of(
        json!({ "type": "divider" }),
        json!({ "empty": "None" }),
    ));
    for data in [
        json!({}),
        json!({ "workspaces": "abc" }),
        json!({ "workspaces": { "a": 1 } }),
    ] {
        let root = expanded(&doc, data.clone());
        let RenderKind::List { items, empty, .. } = root.kind else {
            panic!("expected a list");
        };
        assert!(items.is_empty(), "{data}");
        assert_eq!(empty.as_deref(), Some("None"), "{data}");
    }
}

#[test]
fn hides_the_empty_text_when_the_list_has_items() {
    let doc = view(list_of(
        json!({ "type": "divider" }),
        json!({ "empty": "None" }),
    ));
    let root = expanded(&doc, json!({ "workspaces": [{}] }));
    assert!(matches!(
        root.kind,
        RenderKind::List { empty: None, ref items, .. } if items.len() == 1
    ));
}

#[test]
fn does_not_leak_the_item_scope_out_of_the_list() {
    let text = json!({
        "version": 1,
        "title": "T",
        "placement": "panel",
        "root": {
            "type": "stack",
            "children": [
                list_of(json!({ "type": "divider" }), json!({})),
                { "type": "text", "text": "[{{ws.name}}]" },
            ],
        },
    })
    .to_string();
    match parse_view_text(&text) {
        ViewParseResult::Failed(problems) => {
            assert_eq!(problems[0].path, "root.children[1].text");
            assert!(problems[0].message.starts_with("unknown data source 'ws'"));
        }
        ViewParseResult::Ok(_) => panic!("the item scope must not reach outside the list"),
    }
}

#[test]
fn skips_list_items_whose_if_binding_is_falsy() {
    let doc = view(list_of(
        json!({ "type": "divider", "if": "{{ws.show}}" }),
        json!({ "limit": 50 }),
    ));
    let data = workspaces_of(50, |i| json!({ "show": i == 0 }));
    let root = expanded(&doc, data);
    assert_eq!(list_items(&root).len(), 1);
}

#[test]
fn turns_a_non_numeric_or_non_finite_progress_value_into_zero() {
    let table = [
        (
            json!({ "type": "progress", "value": "{{workspace.v}}" }),
            json!({ "workspace": { "v": "abc" } }),
        ),
        (
            json!({ "type": "progress", "value": "{{workspace.v}}" }),
            json!({ "workspace": { "v": null } }),
        ),
    ];
    for (node, data) in table {
        let doc = view(node.clone());
        assert_eq!(
            ratio_of(&expanded(&doc, data.clone())),
            0.0,
            "{node} {data}"
        );
    }
}

#[test]
fn reads_a_numeric_string_as_a_progress_value() {
    let doc = view(json!({ "type": "progress", "value": "{{workspace.v}}" }));
    assert_eq!(
        ratio_of(&expanded(&doc, json!({ "workspace": { "v": "40" } }))),
        0.4
    );
    assert_eq!(
        ratio_of(&expanded(&doc, json!({ "workspace": { "v": -5 } }))),
        0.0
    );
}

#[test]
fn renders_kv_pairs_and_an_icon_label_with_their_bindings() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            { "type": "kv", "items": [{ "key": "{{workspace.k}}", "value": "{{workspace.v | upper}}" }] },
            { "type": "icon", "name": "bell", "label": "{{workspace.k}}" },
        ],
    }));
    let root = expanded(&doc, json!({ "workspace": { "k": "Name", "v": "abc" } }));
    let kids = children(&root);
    let RenderKind::Kv { items } = &kids[0].kind else {
        panic!("expected kv");
    };
    assert_eq!(
        (items[0].key.as_str(), items[0].value.as_str()),
        ("Name", "ABC")
    );
    assert!(matches!(
        &kids[1].kind,
        RenderKind::Icon { label, .. } if label == "Name"
    ));
}

#[test]
fn builds_nested_keys_from_the_child_index_and_the_list_item_key() {
    let doc = view(json!({
        "type": "stack",
        "children": [
            { "type": "divider" },
            list_of(
                json!({ "type": "row", "children": [{ "type": "divider" }] }),
                json!({}),
            ),
        ],
    }));
    let root = expanded(&doc, json!({ "workspaces": [{ "id": "w1" }] }));
    let item = &list_items(&children(&root)[1])[0];
    assert_eq!(item.key, "root/1#w1");
    assert_eq!(children(item)[0].key, "root/1#w1/0");
}

#[test]
fn passes_open_url_through_when_it_resolves_to_https() {
    let doc = view(json!({
        "type": "button",
        "label": "b",
        "action": { "openUrl": "https://example.com/{{workspace.p}}" },
    }));
    let root = expanded(&doc, json!({ "workspace": { "p": "x" } }));
    assert!(matches!(
        root.kind,
        RenderKind::Button {
            action: ViewActionTarget::Url { url: Some(ref url) },
            ..
        } if url == "https://example.com/x"
    ));
}
