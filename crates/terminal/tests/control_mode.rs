#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::control_mode::{ControlEvent, ControlModeParser};

fn parse(chunks: &[&[u8]]) -> Vec<ControlEvent> {
    let mut parser = ControlModeParser::new();
    let mut events = Vec::new();
    for chunk in chunks {
        events.extend(parser.push(chunk));
    }
    events
}

fn output(pane: &str, data: &str) -> ControlEvent {
    ControlEvent::Output {
        pane: pane.to_owned(),
        data: data.to_owned(),
    }
}

fn reply(ok: bool, lines: &[&str]) -> ControlEvent {
    ControlEvent::Reply {
        ok,
        lines: lines.iter().map(|line| (*line).to_owned()).collect(),
    }
}

fn exit(reason: &str) -> ControlEvent {
    ControlEvent::Exit {
        reason: reason.to_owned(),
    }
}

fn text_of(events: &[ControlEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            ControlEvent::Output { data, .. } => Some(data.as_str()),
            _ => None,
        })
        .collect()
}

#[test]
fn ksh_c29_gives_a_pane_the_exact_bytes_behind_octal_escapes_and_a_utf_8_character_split_across_lines()
 {
    let events = parse(&[
        b"%output %1 a\\011b\\134\\033[0m",
        &[b"\n%output %1 x".as_slice(), &[0xe2, 0x82]].concat(),
        &[b"\n%output %1 ".as_slice(), &[0xac], b"!\n"].concat(),
    ]);
    assert_eq!(text_of(&events), "a\tb\\\u{1b}[0mx€!");
    assert!(events.iter().all(|event| match event {
        ControlEvent::Output { pane, .. } => pane == "%1",
        _ => true,
    }));
}

#[test]
fn collects_a_command_reply_between_begin_and_end_and_an_error_between_begin_and_error() {
    let events = parse(&[
        b"%begin 1 2 0\n%end 1 2 0\n%begin 1 3 1\n@1 %1 4242\n%end 1 3 1\n",
        b"%begin 1 4 1\nno such window: @9\n%error 1 4 1\n%exit\n",
    ]);
    assert_eq!(
        events,
        vec![
            reply(true, &["@1 %1 4242"]),
            reply(false, &["no such window: @9"]),
            exit(""),
        ]
    );
}

#[test]
fn carries_the_reason_tmux_gives_with_exit() {
    assert_eq!(
        parse(&[b"%exit too far behind\n"]),
        vec![exit("too far behind")]
    );
}

#[test]
fn reports_a_subscription_change_with_its_pane_and_value() {
    assert_eq!(
        parse(&[b"%subscription-changed ostia-dead $0 @1 1 %1 : 1:7:\n"]),
        vec![ControlEvent::Subscription {
            name: "ostia-dead".to_owned(),
            pane: "%1".to_owned(),
            value: "1:7:".to_owned(),
        }]
    );
}

#[test]
fn waits_for_the_newline_before_it_reads_a_line() {
    let mut parser = ControlModeParser::new();
    assert!(parser.push(b"%exit gone").is_empty());
    assert!(parser.push(b" away").is_empty());
    assert_eq!(parser.push(b"\n"), vec![exit("gone away")]);
}

#[test]
fn keeps_a_split_character_of_one_pane_apart_from_the_text_of_another_pane() {
    let events = parse(&[
        &[b"%output %1 ".as_slice(), &[0xe2, 0x82], b"\n"].concat(),
        b"%output %2 plain\n",
        &[b"%output %1 ".as_slice(), &[0xac], b"\n"].concat(),
    ]);
    assert_eq!(events, vec![output("%2", "plain"), output("%1", "€")]);
}

#[test]
fn forgets_the_half_received_character_of_a_pane_when_the_pane_is_forgotten() {
    let mut parser = ControlModeParser::new();
    assert!(
        parser
            .push(&[b"%output %1 ".as_slice(), &[0xe2, 0x82], b"\n"].concat())
            .is_empty()
    );
    parser.forget_pane("%1");
    assert_eq!(
        parser.push(&[b"%output %1 ".as_slice(), &[0xac], b"\n"].concat()),
        vec![output("%1", "\u{fffd}")]
    );
}

