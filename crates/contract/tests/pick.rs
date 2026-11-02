#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use chrono::{TimeZone, Utc};
use ostia_base::js::utf16_len;
use ostia_contract::pick::{
    CaptureExtras, PICK_HTML_MAX, PICK_LOG_MAX, PICK_TABLE_CELLS_MAX, PICK_TABLE_CSV_MAX, PickBox,
    PickCapture, PickFailedRequest, PickLogEntry, PickTable, PickViewport, REPORT_SLUG_MAX,
    SCREENSHOT_MARGIN, capture_references, capture_stem, clip, fence, markdown_image,
    next_pick_report_number, normalize_box, normalize_capture, normalize_table, pick_bus_message,
    render_pick_report, report_reference, screenshot_rect, url_slug,
};
use serde_json::{Value, json};

fn raw() -> Value {
    json!({
        "url": "http://localhost:5173/checkout",
        "title": "Checkout",
        "selector": "[data-testid=\"pay\"]",
        "label": "button.primary  120×32",
        "html": "<button data-testid=\"pay\" class=\"primary\">Pay</button>",
        "box": { "x": 10.123, "y": 20, "width": 120, "height": 32 },
        "viewport": { "width": 800, "height": 600 },
        "styles": { "display": "inline-block", "color": "rgb(0, 0, 0)", "not-a-prop": "x" },
        "role": "button",
        "name": "Pay",
        "hasText": true,
        "table": null,
    })
}

fn extras() -> CaptureExtras {
    CaptureExtras {
        id: "pick-1".to_owned(),
        console_errors: Vec::new(),
        failed_requests: Vec::new(),
        screenshot_path: Some("/tmp/ostia-reports-1000/pick-1.png".to_owned()),
        captured_at: Utc.with_ymd_and_hms(2026, 9, 28, 10, 0, 0).unwrap(),
    }
}

fn capture() -> PickCapture {
    normalize_capture(&raw(), extras())
}

fn rows(table: &[&[&str]]) -> Value {
    json!(table)
}

fn the_box(x: f64, y: f64, width: f64, height: f64) -> PickBox {
    PickBox {
        x,
        y,
        width,
        height,
    }
}

fn viewport(width: f64, height: f64) -> PickViewport {
    PickViewport { width, height }
}

#[test]
fn keeps_the_element_facts_and_rounds_the_box() {
    let c = capture();
    assert_eq!(c.selector, "[data-testid=\"pay\"]");
    assert_eq!(c.box_, the_box(10.12, 20.0, 120.0, 32.0));
    assert_eq!(c.role, "button");
    assert_eq!(c.captured_at, "2026-09-28T10:00:00.000Z");
    assert!(!c.html_truncated);
}

#[test]
fn drops_style_properties_outside_the_allowed_subset() {
    let c = capture();
    let styles: Vec<(&str, &str)> = c
        .styles
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        styles,
        [("display", "inline-block"), ("color", "rgb(0, 0, 0)")]
    );
}

#[test]
fn truncates_outer_html_to_the_cap_and_flags_it() {
    let mut r = raw();
    r["html"] = json!(format!("<div>{}</div>", "x".repeat(5000)));
    let c = normalize_capture(&r, extras());
    assert_eq!(utf16_len(&c.html), PICK_HTML_MAX);
    assert!(c.html_truncated);
}

#[test]
fn keeps_only_the_most_recent_console_errors_and_failed_requests() {
    let console_errors: Vec<PickLogEntry> = (0..50)
        .map(|i| PickLogEntry {
            level: "error".to_owned(),
            text: format!("e{i}"),
            ts: i,
        })
        .collect();
    let failed_requests: Vec<PickFailedRequest> = (0..30)
        .map(|i| PickFailedRequest {
            url: format!("http://x/{i}"),
            method: "GET".to_owned(),
            status: Some(500),
            error: None,
            ts: i,
        })
        .collect();
    let c = normalize_capture(
        &raw(),
        CaptureExtras {
            console_errors,
            failed_requests,
            ..extras()
        },
    );
    assert_eq!(c.console_errors.len(), PICK_LOG_MAX);
    assert_eq!(c.console_errors.last().unwrap().text, "e49");
    assert_eq!(c.failed_requests.len(), PICK_LOG_MAX);
    assert_eq!(c.failed_requests[0].url, "http://x/10");
}

