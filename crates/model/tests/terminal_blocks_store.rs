#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use ostia_base::clock::Clock;
use ostia_contract::agent_resume::ResumableAgent;
use ostia_model::terminal::blocks_store::{BlocksStore, CommandBlock, Draft, LineAnchor};

fn at(line: i64) -> LineAnchor {
    LineAnchor::at(line)
}

fn ticking(start: i64) -> Clock {
    let now = Arc::new(AtomicI64::new(start));
    Arc::new(move || now.fetch_add(1, Ordering::SeqCst))
}

fn first_block<'a>(store: &'a BlocksStore, pane: &str) -> &'a CommandBlock {
    store.blocks_of(pane).unwrap().first().unwrap()
}

fn live(anchors: &[LineAnchor]) -> usize {
    anchors.iter().filter(|a| !a.is_disposed()).count()
}

#[test]
fn runs_the_full_a_b_c_d_lifecycle_into_a_single_committed_block() {
    let mut store = BlocksStore::with_clock(ticking(1000));
    let p = "pane-1";
    store.prompt_start(p, at(10), Some("/home"), false);
    store.prompt_end(p, at(12));
    store.command_start(p, at(13), "", None, None);
    let running = first_block(&store, p);
    assert_eq!(running.started_at, 1000);
    assert_eq!(running.ended_at, None);

    assert!(store.command_end(p, at(20), 0, None, None, None));

    let list = store.blocks_of(p).unwrap();
    assert_eq!(list.len(), 1);
    let block = &list[0];
    assert_eq!(block.pane_id, p);
    assert_eq!(block.prompt_line, at(10));
    assert_eq!(block.input_line, Some(at(12)));
    assert_eq!(block.output_start_line, at(13));
    assert_eq!(block.end_line, Some(at(20)));
    assert_eq!(block.exit_code, Some(0));
    assert_eq!(block.cwd.as_deref(), Some("/home"));
    assert!(block.ended_at.unwrap() >= block.started_at);
    assert!(store.running_of(p).is_none());
    assert!(store.draft_of(p).is_none());
}

#[test]
fn sets_the_draft_on_prompt_start_and_fills_input_line_on_prompt_end() {
    let mut store = BlocksStore::default();
    let p = "pane-draft";
    store.prompt_start(p, at(4), Some("/tmp"), false);
    assert_eq!(
        store.draft_of(p),
        Some(&Draft {
            prompt_line: at(4),
            input_line: None,
            cwd: Some("/tmp".to_owned()),
            remote: false,
        })
    );

    assert!(store.prompt_end(p, at(7)));
    assert_eq!(
        store.draft_of(p),
        Some(&Draft {
            prompt_line: at(4),
            input_line: Some(at(7)),
            cwd: Some("/tmp".to_owned()),
            remote: false,
        })
    );
    assert!(store.blocks_of(p).is_none());
}

#[test]
fn replaces_the_draft_when_a_second_prompt_start_arrives_before_any_command_start() {
    let mut store = BlocksStore::default();
    let p = "pane-overwrite";
    store.prompt_start(p, at(10), Some("/a"), false);
    store.prompt_start(p, at(20), Some("/b"), false);
    assert_eq!(
        store.draft_of(p),
        Some(&Draft {
            prompt_line: at(20),
            input_line: None,
            cwd: Some("/b".to_owned()),
            remote: false,
        })
    );
    assert!(store.blocks_of(p).is_none());
}

#[test]
fn command_start_with_no_prior_draft_uses_the_fallback_prompt_line_input_line_line_cwd_none() {
    let mut store = BlocksStore::default();
    let p = "pane-fallback";
    store.command_start(p, at(5), "", None, None);

    let list = store.blocks_of(p).unwrap();
    assert_eq!(list.len(), 1);
    let block = &list[0];
    assert_eq!(block.prompt_line, at(5));
    assert_eq!(block.input_line, Some(at(5)));
    assert_eq!(block.output_start_line, at(5));
    assert_eq!(block.end_line, None);
    assert_eq!(block.exit_code, None);
    assert_eq!(block.cwd, None);
    assert_eq!(store.running_of(p), Some(block.id.as_str()));
    assert!(store.draft_of(p).is_none());
}

