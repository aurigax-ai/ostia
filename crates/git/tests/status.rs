#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_base::js::utf16_len;
use ostia_git::git::{BranchInfo, ChangeArea, FileChange, LineChanges, StatusSummary};
use ostia_git::status::{
    branch_chip_text, branch_label, diff_stats_chip_text, parse_porcelain_v2, parse_shortstat,
    summarize, text_line_count, with_untracked,
};

fn hash() -> String {
    "a".repeat(40)
}

fn modes() -> String {
    let hash = hash();
    format!("100644 100644 100644 {hash} {hash}")
}

fn porcelain(records: &[&str]) -> String {
    records.iter().map(|r| format!("{r}\0")).collect()
}

fn lines(files: i64, added: i64, removed: i64) -> LineChanges {
    LineChanges {
        files,
        added,
        removed,
    }
}

fn change(path: &str, orig_path: Option<&str>, area: ChangeArea, code: &str) -> FileChange {
    FileChange {
        path: path.to_owned(),
        orig_path: orig_path.map(str::to_owned),
        area,
        code: code.to_owned(),
    }
}

fn main_branch() -> BranchInfo {
    BranchInfo {
        oid: Some("f".repeat(40)),
        head: Some("main".to_owned()),
        upstream: None,
        ahead: 0,
        behind: 0,
    }
}

fn tracking(branch: BranchInfo) -> BranchInfo {
    BranchInfo {
        upstream: Some("origin/main".to_owned()),
        ..branch
    }
}

#[test]
fn shows_the_branch_alone_when_there_is_no_upstream_or_it_is_in_sync() {
    let branch = main_branch();
    assert_eq!(branch_chip_text(&branch, ""), "main");
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                ahead: 3,
                ..branch.clone()
            },
            ""
        ),
        "main"
    );
    assert_eq!(branch_chip_text(&tracking(branch), ""), "main");
}

#[test]
fn adds_ahead_and_behind_after_a_dot_when_tracking_an_upstream() {
    let tracked = tracking(main_branch());
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                ahead: 2,
                behind: 1,
                ..tracked.clone()
            },
            ""
        ),
        "main · ↑2 ↓1"
    );
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                behind: 4,
                ..tracked.clone()
            },
            ""
        ),
        "main · ↓4"
    );
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                ahead: 1200,
                ..tracked
            },
            ""
        ),
        "main · ↑999+"
    );
}

#[test]
fn puts_the_line_counts_between_the_branch_and_the_tracking_counts() {
    let tracked = BranchInfo {
        behind: 3,
        ..tracking(main_branch())
    };
    assert_eq!(branch_chip_text(&tracked, "+12 −3"), "main · +12 −3 · ↓3");
    assert_eq!(branch_chip_text(&main_branch(), "+12 −3"), "main · +12 −3");
    assert_eq!(branch_chip_text(&main_branch(), ""), "main");
}

#[test]
fn cuts_a_long_branch_name_so_the_counts_stay_visible() {
    let long = BranchInfo {
        head: Some(format!("feature/{}", "x".repeat(60))),
        upstream: Some("origin/x".to_owned()),
        behind: 3,
        ..main_branch()
    };
    assert_eq!(
        branch_chip_text(&long, "+1"),
        format!("feature/{}… · +1 · ↓3", "x".repeat(19))
    );
}

#[test]
fn shows_the_short_sha_when_detached_and_nothing_without_any_commit_or_branch() {
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                head: None,
                ..main_branch()
            },
            ""
        ),
        "fffffff"
    );
    assert_eq!(
        branch_chip_text(
            &BranchInfo {
                head: None,
                oid: None,
                ..main_branch()
            },
            ""
        ),
        ""
    );
}

#[test]
fn parses_git_diff_shortstat_output() {
    assert_eq!(
        parse_shortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n"),
        Some(lines(3, 12, 4))
    );
    assert_eq!(
        parse_shortstat(" 1 file changed, 1 insertion(+)"),
        Some(lines(1, 1, 0))
    );
    assert_eq!(
        parse_shortstat(" 1 file changed, 2 deletions(-)"),
        Some(lines(1, 0, 2))
    );
    assert_eq!(parse_shortstat(""), None);
}

#[test]
fn formats_added_removed_leaving_out_a_zero_side_and_a_clean_tree() {
    assert_eq!(diff_stats_chip_text(Some(&lines(3, 12, 4))), "+12 −4");
    assert_eq!(diff_stats_chip_text(Some(&lines(1, 0, 2))), "−2");
    assert_eq!(diff_stats_chip_text(Some(&lines(1, 5, 0))), "+5");
    assert_eq!(diff_stats_chip_text(Some(&lines(0, 0, 0))), "");
    assert_eq!(diff_stats_chip_text(None), "");
}

#[test]
fn counts_lines_with_or_without_a_final_newline() {
    assert_eq!(text_line_count(b"a\nb\n", 8000), 2);
    assert_eq!(text_line_count(b"a\nb", 8000), 2);
}