#[test]
fn survives_missing_or_hostile_fields_from_the_page() {
    let hostile = json!({
        "url": "u".repeat(2000),
        "box": { "x": null },
        "styles": "nope",
    });
    let c = normalize_capture(
        &hostile,
        CaptureExtras {
            screenshot_path: None,
            ..extras()
        },
    );
    assert!(utf16_len(&c.url) <= 500);
    assert_eq!(c.box_, the_box(0.0, 0.0, 0.0, 0.0));
    assert!(c.styles.is_empty());
    assert_eq!(c.selector, "");
    assert_eq!(c.screenshot_path, None);
}

#[test]
fn quotes_csv_fields_and_keeps_the_shape() {
    assert_eq!(
        normalize_table(&rows(&[
            &["Name", "Note"],
            &["a,b", "say \"hi\""],
            &["line\nbreak", ""],
        ])),
        Some(PickTable {
            rows: 3,
            columns: 2,
            truncated: false,
            csv: "Name,Note\n\"a,b\",\"say \"\"hi\"\"\"\n\"line\nbreak\",".to_owned(),
        })
    );
}

#[test]
fn pads_short_rows_so_the_csv_is_rectangular() {
    assert_eq!(
        normalize_table(&rows(&[&["a", "b", "c"], &["d"]]))
            .unwrap()
            .csv,
        "a,b,c\nd,,"
    );
}

#[test]
fn refuses_anything_that_is_not_rows_of_strings() {
    assert_eq!(normalize_table(&Value::Null), None);
    assert_eq!(normalize_table(&json!([])), None);
    assert_eq!(normalize_table(&json!("a,b")), None);
    assert_eq!(normalize_table(&json!([["a"], "b"])), None);
    assert_eq!(normalize_table(&json!([[]])), None);
}

#[test]
fn stops_at_the_cell_cap_and_flags_it() {
    let table = normalize_table(&json!(vec![vec!["a", "b"]; 6000])).unwrap();
    assert_eq!(table.rows, PICK_TABLE_CELLS_MAX / 2);
    assert!(table.truncated);
}

#[test]
fn stops_at_the_byte_cap_and_flags_it() {
    let cell = "x".repeat(1900);
    let table = normalize_table(&json!(vec![vec![cell.clone(), cell]; 400])).unwrap();
    assert!(table.csv.len() <= PICK_TABLE_CSV_MAX);
    assert!(table.truncated);
    assert!(table.rows < 400);
}

#[test]
fn adds_a_margin_of_context_around_the_element_clipped_to_the_viewport_and_scales_by_zoom() {
    assert_eq!(SCREENSHOT_MARGIN, 16.0);
    assert_eq!(
        screenshot_rect(
            &the_box(-10.0, 5.0, 50.0, 20.0),
            &viewport(800.0, 600.0),
            2.0
        ),
        Some(the_box(0.0, 0.0, 112.0, 82.0))
    );
    assert_eq!(
        screenshot_rect(
            &the_box(100.0, 100.0, 8.0, 8.0),
            &viewport(800.0, 600.0),
            1.0
        ),
        Some(the_box(84.0, 84.0, 40.0, 40.0))
    );
    assert_eq!(
        screenshot_rect(
            &the_box(790.0, 590.0, 8.0, 8.0),
            &viewport(800.0, 600.0),
            1.0
        ),
        Some(the_box(774.0, 574.0, 26.0, 26.0))
    );
}

#[test]
fn returns_none_when_the_element_is_entirely_off_screen() {
    assert_eq!(
        screenshot_rect(
            &the_box(0.0, 700.0, 50.0, 20.0),
            &viewport(800.0, 600.0),
            1.0
        ),
        None
    );
}