#[test]
fn recovers_a_lost_osc_133_d_by_closing_the_stale_block_when_the_next_command_start_arrives() {
    let mut store = BlocksStore::with_clock(ticking(1));
    let p = "pane-stale";
    store.prompt_start(p, at(1), Some("/a"), false);
    store.command_start(p, at(2), "", None, None);
    let block1 = first_block(&store, p).clone();
    assert_eq!(block1.end_line, None);
    assert_eq!(store.running_of(p), Some(block1.id.as_str()));

    store.prompt_start(p, at(8), Some("/b"), false);
    store.command_start(p, at(9), "", None, None);

    let list = store.blocks_of(p).unwrap();
    assert_eq!(list.len(), 2);
    let (closed, current) = (&list[0], &list[1]);
    assert_eq!(closed.end_line, Some(at(9)));
    assert!(closed.ended_at.is_some());
    assert_eq!(closed.exit_code, None);
    assert_eq!(current.end_line, None);
    assert_eq!(store.running_of(p), Some(current.id.as_str()));
    assert_ne!(current.id, closed.id);
}

#[test]
fn replaces_the_block_command_when_the_shell_reports_the_whole_command_at_its_end() {
    let mut store = BlocksStore::default();
    let p = "pane-whole";
    store.prompt_start(p, at(1), Some("/home"), false);
    store.command_start(p, at(2), "echo ostia_ml_1", None, None);

    store.command_end(
        p,
        at(5),
        0,
        Some(0),
        Some("echo ostia_ml_1\necho ostia_ml_2"),
        None,
    );

    let block = first_block(&store, p);
    assert_eq!(block.command, "echo ostia_ml_1\necho ostia_ml_2");
    assert_eq!(block.end_line, Some(at(5)));
    assert_eq!(block.exit_code, Some(0));
}

#[test]
fn ignores_a_whole_command_that_does_not_continue_the_one_read_at_its_start() {
    let mut store = BlocksStore::default();
    let p = "pane-forged";
    store.prompt_start(p, at(1), Some("/home"), false);
    store.command_start(p, at(2), "cat notes.txt", None, None);

    store.command_end(p, at(5), 0, Some(0), Some("rm -rf ~\necho gone"), None);

    assert_eq!(first_block(&store, p).command, "cat notes.txt");
}

#[test]
fn keeps_the_command_read_at_its_start_when_the_end_reports_none() {
    let mut store = BlocksStore::default();
    let p = "pane-kept";
    store.prompt_start(p, at(1), Some("/home"), false);
    store.command_start(p, at(2), "ls -la", None, None);

    store.command_end(p, at(5), 0, None, None, None);

    assert_eq!(first_block(&store, p).command, "ls -la");
}

#[test]
fn command_end_is_a_no_op_when_nothing_is_running_fresh_pane() {
    let mut store = BlocksStore::default();
    let p = "pane-noop-end";
    assert!(!store.command_end(p, at(99), 0, None, None, None));
    assert!(store.blocks_of(p).is_none());
    assert!(store.running_of(p).is_none());
}

#[test]
fn prompt_end_is_a_no_op_when_there_is_no_draft() {
    let mut store = BlocksStore::default();
    let p = "pane-noop-end-b";
    assert!(!store.prompt_end(p, at(42)));
    assert!(store.draft_of(p).is_none());
}

#[test]
fn caps_a_pane_at_max_blocks_per_pane_200_dropping_the_oldest() {
    let mut store = BlocksStore::default();
    let p = "pane-cap";
    for i in 0..201 {
        store.prompt_start(p, at(i), Some(&format!("/d/{i}")), false);
        store.command_start(p, at(i), "", None, None);
    }
    let list = store.blocks_of(p).unwrap();
    assert_eq!(list.len(), 200);
    assert_eq!(list[0].output_start_line, at(1));
    assert_eq!(list[list.len() - 1].output_start_line, at(200));
}

