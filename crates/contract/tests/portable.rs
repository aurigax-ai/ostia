#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use indexmap::IndexMap;
use ostia_contract::html_preview::normalize_preview_theme;
use ostia_contract::portable::{
    PORTABLE_CSP, PORTABLE_FORMAT, PortableManifest, PortableType, document_page,
    portable_file_name, portable_sandbox, portable_type, runs_scripts, wrap_portable,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../test/fixtures/rust/portable-html.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

fn kind_of(name: &str) -> PortableType {
    match name {
        "component" => PortableType::Component,
        "page" => PortableType::Page,
        "markdown" => PortableType::Markdown,
        "svg" => PortableType::Svg,
        "json" => PortableType::Json,
        "tables" => PortableType::Tables,
        other => panic!("unknown type {other}"),
    }
}

fn manifest_of(value: &Value) -> PortableManifest {
    PortableManifest {
        format: text(value, "format"),
        kind: kind_of(value["type"].as_str().unwrap()),
        name: text(value, "name"),
        built: text(value, "built"),
        ostia: text(value, "ostia"),
        libraries: value["libraries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|library| library.as_str().unwrap().to_owned())
            .collect(),
        theme: normalize_preview_theme(&value["theme"]),
        hash: text(value, "hash"),
        sources: value["sources"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, source)| (name.clone(), source.as_str().unwrap().to_owned()))
            .collect::<IndexMap<String, String>>(),
    }
}

#[test]
fn maps_an_extension_to_a_portable_type_ignoring_case() {
    for (path, want) in [
        ("/a/App.jsx", Some(PortableType::Component)),
        ("/a/App.TSX", Some(PortableType::Component)),
        ("/a/page.html", Some(PortableType::Page)),
        ("/a/page.HTM", Some(PortableType::Page)),
        ("/a/notes.md", Some(PortableType::Markdown)),
        ("/a/notes.Markdown", Some(PortableType::Markdown)),
        ("/a/logo.svg", Some(PortableType::Svg)),
        ("/a/data.json", Some(PortableType::Json)),
        ("C:\\a\\data.JSON", Some(PortableType::Json)),
        ("/a/lib.ts", None),
        ("/a/archive.tar.gz", None),
        ("/a/App.tsx.bak", None),
        ("/a/noext", None),
        ("/a/ends.", None),
        ("/a.d/noext", None),
        ("/a.d\\noext", None),
        ("/a/.gitignore", None),
        ("/a/tables", None),
        ("", None),
    ] {
        assert_eq!(portable_type(Some(path)), want, "{path}");
    }
    assert_eq!(portable_type(None), None);
}

#[test]
fn runs_scripts_only_for_a_component_or_a_page() {
    for (kind, want) in [
        (PortableType::Component, true),
        (PortableType::Page, true),
        (PortableType::Markdown, false),
        (PortableType::Svg, false),
        (PortableType::Json, false),
        (PortableType::Tables, false),
    ] {
        assert_eq!(runs_scripts(kind), want, "{kind:?}");
    }
}

#[test]
fn sandboxes_a_script_type_with_scripts_and_the_rest_with_popups_only() {
    for kind in [PortableType::Component, PortableType::Page] {
        assert_eq!(portable_sandbox(kind), "allow-scripts", "{kind:?}");
    }
    for kind in [
        PortableType::Markdown,
        PortableType::Svg,
        PortableType::Json,
        PortableType::Tables,
    ] {
        assert_eq!(
            portable_sandbox(kind),
            "allow-popups allow-popups-to-escape-sandbox",
            "{kind:?}"
        );
    }
}

#[test]
fn locks_the_page_down_to_inline_code_and_data_urls() {
    assert_eq!(PORTABLE_FORMAT, "ostia-artifact/1");
    let directives: Vec<&str> = PORTABLE_CSP.split("; ").collect();
    for directive in [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "connect-src 'none'",
        "worker-src 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
    ] {
        assert!(directives.contains(&directive), "{directive}");
    }
}

#[test]
fn wraps_a_document_in_the_same_html_as_the_ts_app() {
    let rows = fixture();
    for (index, row) in rows["wrap"].as_array().unwrap().iter().enumerate() {
        let html = wrap_portable(
            row["document"].as_str().unwrap(),
            &manifest_of(&row["manifest"]),
        );
        assert_eq!(html, text(row, "html"), "row {index}");
    }
}

#[test]
fn builds_a_document_page_in_the_same_html_as_the_ts_app() {
    let rows = fixture();
    for (index, row) in rows["page"].as_array().unwrap().iter().enumerate() {
        let html = document_page(
            row["title"].as_str().unwrap(),
            row["body"].as_str().unwrap(),
            row["css"].as_str().unwrap(),
            &normalize_preview_theme(&row["theme"]),
        );
        assert_eq!(html, text(row, "html"), "row {index}");
    }
}

#[test]
fn names_the_saved_file_after_the_artifact_with_an_html_extension() {
    let rows = fixture();
    for row in rows["fileNames"].as_array().unwrap() {
        let path = row["path"].as_str().unwrap();
        assert_eq!(portable_file_name(path), text(row, "name"), "{path:?}");
    }
}

#[test]
fn escapes_the_title_and_the_manifest_so_neither_can_close_its_element() {
    let rows = fixture();
    let row = &rows["wrap"][1];
    let html = wrap_portable(
        row["document"].as_str().unwrap(),
        &manifest_of(&row["manifest"]),
    );
    assert!(html.contains("<title>A &lt;b&gt;&amp;&lt;/b&gt; \"c\"</title>"));
    let manifest_line = html
        .lines()
        .find(|line| line.starts_with("<script type=\"application/json\""))
        .unwrap();
    assert_eq!(manifest_line.matches('<').count(), 2);
    assert!(manifest_line.contains("\\u003c/script>"));
}

#[test]
fn drops_an_empty_style_block_and_ends_without_a_newline() {
    let rows = fixture();
    let plain = &rows["page"][0];
    let html = document_page(
        "Plain",
        "<p>hi</p>",
        "",
        &normalize_preview_theme(&plain["theme"]),
    );
    assert_eq!(html.matches("<style>").count(), 1);
    assert!(html.ends_with("</html>"));
}