#[test]
fn contains_the_note_selector_page_screenshot_path_style_and_html() {
    let md = render_pick_report(&capture(), "  The Pay button is cut off  ", false);
    assert!(md.contains("# Captured element: button.primary  120×32"));
    assert!(md.contains("The Pay button is cut off"));
    assert!(md.contains("- Selector: `[data-testid=\"pay\"]`"));
    assert!(md.contains("Checkout — http://localhost:5173/checkout"));
    assert!(md.contains(
        "- Screenshot: /tmp/ostia-reports-1000/pick-1.png (the element and up to 16 CSS px around it)"
    ));
    assert!(
        md.contains("## Screenshot\n\n![Captured element](/tmp/ostia-reports-1000/pick-1.png)")
    );
    assert!(md.contains("- display: inline-block"));
    assert!(
        md.contains("```html\n<button data-testid=\"pay\" class=\"primary\">Pay</button>\n```")
    );
}

#[test]
fn lists_console_errors_and_failed_requests_with_their_outcome() {
    let mut c = capture();
    c.console_errors = vec![PickLogEntry {
        level: "error".to_owned(),
        text: "TypeError: x is undefined".to_owned(),
        ts: 0,
    }];
    c.failed_requests = vec![
        PickFailedRequest {
            url: "http://api/cart".to_owned(),
            method: "POST".to_owned(),
            status: Some(502),
            error: None,
            ts: 0,
        },
        PickFailedRequest {
            url: "http://cdn/font.woff2".to_owned(),
            method: "GET".to_owned(),
            status: None,
            error: Some("net::ERR_FAILED".to_owned()),
            ts: 0,
        },
    ];
    let md = render_pick_report(&c, "broken", false);
    assert!(md.contains("`TypeError: x is undefined`"));
    assert!(md.contains("POST `http://api/cart` → HTTP 502"));
    assert!(md.contains("GET `http://cdn/font.woff2` → net::ERR_FAILED"));
}

#[test]
fn says_so_when_nothing_was_recorded_and_no_note_was_given() {
    let mut c = capture();
    c.screenshot_path = None;
    let md = render_pick_report(&c, "   ", false);
    assert!(md.contains("(no note)"));
    assert_eq!(md.matches("None recorded.").count(), 2);
    assert!(md.contains("(not captured: element off screen)"));
    assert!(!md.contains("## Screenshot"));
    assert!(!md.contains("!["));
}

#[test]
fn lengthens_the_fence_when_the_html_itself_contains_backticks() {
    let mut c = capture();
    c.html = "<pre>```js</pre>".to_owned();
    let md = render_pick_report(&c, "x", false);
    assert!(md.contains("````html\n<pre>```js</pre>\n````"));
}

#[test]
fn puts_the_csv_in_place_of_the_html() {
    let mut c = capture();
    c.table = Some(PickTable {
        rows: 2,
        columns: 2,
        truncated: false,
        csv: "a,b\n1,2".to_owned(),
    });
    let md = render_pick_report(&c, "note", false);
    assert!(md.contains("- Table: 2 rows × 2 columns"));
    assert!(md.contains("## Table (CSV)\n\n```csv\na,b\n1,2\n```"));
    assert!(!md.contains("## HTML"));
}

#[test]
fn leaves_the_note_and_the_screenshot_out_of_a_copy() {
    let md = render_pick_report(&capture(), "secret note", true);
    assert!(!md.contains("## Note"));
    assert!(!md.contains("secret note"));
    assert!(!md.contains("Screenshot"));
    assert!(md.contains("- Selector:"));
    assert!(md.contains("```html"));
}

