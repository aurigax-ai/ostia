#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::remote_ports::{
    FORWARD_MAX, ForwardRow, LOCAL_PORT_MAX, LOCAL_PORT_MIN, LocalPortInput, PORTS_POLL_MS,
    parse_local_port, ports_table, valid_local_port, valid_remote_port,
};
use serde_json::{Value, json};

fn row(remote: u16, name: Option<&str>, local: Option<u16>, error: Option<&str>) -> ForwardRow {
    ForwardRow {
        remote,
        name: name.map(str::to_owned),
        local,
        error: error.map(str::to_owned),
    }
}

#[test]
fn keeps_the_forward_and_port_limits() {
    assert_eq!(FORWARD_MAX, 32);
    assert_eq!(PORTS_POLL_MS, 2000);
    assert_eq!(LOCAL_PORT_MIN, 1024);
    assert_eq!(LOCAL_PORT_MAX, 65535);
}

#[test]
fn accepts_a_local_port_from_1024_to_65535_and_nothing_else() {
    let table: Vec<(Value, bool)> = vec![
        (json!(1024), true),
        (json!(3000), true),
        (json!(65535), true),
        (json!(1023), false),
        (json!(0), false),
        (json!(-1), false),
        (json!(65536), false),
        (json!(1024.5), false),
        (json!("3000"), false),
        (json!(null), false),
        (json!(true), false),
        (json!([3000]), false),
        (json!({"port": 3000}), false),
    ];
    for (value, expected) in table {
        assert_eq!(valid_local_port(&value), expected, "{value}");
    }
}

#[test]
fn accepts_a_remote_port_from_1_to_65535_and_nothing_else() {
    let table: Vec<(Value, bool)> = vec![
        (json!(1), true),
        (json!(80), true),
        (json!(65535), true),
        (json!(0), false),
        (json!(-80), false),
        (json!(65536), false),
        (json!(80.5), false),
        (json!("80"), false),
        (json!(null), false),
        (json!(false), false),
        (json!([]), false),
    ];
    for (value, expected) in table {
        assert_eq!(valid_remote_port(&value), expected, "{value}");
    }
}

#[test]
fn reads_a_whole_number_written_with_a_fraction_or_an_exponent_as_a_port() {
    let whole: Value = serde_json::from_str("3000.0").unwrap();
    let exponent: Value = serde_json::from_str("3e3").unwrap();
    assert!(valid_local_port(&whole));
    assert!(valid_remote_port(&whole));
    assert!(valid_local_port(&exponent));
    assert!(valid_remote_port(&exponent));
}

#[test]
fn refuses_a_port_too_big_for_a_machine_integer_without_failing() {
    let huge: Value = serde_json::from_str("1e300").unwrap();
    let wide: Value = serde_json::from_str("18446744073709551616").unwrap();
    assert!(!valid_local_port(&huge));
    assert!(!valid_remote_port(&huge));
    assert!(!valid_local_port(&wide));
    assert!(!valid_remote_port(&wide));
}

#[test]
fn parses_a_local_port_text_as_unset_a_port_or_bad() {
    let table = [
        ("", LocalPortInput::Unset),
        ("   ", LocalPortInput::Unset),
        ("\t\n", LocalPortInput::Unset),
        ("3000", LocalPortInput::Port(3000)),
        (" 3000 ", LocalPortInput::Port(3000)),
        ("1024", LocalPortInput::Port(1024)),
        ("65535", LocalPortInput::Port(65535)),
        ("01024", LocalPortInput::Port(1024)),
        ("1023", LocalPortInput::Bad),
        ("80", LocalPortInput::Bad),
        ("00080", LocalPortInput::Bad),
        ("0", LocalPortInput::Bad),
        ("65536", LocalPortInput::Bad),
        ("99999", LocalPortInput::Bad),
        ("123456", LocalPortInput::Bad),
        ("-3000", LocalPortInput::Bad),
        ("+3000", LocalPortInput::Bad),
        ("3000.0", LocalPortInput::Bad),
        ("3e3", LocalPortInput::Bad),
        ("0x400", LocalPortInput::Bad),
        ("30 00", LocalPortInput::Bad),
        ("3000a", LocalPortInput::Bad),
        ("abc", LocalPortInput::Bad),
    ];
    for (text, expected) in table {
        assert_eq!(parse_local_port(text), expected, "{text:?}");
    }
}

#[test]
fn trims_the_text_of_a_local_port_as_javascript_does() {
    assert_eq!(
        parse_local_port("\u{feff}3000\u{a0}"),
        LocalPortInput::Port(3000)
    );
    assert_eq!(parse_local_port("\u{2003}3000"), LocalPortInput::Port(3000));
    assert_eq!(parse_local_port("\u{feff}"), LocalPortInput::Unset);
    assert_eq!(parse_local_port("\u{85}3000"), LocalPortInput::Bad);
    assert_eq!(parse_local_port("\u{200b}3000"), LocalPortInput::Bad);
}

#[test]
fn refuses_digits_that_are_not_ascii_in_a_local_port_text() {
    assert_eq!(
        parse_local_port("\u{0663}\u{0660}\u{0660}\u{0660}"),
        LocalPortInput::Bad
    );
    assert_eq!(
        parse_local_port("\u{ff13}\u{ff10}\u{ff10}\u{ff10}"),
        LocalPortInput::Bad
    );
}

#[test]
fn writes_a_ports_table_with_a_dash_for_each_missing_value() {
    let rows = [
        row(3000, Some("node"), Some(3001), None),
        row(80, None, None, Some("busy")),
        row(22, None, None, None),
    ];
    assert_eq!(
        ports_table(&rows),
        "3000\t3001\tnode\t-\n80\t-\t-\tbusy\n22\t-\t-\t-"
    );
}

#[test]
fn writes_an_empty_ports_table_as_an_empty_text() {
    assert_eq!(ports_table(&[]), "");
}

#[test]
fn writes_one_row_without_a_trailing_newline() {
    assert_eq!(
        ports_table(&[row(8080, Some("web"), Some(8080), None)]),
        "8080\t8080\tweb\t-"
    );
}

#[test]
fn keeps_an_empty_name_or_error_in_a_ports_table_as_it_is() {
    assert_eq!(
        ports_table(&[row(3000, Some(""), Some(3000), Some(""))]),
        "3000\t3000\t\t"
    );
}