#[test]
fn reset_pane_clears_the_pane_and_bumps_its_generation_counter() {
    let mut store = BlocksStore::default();
    let p = "pane-reset";
    let other = "pane-other";
    store.prompt_start(p, at(1), Some("/a"), false);
    store.command_start(p, at(2), "", None, None);
    store.prompt_start(other, at(3), Some("/b"), false);
    store.command_start(other, at(4), "", None, None);
    assert_eq!(store.blocks_of(p).unwrap().len(), 1);
    assert_eq!(store.gen_of(p), None);

    store.reset_pane(p);
    assert_eq!(store.blocks_of(p), Some(&[][..]));
    assert!(store.draft_of(p).is_none());
    assert!(store.running_of(p).is_none());
    assert_eq!(store.gen_of(p), Some(1));

    store.reset_pane(p);
    assert_eq!(store.gen_of(p), Some(2));

    assert_eq!(store.blocks_of(other).unwrap().len(), 1);
    assert!(store.running_of(other).is_some());
    assert_eq!(store.gen_of(other), None);
}

#[test]
fn keeps_two_panes_isolated_a_mutation_to_pane_a_leaves_pane_b_intact() {
    let mut store = BlocksStore::default();
    let a = "pane-a";
    let b = "pane-b";
    store.prompt_start(b, at(100), Some("/b"), false);
    store.command_start(b, at(101), "", None, None);
    store.command_end(b, at(110), 0, None, None, None);
    let b_before = store.blocks_of(b).unwrap().to_vec();
    let b_block_id = b_before[0].id.clone();

    store.prompt_start(a, at(1), Some("/a"), false);
    store.command_start(a, at(2), "", None, None);
    store.reset_pane(a);

    assert_eq!(store.blocks_of(b).unwrap(), b_before.as_slice());
    assert_eq!(store.blocks_of(b).unwrap().len(), 1);
    assert_eq!(store.blocks_of(b).unwrap()[0].id, b_block_id);
    assert_eq!(first_block(&store, b).end_line, Some(at(110)));
    assert_eq!(first_block(&store, b).exit_code, Some(0));
    assert!(store.running_of(b).is_none());
    assert_eq!(store.gen_of(b), None);
}

#[test]
fn drop_pane_removes_every_record_for_a_closed_pane_and_leaves_others_intact() {
    let mut store = BlocksStore::default();
    store.prompt_start("gone", at(1), Some("/a"), false);
    store.command_start("gone", at(2), "", None, None);
    store.reset_pane("gone");
    store.prompt_start("gone", at(3), Some("/a"), false);
    store.command_start("gone", at(4), "", None, None);
    store.prompt_start("kept", at(5), Some("/b"), false);
    store.command_start("kept", at(6), "", None, None);

    assert!(store.drop_pane("gone"));

    assert!(store.blocks_of("gone").is_none());
    assert!(store.draft_of("gone").is_none());
    assert!(store.running_of("gone").is_none());
    assert!(store.gen_of("gone").is_none());
    assert!(store.selected_of("gone").is_none());
    assert!(store.agent_block_of("gone").is_none());
    assert_eq!(store.blocks_of("kept").unwrap().len(), 1);
    assert!(store.running_of("kept").is_some());
}

#[test]
fn drop_pane_is_a_no_op_for_a_pane_the_store_never_saw() {
    let mut store = BlocksStore::default();
    store.command_start("seen", at(1), "ls", None, None);
    assert!(!store.drop_pane("never"));
    assert_eq!(store.blocks_of("seen").unwrap().len(), 1);
}

#[test]
fn reads_block_positions_live_from_the_anchors_so_they_follow_reflow_and_trimming() {
    let mut store = BlocksStore::default();
    let start = at(40);
    let end = at(45);
    store.prompt_start("live", at(39), None, false);
    store.command_start("live", start.clone(), "", None, None);
    store.command_end("live", end.clone(), 0, None, None, None);
    start.set_line(12);
    end.set_line(-1);
    let block = first_block(&store, "live");
    assert_eq!(block.output_start_line.line(), 12);
    assert_eq!(block.end_line.as_ref().unwrap().line(), -1);
}

#[test]
fn keeps_the_command_text_and_the_column_where_output_ended() {
    let mut store = BlocksStore::default();
    store.prompt_start("cmd", at(0), Some("/w"), false);
    store.command_start("cmd", at(1), "printf abc", None, None);
    store.command_end("cmd", at(1), 0, Some(3), None, None);
    let block = first_block(&store, "cmd");
    assert_eq!(block.command, "printf abc");
    assert_eq!(block.end_col, 3);
}