#[test]
fn counts_nothing_for_an_empty_or_binary_file() {
    assert_eq!(text_line_count(&[], 8000), 0);
    assert_eq!(text_line_count(&[65, 0, 10, 66], 8000), 0);
}

#[test]
fn adds_new_files_and_their_lines_to_the_tracked_changes() {
    assert_eq!(
        with_untracked(Some(&lines(2, 2, 1)), &[5, 0]),
        lines(4, 7, 1)
    );
}

#[test]
fn reports_new_files_in_a_tree_with_no_tracked_changes() {
    assert_eq!(with_untracked(None, &[3]), lines(1, 3, 0));
}

#[test]
fn reads_branch_upstream_and_ahead_behind_headers() {
    let hash = hash();
    let status = parse_porcelain_v2(&porcelain(&[
        &format!("# branch.oid {hash}"),
        "# branch.head feature/x",
        "# branch.upstream origin/feature/x",
        "# branch.ab +3 -1",
    ]));
    assert_eq!(
        status.branch,
        BranchInfo {
            oid: Some(hash),
            head: Some("feature/x".to_owned()),
            upstream: Some("origin/feature/x".to_owned()),
            ahead: 3,
            behind: 1,
        }
    );
    assert!(status.changes.is_empty());
}

#[test]
fn reports_a_fresh_repo_and_a_detached_head_as_nulls() {
    let fresh = parse_porcelain_v2(&porcelain(&[
        "# branch.oid (initial)",
        "# branch.head main",
    ]));
    assert_eq!(
        fresh.branch,
        BranchInfo {
            oid: None,
            head: Some("main".to_owned()),
            upstream: None,
            ahead: 0,
            behind: 0,
        }
    );
    let hash = hash();
    let detached = parse_porcelain_v2(&porcelain(&[
        &format!("# branch.oid {hash}"),
        "# branch.head (detached)",
    ]));
    assert_eq!(detached.branch.oid, Some(hash));
    assert_eq!(detached.branch.head, None);
}

#[test]
fn splits_an_ordinary_entry_into_staged_and_unstaged_changes_keeping_spaces_in_paths() {
    let modes = modes();
    let status = parse_porcelain_v2(&porcelain(&[
        &format!("1 MM N... {modes} src/a file.ts"),
        &format!("1 .D N... {modes} gone.txt"),
    ]));
    assert_eq!(
        status.changes,
        vec![
            change("src/a file.ts", None, ChangeArea::Staged, "M"),
            change("src/a file.ts", None, ChangeArea::Unstaged, "M"),
            change("gone.txt", None, ChangeArea::Unstaged, "D"),
        ]
    );
}

#[test]
fn reads_a_rename_with_its_original_path_from_the_next_nul_field() {
    let modes = modes();
    let status = parse_porcelain_v2(&porcelain(&[
        &format!("2 R. N... {modes} R100 new name.ts"),
        "old name.ts",
        "? after.txt",
    ]));
    assert_eq!(
        status.changes,
        vec![
            change("new name.ts", Some("old name.ts"), ChangeArea::Staged, "R"),
            change("after.txt", None, ChangeArea::Untracked, "?"),
        ]
    );
}

#[test]
fn reads_unmerged_and_untracked_entries_and_ignores_ignored_ones() {
    let hash = hash();
    let status = parse_porcelain_v2(&porcelain(&[
        &format!("u UU N... 100644 100644 100644 100644 {hash} {hash} {hash} both.txt"),
        "? new dir/file.md",
        "! build/out.js",
    ]));
    assert_eq!(
        status.changes,
        vec![
            change("both.txt", None, ChangeArea::Conflicted, "U"),
            change("new dir/file.md", None, ChangeArea::Untracked, "?"),
        ]
    );
}

#[test]
fn counts_new_files_untracked_or_staged_adds_apart_from_other_changes_per_path() {
    let modes = modes();
    let status = parse_porcelain_v2(&porcelain(&[
        &format!("1 A. N... {modes} added.ts"),
        &format!("1 AM N... {modes} added-then-edited.ts"),
        &format!("1 MM N... {modes} both.ts"),
        &format!("1 .M N... {modes} edited.ts"),
        "? scratch.txt",
    ]));
    assert_eq!(
        summarize(&status),
        StatusSummary {
            added: 3,
            changed: 2,
            staged: 3,
            unstaged: 3,
            untracked: 1,
            conflicted: 0,
        }
    );
}

#[test]
fn labels_a_detached_head_by_short_sha_and_truncates_long_branch_names() {
    let detached = BranchInfo {
        oid: Some(hash()),
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    assert_eq!(branch_label(&detached), "(aaaaaaa)");
    let long = branch_label(&BranchInfo {
        oid: None,
        head: Some("x".repeat(60)),
        upstream: None,
        ahead: 0,
        behind: 0,
    });
    assert_eq!(utf16_len(&long), 40);
    assert!(long.ends_with('…'));
}