#[test]
fn gives_a_replacement_character_for_a_byte_that_is_not_utf_8_and_for_an_escape_above_255() {
    let events = parse(&[
        b"%output %1 a\\777b\n",
        &[b"%output %1 ".as_slice(), &[0xff], b"\n"].concat(),
    ]);
    assert_eq!(
        events,
        vec![output("%1", "a\u{fffd}b"), output("%1", "\u{fffd}")]
    );
}

#[test]
fn keeps_a_backslash_that_has_fewer_than_three_octal_digits() {
    let events = parse(&[b"%output %1 a\\01x\\8\\0\n"]);
    assert_eq!(text_of(&events), "a\\01x\\8\\0");
}

#[test]
fn reads_an_escape_that_gives_a_zero_byte_and_one_that_gives_a_newline() {
    let events = parse(&[b"%output %1 a\\000b\\012c\n"]);
    assert_eq!(text_of(&events), "a\0b\nc");
}

#[test]
fn ignores_an_output_line_that_has_no_space_after_the_pane() {
    assert!(parse(&[b"%output %1\n%output \n"]).is_empty());
}

#[test]
fn gives_an_empty_output_nothing_to_report() {
    assert!(parse(&[b"%output %1 \n"]).is_empty());
}

#[test]
fn does_not_report_a_reply_that_a_command_of_another_client_started() {
    let events = parse(&[b"%begin 1 5 0\nnot ours\n%end 1 5 0\n%exit\n"]);
    assert_eq!(events, vec![exit("")]);
}

#[test]
fn treats_a_begin_line_whose_flag_is_not_a_number_as_not_ours() {
    let events = parse(&[b"%begin 1 5 x\nlost\n%end 1 5 x\n%begin 1 6\nlost\n%end 1 6\n"]);
    assert!(events.is_empty());
}

#[test]
fn keeps_output_and_notification_lines_inside_a_reply_as_reply_lines() {
    let events = parse(&[b"%begin 1 7 1\n%output %1 hi\n%exit now\n%end 1 7 1\n"]);
    assert_eq!(events, vec![reply(true, &["%output %1 hi", "%exit now"])]);
}

#[test]
fn ends_a_reply_only_at_the_line_with_the_number_it_began_with() {
    let events = parse(&[b"%begin 1 7 1\n%end 1 8 1\n%error 2 9 1\n%end 1 7 1\n"]);
    assert_eq!(events, vec![reply(true, &["%end 1 8 1", "%error 2 9 1"])]);
}

#[test]
fn reads_output_again_after_a_reply_ends() {
    let events = parse(&[b"%begin 1 2 1\n%end 1 2 1\n%output %3 back\n"]);
    assert_eq!(events, vec![reply(true, &[]), output("%3", "back")]);
}

#[test]
fn replaces_bytes_that_are_not_utf_8_in_a_reply_line() {
    let events = parse(&[&[b"%begin 1 2 1\nbad ".as_slice(), &[0xff], b"\n%end 1 2 1\n"].concat()]);
    assert_eq!(events, vec![reply(true, &["bad \u{fffd}"])]);
}

#[test]
fn ignores_a_subscription_change_that_has_no_value_separator() {
    assert!(parse(&[b"%subscription-changed ostia-dead $0 @1 1 %1\n"]).is_empty());
}

#[test]
fn keeps_the_whole_value_of_a_subscription_change_when_it_holds_the_separator() {
    assert_eq!(
        parse(&[b"%subscription-changed n $0 @1 1 %1 : a : b\n"]),
        vec![ControlEvent::Subscription {
            name: "n".to_owned(),
            pane: "%1".to_owned(),
            value: "a : b".to_owned(),
        }]
    );
}

#[test]
fn leaves_the_pane_empty_when_a_subscription_change_is_short() {
    assert_eq!(
        parse(&[b"%subscription-changed n : v\n"]),
        vec![ControlEvent::Subscription {
            name: "n".to_owned(),
            pane: String::new(),
            value: "v".to_owned(),
        }]
    );
}

#[test]
fn ignores_a_notification_it_does_not_know() {
    assert!(parse(&[b"%window-add @1\n%layout-change @1 x\nplain text\n"]).is_empty());
}