#[test]
fn is_json_an_agent_can_parse() {
    let text = pick_bus_message(&capture(), " fix it ", "/tmp/r/capture-1.md");
    let msg: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        msg,
        json!({
            "kind": "capture",
            "report": "/tmp/r/capture-1.md",
            "image": "/tmp/ostia-reports-1000/pick-1.png",
            "url": "http://localhost:5173/checkout",
            "selector": "[data-testid=\"pay\"]",
            "note": "fix it",
        })
    );
    let keys: Vec<&str> = msg
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["kind", "report", "image", "url", "selector", "note"]);
}

#[test]
fn prefixes_at_and_ends_with_a_space_so_the_user_can_keep_typing() {
    assert_eq!(
        report_reference("/tmp/ostia-reports-1000/capture-3.md"),
        "@/tmp/ostia-reports-1000/capture-3.md "
    );
}

#[test]
fn quotes_a_path_containing_whitespace() {
    assert_eq!(
        report_reference("/tmp/my dir/capture-1.md"),
        "@\"/tmp/my dir/capture-1.md\" "
    );
}

#[test]
fn follows_the_report_with_the_screenshot_as_its_own_reference() {
    assert_eq!(
        capture_references("/tmp/r/capture-3.md", Some("/tmp/r/pick-1.png")),
        "@/tmp/r/capture-3.md @/tmp/r/pick-1.png "
    );
    assert_eq!(
        capture_references("/tmp/my dir/capture-3.md", Some("/tmp/my dir/a.png")),
        "@\"/tmp/my dir/capture-3.md\" @\"/tmp/my dir/a.png\" "
    );
}

#[test]
fn is_the_report_alone_without_a_screenshot() {
    assert_eq!(
        capture_references("/tmp/r/capture-3.md", None),
        "@/tmp/r/capture-3.md "
    );
}

#[test]
fn embeds_a_plain_path_as_is_and_wraps_one_with_spaces_or_brackets() {
    assert_eq!(
        markdown_image("Shot", "/tmp/r/a.png"),
        "![Shot](/tmp/r/a.png)"
    );
    assert_eq!(
        markdown_image("Shot", "/tmp/my dir/a (1).png"),
        "![Shot](</tmp/my dir/a (1).png>)"
    );
    assert_eq!(
        markdown_image("a]b", "/tmp/<x>.png"),
        "![ab](</tmp/%3Cx%3E.png>)"
    );
}

#[test]
fn adds_the_pages_host_and_path_as_a_slug_without_its_query_or_fragment() {
    assert_eq!(
        url_slug("https://www.GitHub.com/aurigax-ai/ostia/pull/12?token=abc#files"),
        "github-com-aurigax-ai-ostia-pull-12"
    );
    assert_eq!(url_slug("http://localhost:5173/"), "localhost-5173");
    assert_eq!(
        capture_stem(80, "http://localhost:5173/cart"),
        "capture-80-localhost-5173-cart"
    );
}

#[test]
fn clips_a_long_slug_and_leaves_it_out_for_a_page_without_a_web_address() {
    let long = url_slug(&format!("https://example.com/{}", "a/".repeat(60)));
    assert!(long.len() <= REPORT_SLUG_MAX);
    assert!(!long.ends_with('-'));
    assert_eq!(capture_stem(3, "about:blank"), "capture-3");
    assert_eq!(capture_stem(3, "file:///etc/passwd"), "capture-3");
}

#[test]
fn numbers_after_the_highest_report_in_the_folder_whatever_its_slug() {
    assert_eq!(next_pick_report_number(&[]), 1);
    assert_eq!(
        next_pick_report_number(&[
            "capture-2.md",
            "capture-7-localhost-5173.md",
            "selection-9.md"
        ]),
        8
    );
    assert_eq!(
        next_pick_report_number(&["capture-2.md", "capture-11-localhost.png", "pick-12.png"]),
        12
    );
    assert_eq!(
        capture_stem(4, "http://localhost:5173/cart"),
        "capture-4-localhost-5173-cart"
    );
}

