#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::link_frames::{
    LINK_DEAD_MS, LINK_FRAME_MAX, LINK_HEARTBEAT_MS, frame_line, parse_frame,
};
use serde_json::{Value, json};

fn line_of(text: &str) -> Option<String> {
    parse_frame(text).map(|frame| frame_line(&frame))
}

fn round_trip(frame: Value) -> Option<Value> {
    line_of(&frame.to_string()).map(|line| {
        assert!(line.ends_with('\n'), "{line:?}");
        assert_eq!(line.matches('\n').count(), 1, "{line:?}");
        serde_json::from_str(line.trim_end()).unwrap()
    })
}

fn units(count: usize) -> String {
    "a".repeat(count)
}

fn wide(units: usize) -> String {
    "\u{1f600}".repeat(units / 2)
}

#[test]
fn rpf_c6_keeps_only_port_numbers_and_process_names_in_a_ports_frame() {
    let frame = round_trip(json!({
        "t": "ports",
        "ports": [{"port": 3000, "name": "node", "cmdline": "node --token=secret", "user": "root"}],
    }));
    assert_eq!(
        frame,
        Some(json!({"t": "ports", "ports": [{"port": 3000, "name": "node"}]}))
    );
    let line = line_of(
        &json!({
            "t": "ports",
            "ports": [{"port": 3000, "name": "node", "cmdline": "node --token=secret"}],
        })
        .to_string(),
    )
    .unwrap();
    assert!(!line.contains("secret"));
}

#[test]
fn rpf_c6_refuses_a_ports_frame_with_a_bad_port() {
    assert_eq!(
        round_trip(json!({"t": "ports", "ports": [{"port": 0}]})),
        None
    );
    assert_eq!(
        round_trip(json!({"t": "ports", "ports": [{"port": 70000}]})),
        None
    );
    assert_eq!(round_trip(json!({"t": "ports", "ports": "x"})), None);
}

#[test]
fn rpf_c21_passes_an_out_of_range_local_port_through_for_the_desktop_to_refuse() {
    assert_eq!(
        round_trip(
            json!({"t": "ports-req", "id": "a", "op": "forward", "remote": 3000, "local": 80})
        ),
        Some(json!({"t": "ports-req", "id": "a", "op": "forward", "remote": 3000, "local": 80}))
    );
}

#[test]
fn rpf_c19_reads_list_forward_and_stop_requests_and_refuses_other_verbs() {
    assert_eq!(
        round_trip(json!({"t": "ports-req", "id": "a", "op": "list"})),
        Some(json!({"t": "ports-req", "id": "a", "op": "list"}))
    );
    assert_eq!(
        round_trip(json!({"t": "ports-req", "id": "a", "op": "tag"})),
        None
    );
    for op in ["forward", "stop"] {
        assert_eq!(
            round_trip(json!({"t": "ports-req", "id": "a", "op": op, "remote": 3000})),
            Some(json!({"t": "ports-req", "id": "a", "op": op, "remote": 3000})),
            "{op}"
        );
    }
}

