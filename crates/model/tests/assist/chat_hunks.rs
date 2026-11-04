use ostia_model::assist::chat_hunks::{
    EditHunk, HunkCounts, HunkDecision, all_decided, content_with, edit_hunks, hunk_counts, settle,
};

const BEFORE: &str = "a\nb\nc\nd\ne\nf\ng\nh\n";
const AFTER: &str = "A\nb\nc\nd\ne\nf\ng\nH\nI\n";

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

use HunkDecision::{Accepted, Rejected};

#[test]
fn splits_a_change_into_hunks_separated_by_unchanged_lines_with_context_and_line_numbers() {
    let hunks = edit_hunks(BEFORE, AFTER);
    assert_eq!(hunks.len(), 2);
    assert_eq!(
        hunks[0],
        EditHunk {
            index: 0,
            old_start: 1,
            removed: lines(&["a"]),
            added: lines(&["A"]),
            leading: Vec::new(),
            trailing: lines(&["b", "c", "d"]),
        }
    );
    assert_eq!(
        hunks[1],
        EditHunk {
            index: 1,
            old_start: 8,
            removed: lines(&["h"]),
            added: lines(&["H", "I"]),
            leading: lines(&["e", "f", "g"]),
            trailing: Vec::new(),
        }
    );
}

#[test]
fn treats_a_new_file_as_one_hunk_of_added_lines_and_an_unchanged_file_as_none() {
    assert_eq!(
        edit_hunks("", "x\ny\n"),
        vec![EditHunk {
            index: 0,
            old_start: 1,
            removed: Vec::new(),
            added: lines(&["x", "y"]),
            leading: Vec::new(),
            trailing: Vec::new(),
        }]
    );
    assert_eq!(edit_hunks(BEFORE, BEFORE), Vec::<EditHunk>::new());
}

#[test]
fn rebuilds_the_file_from_the_accepted_hunks_only_byte_for_byte() {
    assert_eq!(content_with(BEFORE, AFTER, &[]), AFTER);
    assert_eq!(
        content_with(BEFORE, AFTER, &[Some(Accepted), Some(Rejected)]),
        "A\nb\nc\nd\ne\nf\ng\nh\n"
    );
    assert_eq!(
        content_with(BEFORE, AFTER, &[Some(Rejected), None]),
        "a\nb\nc\nd\ne\nf\ng\nH\nI\n"
    );
    assert_eq!(
        content_with(BEFORE, AFTER, &[Some(Rejected), Some(Rejected)]),
        BEFORE
    );
}

#[test]
fn keeps_crlf_line_endings_and_a_missing_final_newline() {
    let before = "one\r\ntwo\r\nthree";
    let after = "ONE\r\ntwo\r\nthree!";
    assert_eq!(
        content_with(before, after, &[Some(Accepted), Some(Rejected)]),
        "ONE\r\ntwo\r\nthree"
    );
    assert_eq!(
        content_with(before, after, &[Some(Rejected), Some(Accepted)]),
        "one\r\ntwo\r\nthree!"
    );
}

#[test]
fn counts_only_hunks_not_rejected_and_settles_undecided_hunks_as_accepted() {
    let hunks = edit_hunks(BEFORE, AFTER);
    assert_eq!(
        hunk_counts(&hunks, &[]),
        HunkCounts {
            added: 3,
            removed: 2
        }
    );
    assert_eq!(
        hunk_counts(&hunks, &[None, Some(Rejected)]),
        HunkCounts {
            added: 1,
            removed: 1
        }
    );
    assert!(!all_decided(2, &[Some(Accepted)]));
    assert!(all_decided(2, &[Some(Accepted), Some(Rejected)]));
    assert_eq!(settle(2, &[None, Some(Rejected)]), vec![Accepted, Rejected]);
}

#[test]
fn settles_a_missing_tail_as_accepted_and_ignores_extra_decisions() {
    assert_eq!(
        settle(3, &[Some(Rejected)]),
        vec![Rejected, Accepted, Accepted]
    );
    assert_eq!(settle(1, &[Some(Rejected), Some(Rejected)]), vec![Rejected]);
    assert!(all_decided(0, &[]));
}

#[test]
fn counts_nothing_for_a_file_with_no_hunks() {
    assert_eq!(
        hunk_counts(&[], &[]),
        HunkCounts {
            added: 0,
            removed: 0
        }
    );
}

#[test]
fn starts_the_next_hunk_after_the_removed_lines_of_the_one_before() {
    let before = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
    let after = "a\nB\nC\nd\ne\nf\ng\nh\ni\nJ\n";
    let hunks = edit_hunks(before, after);
    assert_eq!(hunks.len(), 2);
    assert_eq!(hunks[0].old_start, 2);
    assert_eq!(hunks[0].removed, lines(&["b", "c"]));
    assert_eq!(hunks[1].old_start, 10);
    assert_eq!(hunks[1].leading, lines(&["g", "h", "i"]));
}

#[test]
fn drops_the_carriage_return_from_the_lines_of_a_hunk() {
    let hunks = edit_hunks("one\r\ntwo\r\n", "one\r\n2\r\n");
    assert_eq!(hunks.len(), 1);
    assert_eq!(hunks[0].removed, lines(&["two"]));
    assert_eq!(hunks[0].added, lines(&["2"]));
    assert_eq!(hunks[0].leading, lines(&["one"]));
}
