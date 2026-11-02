#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::Engine as _;
use ostia_terminal::tmux_command::{
    META_OPTION, NewWindowSpec, decode_meta, encode_meta, new_window_command, send_keys_commands,
    tmux_quote,
};
use serde_json::{Value, json};

fn spec(cwd: &str, env: &[(&str, &str)]) -> NewWindowSpec {
    NewWindowSpec {
        session: "ostia".to_owned(),
        file: "/bin/zsh".to_owned(),
        args: vec![
            "-l".to_owned(),
            "-c".to_owned(),
            "echo \"$HOME\"".to_owned(),
        ],
        cwd: cwd.to_owned(),
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
}

#[test]
fn quotes_a_plain_argument_in_double_quotes() {
    assert_eq!(tmux_quote("abc"), "\"abc\"");
    assert_eq!(tmux_quote(""), "\"\"");
}

#[test]
fn escapes_backslash_quote_and_dollar_with_a_backslash() {
    assert_eq!(tmux_quote("a\"b\\c$d"), "\"a\\\"b\\\\c\\$d\"");
}

#[test]
fn writes_newline_and_carriage_return_as_n_and_r() {
    assert_eq!(tmux_quote("a\nb\rc"), "\"a\\nb\\rc\"");
}

#[test]
fn writes_other_control_characters_as_three_digit_octal() {
    assert_eq!(tmux_quote("\tg\x00\x1f\x7fh"), "\"\\011g\\000\\037\\177h\"");
}

#[test]
fn keeps_non_ascii_text_and_hash_unchanged() {
    assert_eq!(
        tmux_quote("h \u{e9} \u{4e2d} \u{1f600} #"),
        "\"h \u{e9} \u{4e2d} \u{1f600} #\""
    );
}

#[test]
fn sends_text_as_lowercase_hex_bytes_of_its_utf8_form() {
    assert_eq!(
        send_keys_commands("%1", "h\u{e9}llo\r"),
        vec!["send-keys -t %1 -H 68 c3 a9 6c 6c 6f 0d"]
    );
}

#[test]
fn sends_nothing_for_empty_text() {
    assert!(send_keys_commands("%1", "").is_empty());
}

#[test]
fn splits_the_bytes_into_commands_of_at_most_512_bytes() {
    let commands = send_keys_commands("%1", &"a".repeat(513));
    let lengths: Vec<usize> = commands.iter().map(String::len).collect();
    assert_eq!(lengths, vec![1554, 21]);
    assert_eq!(commands[1], "send-keys -t %1 -H 61");
}

#[test]
fn splits_by_bytes_even_in_the_middle_of_a_character() {
    let commands = send_keys_commands("%1", &"\u{4e2d}".repeat(171));
    let words: Vec<usize> = commands.iter().map(|c| c.split(' ').count()).collect();
    assert_eq!(words, vec![516, 5]);
    assert!(commands[0].ends_with(" e4 b8"));
    assert!(commands[1].ends_with(" -H ad"));
}

#[test]
fn builds_the_new_window_command_with_the_tmux_env_removed() {
    assert_eq!(
        new_window_command(&spec("/tmp/a#b $c", &[("A", "1")])),
        "new-window -d -P -F \"#{window_id} #{pane_id} #{pane_pid}\" -t \"ostia:\" -c \"/tmp/a##b \\$c\" -e \"A=1\" -- \"/usr/bin/env\" \"-u\" \"TMUX\" \"-u\" \"TMUX_PANE\" \"/bin/zsh\" \"-l\" \"-c\" \"echo \\\"\\$HOME\\\"\""
    );
}

#[test]
fn skips_env_entries_with_an_empty_name_or_an_equals_sign_in_the_name() {
    let command = new_window_command(&spec(
        "/tmp",
        &[("A", "1"), ("", "no"), ("C=D", "no"), ("E", "")],
    ));
    assert!(command.contains(" -e \"A=1\" -e \"E=\" -- "), "{command}");
    assert!(!command.contains("no"), "{command}");
}

#[test]
fn quotes_env_values_and_keeps_their_order() {
    let command = new_window_command(&spec("/tmp", &[("B", "x y\"z"), ("A", "1")]));
    assert!(
        command.contains(" -e \"B=x y\\\"z\" -e \"A=1\" -- "),
        "{command}"
    );
}

#[test]
fn writes_no_env_flag_when_the_env_is_empty() {
    let command = new_window_command(&spec("/tmp", &[]));
    assert!(
        command.contains(" -c \"/tmp\" -- \"/usr/bin/env\""),
        "{command}"
    );
    assert!(!command.contains(" -e "), "{command}");
}

#[test]
fn names_the_meta_option_with_the_ostia_prefix() {
    assert_eq!(META_OPTION, "@ostia-meta");
}

#[test]
fn encodes_meta_as_base64_of_its_compact_json() {
    let meta = json!({"workspaceId": "w1", "title": "\u{e9}\u{4e2d}", "n": 5, "tags": ["a", null], "z": {"b": 1, "a": 2}});
    assert_eq!(
        encode_meta(&meta),
        "eyJ3b3Jrc3BhY2VJZCI6IncxIiwidGl0bGUiOiLDqeS4rSIsIm4iOjUsInRhZ3MiOlsiYSIsbnVsbF0sInoiOnsiYiI6MSwiYSI6Mn19"
    );
    assert_eq!(encode_meta(&Value::Null), "bnVsbA==");
    assert_eq!(encode_meta(&json!("s")), "InMi");
}

#[test]
fn decodes_what_it_encoded() {
    let meta = json!({"a": [1, {"b": null}]});
    assert_eq!(decode_meta(&encode_meta(&meta)), meta);
}

#[test]
fn decodes_an_empty_or_broken_value_to_null() {
    assert_eq!(decode_meta(""), Value::Null);
    assert_eq!(decode_meta("!!!"), Value::Null);
    assert_eq!(decode_meta("bm90IGpzb24="), Value::Null);
    assert_eq!(decode_meta("bnVsbA=="), Value::Null);
}

#[test]
fn decodes_any_json_value_not_only_objects() {
    assert_eq!(decode_meta("NQ=="), json!(5));
}

fn encoded(json_text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(json_text)
}

#[test]
fn keeps_a_meta_with_a_lone_surrogate_escape_instead_of_dropping_it() {
    let raw = encoded(r#"{"t":"a\ud800b","l":"\udc00","p":"\ud83d\ude00","s":"\\ud800"}"#);
    assert_eq!(
        decode_meta(&raw),
        json!({"t": "a\u{fffd}b", "l": "\u{fffd}", "p": "\u{1f600}", "s": "\\ud800"})
    );
}