#[test]
fn selects_a_known_block_clears_with_none_and_ignores_unknown_ids() {
    let mut store = BlocksStore::default();
    store.command_start("sel", at(1), "ls", None, None);
    let id = first_block(&store, "sel").id.clone();
    assert!(store.select("sel", Some(&id)));
    assert_eq!(store.selected_of("sel"), Some(id.as_str()));
    assert!(!store.select("sel", Some(&id)));

    assert!(!store.select("sel", Some("bogus")));
    assert_eq!(store.selected_of("sel"), Some(id.as_str()));

    assert!(store.select("sel", None));
    assert!(store.selected_of("sel").is_none());
    assert!(!store.select("sel", None));
}

#[test]
fn drops_the_selection_on_reset_on_drop_and_when_the_block_ages_out() {
    let mut store = BlocksStore::default();
    store.command_start("r", at(1), "ls", None, None);
    let id = first_block(&store, "r").id.clone();
    store.select("r", Some(&id));
    store.reset_pane("r");
    assert!(store.selected_of("r").is_none());

    store.command_start("d", at(1), "ls", None, None);
    let id = first_block(&store, "d").id.clone();
    store.select("d", Some(&id));
    store.drop_pane("d");
    assert!(store.selected_of("d").is_none());

    store.command_start("t", at(0), "first", None, None);
    let id = first_block(&store, "t").id.clone();
    store.select("t", Some(&id));
    for i in 1..=200 {
        store.command_start("t", at(i), &format!("cmd {i}"), None, None);
    }
    assert!(store.selected_of("t").is_none());
}

#[test]
fn disposes_the_anchors_of_a_block_that_ages_out_keeping_live_ones_bounded() {
    let mut store = BlocksStore::default();
    let p = "pane-evict";
    let mut made: Vec<LineAnchor> = Vec::new();
    let mut first: Vec<LineAnchor> = Vec::new();
    for i in 0..260 {
        let anchors: Vec<LineAnchor> = (0..4).map(|_| at(i)).collect();
        made.extend(anchors.iter().cloned());
        if i == 0 {
            first.extend(anchors.iter().cloned());
        }
        store.prompt_start(p, anchors[0].clone(), Some("/w"), false);
        store.prompt_end(p, anchors[1].clone());
        store.command_start(p, anchors[2].clone(), &format!("cmd {i}"), None, None);
        store.command_end(p, anchors[3].clone(), 0, None, None, None);
    }
    assert_eq!(store.blocks_of(p).unwrap().len(), 200);
    assert!(first.iter().all(LineAnchor::is_disposed));
    assert_eq!(live(&made), 200 * 4);
}

#[test]
fn keeps_an_evicted_block_anchor_that_a_newer_block_still_uses() {
    let mut store = BlocksStore::default();
    let p = "pane-shared";
    store.command_start(p, at(0), "lost end", None, None);
    let shared = at(1);
    store.command_start(p, shared.clone(), "next", None, None);
    for i in 2..=200 {
        store.command_start(p, at(i), &format!("cmd {i}"), None, None);
    }
    assert!(
        store.blocks_of(p).unwrap()[0]
            .output_start_line
            .is_same(&shared)
    );
    assert!(!shared.is_disposed());
}

#[test]
fn disposes_a_replaced_draft_and_an_end_that_matches_no_running_block() {
    let mut store = BlocksStore::default();
    let p = "pane-drafts";
    let old_prompt = at(0);
    let old_input = at(0);
    store.prompt_start(p, old_prompt.clone(), Some("/w"), false);
    store.prompt_end(p, old_input.clone());
    let new_input = at(0);
    store.prompt_end(p, new_input.clone());
    assert!(old_input.is_disposed());
    store.prompt_start(p, at(1), Some("/w"), false);
    assert!(old_prompt.is_disposed());
    assert!(new_input.is_disposed());
    let orphan_end = at(1);
    store.command_end(p, orphan_end.clone(), 0, None, None, None);
    assert!(orphan_end.is_disposed());
}