#[test]
fn clips_text_with_an_ellipsis_by_utf16_length_and_turns_other_values_into_text() {
    assert_eq!(clip(&json!("abcdef"), 4), "abc…");
    assert_eq!(clip(&json!("abc"), 3), "abc");
    assert_eq!(clip(&json!("ab😀"), 3), "ab…");
    assert_eq!(clip(&Value::Null, 10), "");
    assert_eq!(clip(&json!(5), 10), "5");
    assert_eq!(clip(&json!(true), 10), "true");
}

#[test]
fn rounds_a_box_half_up_like_js_and_zeroes_values_that_are_not_numbers() {
    assert_eq!(
        normalize_box(&json!({ "x": 10.125, "y": -10.125, "width": "5", "height": null })),
        the_box(10.13, -10.12, 0.0, 0.0)
    );
    assert_eq!(normalize_box(&Value::Null), the_box(0.0, 0.0, 0.0, 0.0));
}

#[test]
fn counts_has_text_only_when_it_is_true() {
    let mut r = raw();
    r["hasText"] = json!("yes");
    assert!(!normalize_capture(&r, extras()).has_text);
    assert!(capture().has_text);
}

#[test]
fn clips_log_fields_and_leaves_an_absent_status_and_error_out_of_the_json() {
    let c = normalize_capture(
        &raw(),
        CaptureExtras {
            console_errors: vec![PickLogEntry {
                level: "l".repeat(30),
                text: "t".repeat(700),
                ts: 1,
            }],
            failed_requests: vec![PickFailedRequest {
                url: "http://x/".to_owned(),
                method: "m".repeat(20),
                status: None,
                error: Some("e".repeat(400)),
                ts: 3,
            }],
            ..extras()
        },
    );
    assert_eq!(utf16_len(&c.console_errors[0].level), 20);
    assert_eq!(utf16_len(&c.console_errors[0].text), 600);
    assert_eq!(utf16_len(&c.failed_requests[0].method), 16);
    assert_eq!(
        serde_json::to_string(&c.failed_requests[0]).unwrap(),
        format!(
            "{{\"url\":\"http://x/\",\"method\":\"{}…\",\"error\":\"{}…\",\"ts\":3}}",
            "m".repeat(15),
            "e".repeat(299)
        )
    );
}

#[test]
fn clips_a_cell_and_turns_a_cell_that_is_not_text_into_an_empty_one() {
    let table = normalize_table(&json!([["x".repeat(3000), 5, null]])).unwrap();
    assert_eq!(table.csv, format!("{}…,,", "x".repeat(1999)));
}

#[test]
fn cuts_a_first_row_that_is_over_the_byte_cap_to_a_quarter_of_the_cap() {
    let cell = "y".repeat(2000);
    let table = normalize_table(&json!(vec![vec![cell; 200]; 2])).unwrap();
    assert_eq!(table.rows, 1);
    assert!(table.truncated);
    assert_eq!(utf16_len(&table.csv), PICK_TABLE_CSV_MAX / 4);
}

#[test]
fn heads_the_report_with_the_selector_when_there_is_no_label_and_dashes_for_an_empty_role_and_name()
{
    let mut c = capture();
    c.label = String::new();
    c.role = String::new();
    c.name = String::new();
    let md = render_pick_report(&c, "x", false);
    assert!(md.starts_with("# Captured element: [data-testid=\"pay\"]\n"));
    assert!(md.contains("- Role / name: - / -\n"));
}

#[test]
fn prints_the_box_without_trailing_zeros() {
    let md = render_pick_report(&capture(), "x", false);
    assert!(md.contains("- Box: x 10.12, y 20, 120 × 32 (CSS px, viewport)\n"));
}

#[test]
fn marks_a_truncated_table_and_a_truncated_html_in_the_report() {
    let mut c = capture();
    c.table = Some(PickTable {
        rows: 1,
        columns: 1,
        truncated: true,
        csv: "a".to_owned(),
    });
    assert!(render_pick_report(&c, "x", false).contains("- Table: 1 rows × 1 columns (truncated)"));
    c.table = None;
    c.html_truncated = true;
    assert!(render_pick_report(&c, "x", false).contains("## HTML (truncated)\n"));
}

