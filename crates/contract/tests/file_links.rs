#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::file_links::{find_file_links, resolve_link_path};

type Link = (String, Option<u64>, Option<u64>);

fn paths(text: &str) -> Vec<Link> {
    find_file_links(text)
        .into_iter()
        .map(|link| (link.path, link.line, link.column))
        .collect()
}

fn link(path: &str, line: Option<u64>, column: Option<u64>) -> Link {
    (path.to_owned(), line, column)
}

#[test]
fn finds_compiler_style_paths_with_line_and_column() {
    assert_eq!(
        paths("src/app.ts:42:7 - error TS2345"),
        [link("src/app.ts", Some(42), Some(7))]
    );
    assert_eq!(
        paths("  at run (/home/u/p/main.js:10:3)"),
        [link("/home/u/p/main.js", Some(10), Some(3))]
    );
    assert_eq!(
        paths("./lib/util.py:8: warning"),
        [link("./lib/util.py", Some(8), None)]
    );
}

#[test]
fn finds_paths_with_line_col_and_python_tracebacks() {
    assert_eq!(
        paths("Program.cs(12,5): error CS1002"),
        [link("Program.cs", Some(12), Some(5))]
    );
    assert_eq!(
        paths("  File \"/srv/app/views.py\", line 88, in index"),
        [link("/srv/app/views.py", Some(88), None)]
    );
}

#[test]
fn finds_bare_file_names_with_an_extension_and_home_relative_paths() {
    assert_eq!(
        paths("modified:   README.md"),
        [link("README.md", None, None)]
    );
    assert_eq!(
        paths("open ~/notes/todo.txt now"),
        [link("~/notes/todo.txt", None, None)]
    );
    assert_eq!(
        paths("../shared/types.ts"),
        [link("../shared/types.ts", None, None)]
    );
}

#[test]
fn reports_the_exact_span_so_the_link_covers_path_and_position() {
    let text = "error: src/a.ts:3:9 failed";
    let found = find_file_links(text);
    let first = found.first().unwrap();
    assert_eq!(&text[first.start..first.end], "src/a.ts:3:9");
}

#[test]
fn ignores_urls_version_numbers_plain_words_and_trailing_punctuation() {
    assert!(paths("see https://example.com/a/b.html").is_empty());
    assert!(paths("node v20.11.1 and 3.14").is_empty());
    assert!(paths("hello world").is_empty());
    assert_eq!(
        paths("edit (src/index.ts)."),
        [link("src/index.ts", None, None)]
    );
}

#[test]
fn does_not_start_a_path_in_the_middle_of_a_word() {
    assert!(paths("user@host.com").is_empty());
}

#[test]
fn resolves_relative_paths_against_the_pane_cwd_and_keeps_tilde_for_main_to_expand() {
    let table = [
        ("src/a.ts", "/home/u/proj", "/home/u/proj/src/a.ts"),
        ("../b.ts", "/home/u/proj/sub", "/home/u/proj/b.ts"),
        ("~/x.md", "/tmp", "~/x.md"),
        ("~/../x", "/tmp", "~/../x"),
        ("~/a/../../..", "/tmp", "~/../.."),
        ("/../x", "/tmp", "/x"),
        ("a.md", "~/proj", "~/proj/a.md"),
        ("/etc/./hosts", "/tmp", "/etc/hosts"),
    ];
    for (path, cwd, expected) in table {
        assert_eq!(resolve_link_path(path, cwd), expected, "{path} in {cwd}");
    }
}

#[test]
fn reports_the_span_in_utf16_units_as_the_ts_scanner_does() {
    let text = "😀 src/a.ts:3 é(b.rs)";
    let found = find_file_links(text);
    let spans: Vec<(usize, usize, &str)> = found
        .iter()
        .map(|link| (link.start, link.end, link.path.as_str()))
        .collect();
    assert_eq!(spans, [(3, 13, "src/a.ts"), (16, 20, "b.rs")]);
}

#[test]
fn drops_a_zero_line_and_column_from_every_form() {
    assert_eq!(
        paths("a/b.ts:0:0 x(0,0).c"),
        [link("a/b.ts", None, None), link("x", None, None)]
    );
    assert_eq!(
        paths("File \"/srv/a.py\", line 0"),
        [link("/srv/a.py", None, None)]
    );
}

#[test]
fn reads_a_parenthesised_position_with_or_without_a_space_after_the_comma() {
    assert_eq!(paths("a/b.cs(7, 2)"), [link("a/b.cs", Some(7), Some(2))]);
    assert_eq!(paths("a/b.cs(7)"), [link("a/b.cs", Some(7), None)]);
}

#[test]
fn skips_a_path_after_a_url_scheme_or_before_double_slash() {
    assert!(paths("ftp://host/dir/file.txt").is_empty());
    assert!(paths("//cdn/file.js").is_empty());
}

#[test]
fn refuses_a_bare_word_unless_it_ends_in_a_short_alphabetic_extension() {
    assert!(paths("v1.2").is_empty());
    assert!(paths("name.verylongextension").is_empty());
    assert_eq!(paths("make.sh"), [link("make.sh", None, None)]);
    assert!(paths("../").is_empty());
}

#[test]
fn finds_several_links_in_one_line() {
    assert_eq!(
        paths("a/x.rs:1 b/y.rs:2:3"),
        [
            link("a/x.rs", Some(1), None),
            link("b/y.rs", Some(2), Some(3))
        ]
    );
}