#[test]
fn keeps_the_remote_flag_of_the_prompt_in_the_draft() {
    let mut store = BlocksStore::default();
    store.prompt_start("p", at(1), Some("/srv"), true);
    assert!(store.draft_of("p").unwrap().remote);
    store.prompt_start("p", at(2), Some("/srv"), false);
    assert!(!store.draft_of("p").unwrap().remote);
}

#[test]
fn keeps_the_typed_command_and_the_sequence_and_leaves_them_unset_when_absent() {
    let mut store = BlocksStore::default();
    store.command_start("typed", at(1), "ls", Some("l"), Some(7));
    let block = first_block(&store, "typed");
    assert_eq!(block.typed_command.as_deref(), Some("l"));
    assert_eq!(block.seq, Some(7));

    store.command_start("plain", at(1), "ls", None, None);
    let block = first_block(&store, "plain");
    assert_eq!(block.typed_command, None);
    assert_eq!(block.seq, None);
}

#[test]
fn replaces_the_typed_command_only_when_the_whole_typed_command_continues_it() {
    let mut store = BlocksStore::default();
    store.command_start("cont", at(1), "echo a", Some("e a"), None);
    store.command_end(
        "cont",
        at(2),
        0,
        None,
        Some("echo a\necho b"),
        Some("e a\ne b"),
    );
    let block = first_block(&store, "cont");
    assert_eq!(block.command, "echo a\necho b");
    assert_eq!(block.typed_command.as_deref(), Some("e a\ne b"));

    store.command_start("forged", at(1), "echo a", Some("e a"), None);
    store.command_end("forged", at(2), 0, None, None, Some("rm\nx"));
    assert_eq!(
        first_block(&store, "forged").typed_command.as_deref(),
        Some("e a")
    );

    store.command_start("untyped", at(1), "echo a", None, None);
    store.command_end("untyped", at(2), 0, None, None, Some("e a\ne b"));
    assert_eq!(first_block(&store, "untyped").typed_command, None);
}

#[test]
fn gives_every_block_its_own_id_that_starts_with_the_pane_and_the_output_line() {
    let mut store = BlocksStore::default();
    store.command_start("pane-x", at(3), "a", None, None);
    store.command_end("pane-x", at(4), 0, None, None, None);
    store.command_start("pane-x", at(3), "a", None, None);
    let list = store.blocks_of("pane-x").unwrap();
    assert_ne!(list[0].id, list[1].id);
    assert!(list.iter().all(|b| b.id.starts_with("pane-x-3-")));
}

#[test]
fn marks_the_running_block_with_its_agent_and_changes_nothing_when_it_is_the_same() {
    let mut store = BlocksStore::default();
    assert!(!store.mark_agent("p", ResumableAgent::Claude));
    assert!(store.agent_block_of("p").is_none());

    store.command_start("p", at(1), "claude", None, None);
    let id = first_block(&store, "p").id.clone();
    assert!(store.mark_agent("p", ResumableAgent::Claude));
    let marked = store.agent_block_of("p").unwrap();
    assert_eq!(marked.block_id, id);
    assert_eq!(marked.agent, ResumableAgent::Claude);

    assert!(!store.mark_agent("p", ResumableAgent::Claude));
    assert!(store.mark_agent("p", ResumableAgent::Codex));
    assert_eq!(
        store.agent_block_of("p").unwrap().agent,
        ResumableAgent::Codex
    );
}

#[test]
fn reset_pane_and_drop_pane_forget_the_agent_block() {
    let mut store = BlocksStore::default();
    store.command_start("a", at(1), "claude", None, None);
    store.mark_agent("a", ResumableAgent::Claude);
    store.reset_pane("a");
    assert!(store.agent_block_of("a").is_none());

    store.command_start("b", at(1), "claude", None, None);
    store.mark_agent("b", ResumableAgent::Claude);
    assert!(store.drop_pane("b"));
    assert!(store.agent_block_of("b").is_none());
}

#[test]
fn keeps_the_selection_when_a_new_command_starts_and_its_block_is_still_listed() {
    let mut store = BlocksStore::default();
    store.command_start("keep", at(1), "ls", None, None);
    let id = first_block(&store, "keep").id.clone();
    store.select("keep", Some(&id));
    store.command_start("keep", at(2), "pwd", None, None);
    assert_eq!(store.selected_of("keep"), Some(id.as_str()));
}
