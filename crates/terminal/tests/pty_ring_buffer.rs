#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_terminal::pty_ring_buffer::{PtyRingBuffer, RingSlice, count_command_starts, tail_cut};

const START: &str = "\x1b]133;C\x07";

fn slice(data: &str, cursor: usize, dropped: bool, starts_before: usize) -> RingSlice {
    RingSlice {
        data: data.to_owned(),
        cursor,
        dropped,
        starts_before,
    }
}

#[test]
fn replays_everything_from_cursor_0_and_reports_the_end_position() {
    let mut rb = PtyRingBuffer::new(1000);
    rb.push("hello ");
    rb.push("world");
    assert_eq!(rb.end(), 11);
    assert_eq!(rb.since(0), slice("hello world", 11, false, 0));
}

#[test]
fn returns_only_new_bytes_since_a_cursor() {
    let mut rb = PtyRingBuffer::new(1000);
    rb.push("abc");
    let a = rb.since(0);
    rb.push("def");
    assert_eq!(rb.since(a.cursor), slice("def", 6, false, 0));
}

#[test]
fn replays_everything_as_dropped_for_a_cursor_past_the_end_from_an_earlier_pty() {
    let mut rb = PtyRingBuffer::new(1000);
    rb.push("fresh");
    assert_eq!(rb.since(500), slice("fresh", 5, true, 0));
}

#[test]
fn replays_everything_as_dropped_for_a_cursor_below_its_base_and_from_0_as_before() {
    let mut rb = PtyRingBuffer::with_base(1000, 5000);
    rb.push("fresh");
    assert_eq!(rb.since(2000), slice("fresh", 5005, true, 0));
    assert_eq!(rb.since(0), slice("fresh", 5005, false, 0));
    assert_eq!(rb.since(5003), slice("sh", 5005, false, 0));
}

#[test]
fn trims_at_a_newline_boundary_when_over_cap_marking_dropped_for_stale_cursors() {
    let mut rb = PtyRingBuffer::new(8);
    rb.push("aaaa\nbbbb\ncccc");
    let r = rb.since(0);
    assert!(r.dropped);
    assert_eq!(r.cursor, 14);
    assert!("aaaa\nbbbb\ncccc".ends_with(&r.data));
    assert!(r.data.starts_with("cccc") || r.data.starts_with("bbbb"));
}

#[test]
fn trims_to_the_esc_boundary_so_a_replayed_csi_is_never_cut_mid_sequence() {
    let mut rb = PtyRingBuffer::new(7);
    rb.push("xy\x1b[31mZ");
    let data = rb.since(0).data;
    assert_eq!(data, "\x1b[31mZ");
    assert!(data.starts_with('\x1b'));
}

#[test]
fn trims_a_quarter_below_the_cap_so_pushes_after_a_trim_leave_the_kept_text_alone() {
    let mut rb = PtyRingBuffer::new(100);
    rb.push(&"a".repeat(110));
    let trimmed = rb.since(0).data;
    assert!(trimmed.len() <= 75);
    rb.push(&"c".repeat(20));
    assert_eq!(rb.since(0).data, format!("{trimmed}{}", "c".repeat(20)));
}

#[test]
fn never_holds_more_than_the_cap() {
    let mut rb = PtyRingBuffer::new(64);
    for i in 0..500 {
        rb.push(&format!("line {i}\r\n"));
        assert!(rb.since(0).data.len() <= 64, "after line {i}");
    }
}

#[test]
fn counts_the_marks_trimmed_away_and_the_ones_before_the_cursor() {
    let mut rb = PtyRingBuffer::new(40);
    rb.push(&format!("{START}one\n{START}two\n"));
    rb.push(&format!("{}\n{START}three\n", "x".repeat(30)));
    let all = rb.since(0);
    assert!(all.dropped);
    assert_eq!(all.starts_before + count_command_starts(&all.data, None), 3);
    let later = rb.since(all.cursor - "three\n".len());
    assert_eq!(later.starts_before, 3);
}

#[test]
fn counts_a_mark_only_when_the_whole_mark_lies_before_the_end() {
    let text = format!("a{START}b");
    assert_eq!(count_command_starts(&text, Some(3)), 0);
    assert_eq!(count_command_starts(&text, None), 1);
}

#[test]
fn counts_positions_in_utf_16_units_as_js_strings_do() {
    let mut rb = PtyRingBuffer::new(1000);
    rb.push("a😀b");
    assert_eq!(rb.end(), 5);
    assert_eq!(rb.since(3), slice("b", 5, false, 0));
}

#[test]
fn cuts_nothing_when_the_data_fits_and_otherwise_at_the_first_newline_or_esc_after_the_cut() {
    let table: [(&str, usize, usize); 8] = [
        ("abcdef", 10, 0),
        ("abcdef", 6, 0),
        ("ab\ncdefgh", 7, 3),
        ("abcdefg\nh", 3, 8),
        ("ab\x1bcdefgh", 7, 2),
        ("ab\x1bc\nd", 4, 2),
        ("ab\ncd\x1be", 5, 3),
        ("abcdefgh", 3, 5),
    ];
    for (data, keep, expected) in table {
        assert_eq!(tail_cut(data, keep), expected, "{data:?} keep {keep}");
    }
}