#[test]
fn clips_the_note_in_a_report_and_in_a_bus_message() {
    let note = "n".repeat(5000);
    let clipped = format!("{}…", "n".repeat(3999));
    assert!(render_pick_report(&capture(), &note, false).contains(&clipped));
    let msg: Value =
        serde_json::from_str(&pick_bus_message(&capture(), &note, "/tmp/r/capture-1.md")).unwrap();
    assert_eq!(msg["note"], json!(clipped));
}

#[test]
fn writes_log_times_as_iso_text_and_says_failed_when_a_request_has_no_status_or_error() {
    let mut c = capture();
    c.console_errors = vec![PickLogEntry {
        level: "error".to_owned(),
        text: "a  b\n c".to_owned(),
        ts: 0,
    }];
    c.failed_requests = vec![PickFailedRequest {
        url: "http://x/".to_owned(),
        method: "GET".to_owned(),
        status: None,
        error: None,
        ts: 1500,
    }];
    let md = render_pick_report(&c, "x", false);
    assert!(md.contains("- 1970-01-01T00:00:00.000Z `a b c`\n"));
    assert!(md.contains("- 1970-01-01T00:00:01.500Z GET `http://x/` → failed\n"));
}

#[test]
fn wraps_a_selector_that_contains_a_backtick_in_double_backticks() {
    let mut c = capture();
    c.selector = "a`b".to_owned();
    assert!(render_pick_report(&c, "x", false).contains("- Selector: `` a`b ``\n"));
}

#[test]
fn defaults_the_fence_language_to_empty() {
    assert_eq!(fence("a", ""), "```\na\n```");
    assert_eq!(fence("``` x", "md"), "````md\n``` x\n````");
}

#[test]
fn leaves_the_slug_out_for_text_that_is_not_a_url_or_has_another_scheme() {
    assert_eq!(url_slug("not a url"), "");
    assert_eq!(url_slug("ftp://example.com/a"), "");
}

#[test]
fn ignores_report_names_that_do_not_match_the_pattern() {
    assert_eq!(
        next_pick_report_number(&[
            "capture-3.txt",
            "capture-5-Upper.md",
            "xcapture-9.md",
            "capture-.md"
        ]),
        1
    );
}

#[test]
fn quotes_a_path_with_a_tab_in_a_reference() {
    assert_eq!(report_reference("/tmp/a\tb"), "@\"/tmp/a\tb\" ");
}

#[test]
fn does_not_wrap_or_panic_on_a_huge_report_number() {
    assert_eq!(
        next_pick_report_number(&["capture-99999999999999999999999999.md"]),
        u64::MAX
    );
    assert_eq!(
        next_pick_report_number(&["capture-18446744073709551615.png"]),
        u64::MAX
    );
}

#[test]
fn prints_a_numeric_title_like_a_script_number() {
    let mut r = raw();
    r["title"] = json!(1e21);
    assert_eq!(normalize_capture(&r, extras()).title, "1e+21");
    r["title"] = json!(1.5e-7);
    assert_eq!(normalize_capture(&r, extras()).title, "1.5e-7");
}

#[test]
fn serializes_a_capture_with_the_script_field_names() {
    let wire = serde_json::to_value(capture()).unwrap();
    assert_eq!(
        wire["box"],
        json!({ "x": 10.12, "y": 20, "width": 120, "height": 32 })
    );
    assert_eq!(wire["viewport"], json!({ "width": 800, "height": 600 }));
    assert_eq!(
        wire["styles"],
        json!({ "display": "inline-block", "color": "rgb(0, 0, 0)" })
    );
    assert_eq!(wire["hasText"], json!(true));
    assert_eq!(wire["htmlTruncated"], json!(false));
    assert_eq!(wire["capturedAt"], json!("2026-09-28T10:00:00.000Z"));
    assert_eq!(wire["table"], Value::Null);
}