#[test]
fn rpf_c20_reads_a_ports_result_with_forwards_and_an_error_result() {
    let rows = json!([{"remote": 3000, "local": 3000, "name": "node"}]);
    assert_eq!(
        round_trip(json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": rows}})),
        Some(json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": rows}}))
    );
    assert_eq!(
        round_trip(
            json!({"t": "ports-res", "id": "a", "result": {"ok": false, "error": "link-down"}})
        ),
        Some(json!({"t": "ports-res", "id": "a", "result": {"ok": false, "error": "link-down"}}))
    );
}

#[test]
fn keeps_the_link_timing_and_size_limits() {
    assert_eq!(LINK_FRAME_MAX, 1024 * 1024);
    assert_eq!(LINK_HEARTBEAT_MS, 15_000);
    assert_eq!(LINK_DEAD_MS, 45_000);
}

#[test]
fn refuses_text_that_is_not_one_json_object_with_a_known_type() {
    let refused = [
        "",
        "   ",
        "not json",
        "{",
        "null",
        "5",
        "\"hb\"",
        "true",
        "[]",
        "[{\"t\":\"hb\"}]",
        "{}",
        "{\"t\":5}",
        "{\"t\":null}",
        "{\"t\":\"HB\"}",
        "{\"t\":\"unknown\"}",
        "{\"t\":[\"hb\"]}",
        "{\"t\":\"hb\"} {\"t\":\"hb\"}",
        "{\"t\":\"hb\"}x",
    ];
    for text in refused {
        assert_eq!(line_of(text), None, "{text:?}");
    }
}

#[test]
fn reads_a_frame_with_space_around_it_and_a_line_end() {
    assert_eq!(
        line_of("  {\"t\":\"hb\"}\r\n").as_deref(),
        Some("{\"t\":\"hb\"}\n")
    );
}

#[test]
fn reads_a_heartbeat_and_drops_every_other_field() {
    assert_eq!(
        line_of("{\"t\":\"hb\",\"extra\":1,\"id\":\"a\"}").as_deref(),
        Some("{\"t\":\"hb\"}\n")
    );
}

#[test]
fn takes_the_last_value_of_a_repeated_key() {
    assert_eq!(
        line_of("{\"t\":\"hb\",\"t\":\"stored\",\"id\":\"a\"}").as_deref(),
        Some("{\"t\":\"stored\",\"id\":\"a\"}\n")
    );
}

#[test]
fn reads_hello_hello_ok_and_incompatible_with_a_version() {
    for kind in ["hello", "hello-ok", "incompatible"] {
        assert_eq!(
            round_trip(json!({"t": kind, "version": "1.2", "more": true})),
            Some(json!({"t": kind, "version": "1.2"})),
            "{kind}"
        );
        for bad in [
            json!({"t": kind}),
            json!({"t": kind, "version": ""}),
            json!({"t": kind, "version": 1}),
            json!({"t": kind, "version": null}),
        ] {
            assert_eq!(round_trip(bad.clone()), None, "{bad}");
        }
    }
}

#[test]
fn limits_a_version_to_64_utf16_units() {
    assert!(round_trip(json!({"t": "hello", "version": units(64)})).is_some());
    assert_eq!(
        round_trip(json!({"t": "hello", "version": units(65)})),
        None
    );
    assert!(round_trip(json!({"t": "hello", "version": wide(64)})).is_some());
    assert_eq!(
        round_trip(json!({"t": "hello", "version": "\u{1f600}".repeat(33)})),
        None
    );
}

#[test]
fn reads_a_stored_frame_with_an_id_of_one_to_100_units() {
    assert_eq!(
        round_trip(json!({"t": "stored", "id": "m1", "x": 1})),
        Some(json!({"t": "stored", "id": "m1"}))
    );
    assert!(round_trip(json!({"t": "stored", "id": units(100)})).is_some());
    for id in [
        json!(""),
        json!(units(101)),
        json!(7),
        json!(null),
        json!("\u{1f600}".repeat(51)),
    ] {
        assert_eq!(round_trip(json!({"t": "stored", "id": id})), None, "{id}");
    }
    assert_eq!(round_trip(json!({"t": "stored"})), None);
}

#[test]
fn reads_a_refused_frame_with_an_id_and_a_reason_of_up_to_64_units() {
    assert_eq!(
        round_trip(json!({"t": "refused", "id": "m1", "reason": "full", "x": 1})),
        Some(json!({"t": "refused", "id": "m1", "reason": "full"}))
    );
    assert!(round_trip(json!({"t": "refused", "id": "m1", "reason": units(64)})).is_some());
    let bad = [
        json!({"t": "refused", "id": "m1", "reason": units(65)}),
        json!({"t": "refused", "id": "m1", "reason": ""}),
        json!({"t": "refused", "id": "m1"}),
        json!({"t": "refused", "reason": "full"}),
        json!({"t": "refused", "id": "", "reason": "full"}),
        json!({"t": "refused", "id": "m1", "reason": 5}),
    ];
    for frame in bad {
        assert_eq!(round_trip(frame.clone()), None, "{frame}");
    }
}

#[test]
fn reads_a_mail_frame_and_writes_its_fields_in_a_fixed_order() {
    assert_eq!(
        line_of(r#"{"text":"hi","to":"b","from":"a","id":"m1","t":"mail","x":1}"#).as_deref(),
        Some("{\"t\":\"mail\",\"id\":\"m1\",\"from\":\"a\",\"to\":\"b\",\"text\":\"hi\"}\n")
    );
}

#[test]
fn refuses_a_mail_frame_with_a_missing_empty_or_long_field() {
    let full = json!({"t": "mail", "id": "m1", "from": "a", "to": "b", "text": "hi"});
    for field in ["id", "from", "to", "text"] {
        let mut missing = full.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(round_trip(missing), None, "missing {field}");
        let mut empty = full.clone();
        empty[field] = json!("");
        assert_eq!(round_trip(empty), None, "empty {field}");
        let mut number = full.clone();
        number[field] = json!(1);
        assert_eq!(round_trip(number), None, "number {field}");
    }
    for field in ["id", "from", "to"] {
        let mut longest = full.clone();
        longest[field] = json!(units(100));
        assert!(round_trip(longest).is_some(), "100 {field}");
        let mut longer = full.clone();
        longer[field] = json!(units(101));
        assert_eq!(round_trip(longer), None, "101 {field}");
    }
}

#[test]
fn limits_mail_text_to_one_mebibyte_in_utf16_units() {
    let full =
        |text: String| json!({"t": "mail", "id": "m1", "from": "a", "to": "b", "text": text});
    assert!(round_trip(full(units(LINK_FRAME_MAX))).is_some());
    assert_eq!(round_trip(full(units(LINK_FRAME_MAX + 1))), None);
    assert!(round_trip(full(wide(LINK_FRAME_MAX))).is_some());
    assert_eq!(round_trip(full(wide(LINK_FRAME_MAX + 2))), None);
}

#[test]
fn keeps_the_text_of_a_mail_frame_exactly() {
    let text = "line one\nline \"two\"\t\u{1f600} \u{00e9} \\ </script>";
    assert_eq!(
        round_trip(json!({"t": "mail", "id": "m1", "from": "a", "to": "b", "text": text})),
        Some(json!({"t": "mail", "id": "m1", "from": "a", "to": "b", "text": text}))
    );
}

#[test]
fn reads_a_ports_frame_with_no_ports_with_a_name_or_without() {
    assert_eq!(
        round_trip(json!({"t": "ports", "ports": []})),
        Some(json!({"t": "ports", "ports": []}))
    );
    assert_eq!(
        round_trip(
            json!({"t": "ports", "ports": [{"port": 1}, {"port": 65535, "name": "x"}, {"port": 1}]})
        ),
        Some(
            json!({"t": "ports", "ports": [{"port": 1}, {"port": 65535, "name": "x"}, {"port": 1}]})
        )
    );
    assert_eq!(round_trip(json!({"t": "ports"})), None);
    assert_eq!(round_trip(json!({"t": "ports", "ports": null})), None);
    assert_eq!(round_trip(json!({"t": "ports", "ports": {}})), None);
}

#[test]
fn refuses_a_ports_frame_with_a_port_that_is_not_a_whole_number_from_1_to_65535() {
    let ports = [
        json!(0),
        json!(65536),
        json!(-1),
        json!(1.5),
        json!("3000"),
        json!(null),
        json!(true),
        json!([3000]),
    ];
    for port in ports {
        assert_eq!(
            round_trip(json!({"t": "ports", "ports": [{"port": port}]})),
            None,
            "{port}"
        );
    }
    assert_eq!(round_trip(json!({"t": "ports", "ports": [{}]})), None);
    assert_eq!(
        round_trip(json!({"t": "ports", "ports": [{"name": "x"}]})),
        None
    );
}

#[test]
fn refuses_a_ports_frame_with_an_item_that_is_not_an_object() {
    for item in [
        json!(null),
        json!(3000),
        json!("x"),
        json!([]),
        json!([3000]),
        json!(true),
    ] {
        assert_eq!(
            round_trip(json!({"t": "ports", "ports": [{"port": 3000}, item]})),
            None,
            "{item}"
        );
    }
}

#[test]
fn refuses_a_ports_frame_with_a_name_that_is_empty_null_or_over_64_units() {
    assert!(round_trip(json!({"t": "ports", "ports": [{"port": 1, "name": units(64)}]})).is_some());
    for name in [
        json!(""),
        json!(units(65)),
        json!(null),
        json!(5),
        json!("\u{1f600}".repeat(33)),
    ] {
        assert_eq!(
            round_trip(json!({"t": "ports", "ports": [{"port": 1, "name": name}]})),
            None,
            "{name}"
        );
    }
}

#[test]
fn reads_a_whole_number_written_with_a_fraction_as_a_port() {
    assert_eq!(
        line_of(r#"{"t":"ports","ports":[{"port":3000.0},{"port":3e3}]}"#).as_deref(),
        Some("{\"t\":\"ports\",\"ports\":[{\"port\":3000},{\"port\":3000}]}\n")
    );
}

#[test]
fn limits_a_ports_frame_to_4096_ports() {
    let ports = |count: usize| json!({"t": "ports", "ports": vec![json!({"port": 80}); count]});
    assert!(round_trip(ports(4096)).is_some());
    assert_eq!(round_trip(ports(4097)), None);
}

#[test]
fn reads_a_ports_request_and_writes_its_fields_in_a_fixed_order() {
    assert_eq!(
        line_of(r#"{"local":4000,"remote":3000,"op":"forward","id":"a","t":"ports-req"}"#)
            .as_deref(),
        Some(
            "{\"t\":\"ports-req\",\"id\":\"a\",\"op\":\"forward\",\"remote\":3000,\"local\":4000}\n"
        )
    );
}

#[test]
fn refuses_a_ports_request_with_a_bad_id_op_or_remote_port() {
    let bad = [
        json!({"t": "ports-req", "op": "list"}),
        json!({"t": "ports-req", "id": "", "op": "list"}),
        json!({"t": "ports-req", "id": units(101), "op": "list"}),
        json!({"t": "ports-req", "id": "a"}),
        json!({"t": "ports-req", "id": "a", "op": null}),
        json!({"t": "ports-req", "id": "a", "op": 1}),
        json!({"t": "ports-req", "id": "a", "op": "List"}),
        json!({"t": "ports-req", "id": "a", "op": ""}),
        json!({"t": "ports-req", "id": "a", "op": "list", "remote": 0}),
        json!({"t": "ports-req", "id": "a", "op": "list", "remote": 65536}),
        json!({"t": "ports-req", "id": "a", "op": "list", "remote": 1.5}),
        json!({"t": "ports-req", "id": "a", "op": "list", "remote": "3000"}),
        json!({"t": "ports-req", "id": "a", "op": "list", "remote": null}),
    ];
    for frame in bad {
        assert_eq!(round_trip(frame.clone()), None, "{frame}");
    }
}

#[test]
fn passes_any_whole_number_local_port_through_and_refuses_the_rest() {
    for local in [
        json!(0),
        json!(-5),
        json!(80),
        json!(65536),
        json!(4294967296_u64),
    ] {
        let frame =
            json!({"t": "ports-req", "id": "a", "op": "forward", "remote": 1, "local": local});
        assert_eq!(round_trip(frame.clone()), Some(frame), "{local}");
    }
    for local in [
        json!(80.5),
        json!("80"),
        json!(null),
        json!(true),
        json!([80]),
    ] {
        let frame =
            json!({"t": "ports-req", "id": "a", "op": "forward", "remote": 1, "local": local});
        assert_eq!(round_trip(frame), None, "{local}");
    }
}

#[test]
fn reads_a_ports_request_without_a_remote_or_a_local_port() {
    assert_eq!(
        line_of(r#"{"t":"ports-req","id":"a","op":"stop","local":4000}"#).as_deref(),
        Some("{\"t\":\"ports-req\",\"id\":\"a\",\"op\":\"stop\",\"local\":4000}\n")
    );
    assert_eq!(
        line_of(r#"{"t":"ports-req","id":"a","op":"stop","remote":3000}"#).as_deref(),
        Some("{\"t\":\"ports-req\",\"id\":\"a\",\"op\":\"stop\",\"remote\":3000}\n")
    );
}

#[test]
fn reads_forward_rows_and_writes_each_row_in_a_fixed_order() {
    assert_eq!(
        line_of(
            r#"{"t":"ports-res","id":"a","result":{"forwards":[{"error":"busy","local":4000,"name":"web","remote":3000,"x":1},{"remote":22}],"ok":true}}"#
        )
        .as_deref(),
        Some(concat!(
            "{\"t\":\"ports-res\",\"id\":\"a\",\"result\":{\"ok\":true,\"forwards\":[",
            "{\"remote\":3000,\"name\":\"web\",\"local\":4000,\"error\":\"busy\"},",
            "{\"remote\":22}]}}\n"
        ))
    );
}

#[test]
fn refuses_a_forward_row_with_a_bad_remote_name_local_or_error() {
    let rows = [
        json!({}),
        json!({"remote": 0}),
        json!({"remote": 65536}),
        json!({"remote": "80"}),
        json!({"remote": 1, "name": ""}),
        json!({"remote": 1, "name": units(65)}),
        json!({"remote": 1, "name": null}),
        json!({"remote": 1, "local": 0}),
        json!({"remote": 1, "local": 65536}),
        json!({"remote": 1, "local": null}),
        json!({"remote": 1, "local": 1.5}),
        json!({"remote": 1, "error": ""}),
        json!({"remote": 1, "error": units(201)}),
        json!({"remote": 1, "error": null}),
        json!(null),
        json!(5),
        json!([]),
    ];
    for row in rows {
        let frame = json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": [row]}});
        assert_eq!(round_trip(frame), None, "{row}");
    }
}

#[test]
fn limits_a_forward_error_to_200_units_and_a_forward_name_to_64() {
    let row = |name: String, error: String| json!({"remote": 1, "name": name, "error": error});
    let frame = |row: Value| json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": [row]}});
    assert!(round_trip(frame(row(units(64), units(200)))).is_some());
    assert_eq!(round_trip(frame(row(units(65), units(200)))), None);
    assert_eq!(round_trip(frame(row(units(64), units(201)))), None);
    assert_eq!(
        round_trip(frame(row(units(64), "\u{1f600}".repeat(101)))),
        None
    );
}

#[test]
fn limits_a_ports_result_to_4096_forwards() {
    let frame = |count: usize| json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": vec![json!({"remote": 80}); count]}});
    assert!(round_trip(frame(0)).is_some());
    assert!(round_trip(frame(4096)).is_some());
    assert_eq!(round_trip(frame(4097)), None);
}

#[test]
fn refuses_a_ports_result_that_is_not_ok_true_with_forwards_or_ok_false_with_an_error() {
    let results = [
        json!(null),
        json!(5),
        json!("ok"),
        json!([]),
        json!({}),
        json!({"ok": "true", "forwards": []}),
        json!({"ok": 1, "forwards": []}),
        json!({"ok": true}),
        json!({"ok": true, "forwards": null}),
        json!({"ok": true, "forwards": {}}),
        json!({"ok": false}),
        json!({"ok": false, "error": ""}),
        json!({"ok": false, "error": units(65)}),
        json!({"ok": false, "error": 5}),
        json!({"ok": null, "error": "x"}),
    ];
    for result in results {
        let frame = json!({"t": "ports-res", "id": "a", "result": result});
        assert_eq!(round_trip(frame), None, "{result}");
    }
    assert_eq!(round_trip(json!({"t": "ports-res", "id": "a"})), None);
}

#[test]
fn limits_an_error_result_to_64_units_and_drops_other_fields() {
    assert_eq!(
        round_trip(
            json!({"t": "ports-res", "id": "a", "result": {"ok": false, "error": units(64), "forwards": []}})
        ),
        Some(json!({"t": "ports-res", "id": "a", "result": {"ok": false, "error": units(64)}}))
    );
    assert_eq!(
        round_trip(
            json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": [], "error": "x"}})
        ),
        Some(json!({"t": "ports-res", "id": "a", "result": {"ok": true, "forwards": []}}))
    );
}

#[test]
fn refuses_a_ports_result_with_a_missing_or_long_id() {
    let result = json!({"ok": true, "forwards": []});
    assert_eq!(
        round_trip(json!({"t": "ports-res", "result": result})),
        None
    );
    assert_eq!(
        round_trip(json!({"t": "ports-res", "id": "", "result": result})),
        None
    );
    assert_eq!(
        round_trip(json!({"t": "ports-res", "id": units(101), "result": result})),
        None
    );
    assert!(round_trip(json!({"t": "ports-res", "id": units(100), "result": result})).is_some());
}

#[test]
fn writes_one_line_that_ends_in_a_newline_for_every_frame() {
    let lines = [
        ("{\"t\":\"hb\"}", "{\"t\":\"hb\"}\n"),
        (
            "{\"t\":\"hello\",\"version\":\"1\"}",
            "{\"t\":\"hello\",\"version\":\"1\"}\n",
        ),
        (
            "{\"t\":\"hello-ok\",\"version\":\"1\"}",
            "{\"t\":\"hello-ok\",\"version\":\"1\"}\n",
        ),
        (
            "{\"t\":\"incompatible\",\"version\":\"1\"}",
            "{\"t\":\"incompatible\",\"version\":\"1\"}\n",
        ),
        (
            "{\"t\":\"stored\",\"id\":\"m\"}",
            "{\"t\":\"stored\",\"id\":\"m\"}\n",
        ),
        (
            "{\"t\":\"refused\",\"id\":\"m\",\"reason\":\"full\"}",
            "{\"t\":\"refused\",\"id\":\"m\",\"reason\":\"full\"}\n",
        ),
    ];
    for (input, expected) in lines {
        assert_eq!(line_of(input).as_deref(), Some(expected), "{input}");
    }
}

#[test]
fn writes_a_frame_that_it_reads_back_as_the_same_frame() {
    let inputs = [
        json!({"t": "hb"}),
        json!({"t": "hello", "version": "9"}),
        json!({"t": "mail", "id": "m1", "from": "a", "to": "b", "text": "x\ny"}),
        json!({"t": "ports", "ports": [{"port": 3000, "name": "node"}]}),
        json!({"t": "ports-req", "id": "a", "op": "forward", "remote": 3000, "local": 80}),
        json!({"t": "ports-res", "id": "a", "result": {"ok": false, "error": "link-down"}}),
    ];
    for input in inputs {
        let line = line_of(&input.to_string()).unwrap();
        assert_eq!(line_of(&line), Some(line.clone()), "{input}");
    }
}
