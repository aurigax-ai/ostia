use ostia_model::assist::chat_links::{
    FileLinkTarget, file_link_of, is_web_url, rehype_file_links, whole_file_link,
};
use serde_json::{Map, Value, json};

fn text(value: &str) -> Value {
    json!({ "type": "text", "value": value })
}

fn element(tag_name: &str, children: Vec<Value>) -> Value {
    json!({ "type": "element", "tagName": tag_name, "properties": {}, "children": children })
}

fn linked(mut tree: Value) -> Value {
    rehype_file_links(&mut tree);
    tree
}

fn as_props(node: &Value) -> Map<String, Value> {
    let mut props = Map::new();
    for (key, value) in node["properties"].as_object().unwrap() {
        let mut kebab = String::new();
        for ch in key.chars() {
            if ch.is_ascii_uppercase() {
                kebab.push('-');
                kebab.push(ch.to_ascii_lowercase());
            } else {
                kebab.push(ch);
            }
        }
        props.insert(kebab, value.clone());
    }
    props
}

fn target(path: &str, line: Option<u32>, column: Option<u32>) -> FileLinkTarget {
    FileLinkTarget {
        path: path.to_owned(),
        line: line.map(f64::from),
        column: column.map(f64::from),
    }
}

fn props(entries: &[(&str, Value)]) -> Map<String, Value> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

#[test]
fn links_a_path_with_a_line_in_an_answers_text_to_that_file_and_line() {
    let root = linked(json!({
        "type": "root",
        "children": [element("p", vec![text("The line is in /w/project/notes.txt:3 near the top.")])],
    }));
    let children = root["children"][0]["children"].as_array().unwrap();
    assert_eq!(children.len(), 3);
    assert_eq!(children[0], text("The line is in "));
    assert_eq!(children[2], text(" near the top."));
    let link = &children[1];
    assert_eq!(link["type"], "element");
    assert_eq!(link["tagName"], "a");
    assert_eq!(link["children"], json!([text("/w/project/notes.txt:3")]));
    assert_eq!(
        file_link_of(&as_props(link)),
        Some(target("/w/project/notes.txt", Some(3), None))
    );
}

#[test]
fn leaves_paths_inside_code_code_blocks_and_links_as_they_are() {
    let children = || {
        vec![
            element(
                "p",
                vec![
                    element("code", vec![text("notes.txt:3")]),
                    element("a", vec![text("notes.txt")]),
                ],
            ),
            element("pre", vec![element("code", vec![text("cat notes.txt")])]),
        ]
    };
    let root = linked(json!({ "type": "root", "children": children() }));
    assert_eq!(root["children"], Value::Array(children()));
}

#[test]
fn links_a_path_inside_nested_elements_and_keeps_text_without_a_path() {
    let root = linked(json!({
        "type": "root",
        "children": [element("ul", vec![element("li", vec![text("see src/a.ts:12:4")]), element("li", vec![text("nothing here")])])],
    }));
    let items = root["children"][0]["children"].as_array().unwrap();
    let first = items[0]["children"].as_array().unwrap();
    assert_eq!(first[0], text("see "));
    assert_eq!(
        file_link_of(&as_props(&first[1])),
        Some(target("src/a.ts", Some(12), Some(4)))
    );
    assert_eq!(items[1]["children"], json!([text("nothing here")]));
}

#[test]
fn links_every_path_in_one_text_node_and_keeps_the_text_between() {
    let root = linked(json!({
        "type": "root",
        "children": [text("a /w/x.rs:1 and /w/y.rs:2")],
    }));
    let nodes = root["children"].as_array().unwrap();
    assert_eq!(nodes.len(), 4);
    assert_eq!(nodes[0], text("a "));
    assert_eq!(nodes[2], text(" and "));
    assert_eq!(
        file_link_of(&as_props(&nodes[1])),
        Some(target("/w/x.rs", Some(1), None))
    );
    assert_eq!(
        file_link_of(&as_props(&nodes[3])),
        Some(target("/w/y.rs", Some(2), None))
    );
}

#[test]
fn leaves_a_tree_without_children_untouched() {
    let leaf = text("plain");
    assert_eq!(linked(leaf.clone()), leaf);
}

#[test]
fn reads_nothing_from_an_element_without_a_path() {
    assert_eq!(
        file_link_of(&props(&[("href", json!("https://example.com"))])),
        None
    );
}

#[test]
fn reads_nothing_from_an_empty_or_non_string_path() {
    assert_eq!(
        file_link_of(&props(&[("data-ostia-path", json!(""))])),
        None
    );
    assert_eq!(file_link_of(&props(&[("data-ostia-path", json!(7))])), None);
}

#[test]
fn reads_the_line_and_column_only_when_they_are_positive_numbers() {
    let with = |line: Value, column: Value| {
        file_link_of(&props(&[
            ("data-ostia-path", json!("a.ts")),
            ("data-ostia-line", line),
            ("data-ostia-column", column),
        ]))
    };
    assert_eq!(
        with(json!("12"), json!("4")),
        Some(target("a.ts", Some(12), Some(4)))
    );
    assert_eq!(
        with(json!("0"), json!("-1")),
        Some(target("a.ts", None, None))
    );
    assert_eq!(
        with(json!("x"), json!("")),
        Some(target("a.ts", None, None))
    );
    assert_eq!(
        file_link_of(&props(&[("data-ostia-path", json!("a.ts"))])),
        Some(target("a.ts", None, None))
    );
}

#[test]
fn takes_inline_code_that_is_exactly_a_path_with_a_line_and_column() {
    assert_eq!(
        whole_file_link(" src/a.ts:12:4 "),
        Some(target("src/a.ts", Some(12), Some(4)))
    );
    assert_eq!(whole_file_link("npm run build"), None);
}

#[test]
fn refuses_inline_code_that_has_a_path_and_more_text() {
    assert_eq!(whole_file_link("cat src/a.ts"), None);
    assert_eq!(whole_file_link("   "), None);
}

#[test]
fn takes_a_path_without_a_line_as_a_whole_link() {
    assert_eq!(
        whole_file_link("src/a.ts"),
        Some(target("src/a.ts", None, None))
    );
}

#[test]
fn knows_a_web_url_by_its_http_or_https_protocol() {
    assert!(is_web_url("https://example.com/a?b=1"));
    assert!(is_web_url("http://localhost:3000"));
    assert!(!is_web_url("ftp://example.com"));
    assert!(!is_web_url("mailto:a@b.c"));
    assert!(!is_web_url("javascript:alert(1)"));
    assert!(!is_web_url("src/a.ts"));
    assert!(!is_web_url(""));
}

#[test]
fn keeps_a_fractional_or_infinite_line_like_js_number() {
    let with = |line: Value| {
        file_link_of(&props(&[
            ("data-ostia-path", json!("a.ts")),
            ("data-ostia-line", line),
        ]))
        .unwrap()
        .line
    };
    assert_eq!(with(json!("1.5")), Some(1.5));
    assert_eq!(with(json!("1e400")), Some(f64::INFINITY));
    assert_eq!(with(json!("Infinity")), Some(f64::INFINITY));
}
