#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ostia_base::old_dirs_prompt::{
    Ask, AskOptions, DialogKind, OldDirsDeps, OldDirsOutcome, offer_old_dirs_move, old_dirs_text,
};
use ostia_base::user_dirs::DirMove;
use tempfile::{TempDir, tempdir};

struct Fixture {
    _home: TempDir,
    from: PathBuf,
    to: PathBuf,
    moves: Vec<DirMove>,
}

fn fixture() -> Fixture {
    let home = tempdir().unwrap();
    let from = home.path().join("pine");
    let to = home.path().join("ostia");
    fs::create_dir(&from).unwrap();
    fs::write(from.join("workspaces.json"), "{\"w\":1}").unwrap();
    let moves = vec![DirMove {
        from: from.clone(),
        to: to.clone(),
        leave: Vec::new(),
        drop: Vec::new(),
    }];
    Fixture {
        _home: home,
        from,
        to,
        moves,
    }
}

fn answering(answers: &[usize]) -> (Arc<Mutex<Vec<AskOptions>>>, Ask) {
    let asked: Arc<Mutex<Vec<AskOptions>>> = Arc::default();
    let queue = Arc::new(Mutex::new(VecDeque::from(answers.to_vec())));
    let seen = Arc::clone(&asked);
    let ask: Ask = Arc::new(move |options| {
        seen.lock().unwrap().push(options);
        let answer = queue.lock().unwrap().pop_front().unwrap_or(0);
        Box::pin(async move { answer })
    });
    (asked, ask)
}

fn deps(moves: &[DirMove], ask: Ask, locale: &str) -> OldDirsDeps {
    OldDirsDeps {
        moves: moves.to_vec(),
        ask,
        locale: locale.to_owned(),
        log: None,
    }
}

#[tokio::test]
async fn asks_nothing_when_there_is_no_old_folder() {
    let (asked, ask) = answering(&[]);
    assert_eq!(
        offer_old_dirs_move(&deps(&[], ask, "en")).await,
        OldDirsOutcome::None
    );
    assert!(asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn moves_the_data_and_deletes_the_old_folder_only_after_the_human_confirms() {
    let f = fixture();
    let (asked, ask) = answering(&[0]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, ask, "en-US")).await,
        OldDirsOutcome::Moved
    );
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(
        asked[0].buttons,
        vec![
            "Move and delete old folders".to_owned(),
            "Not now".to_owned()
        ]
    );
    assert_eq!(asked[0].cancel_id, Some(1));
    assert_eq!(asked[0].kind, DialogKind::Question);
    assert!(
        asked[0]
            .detail
            .contains(&format!("{} → {}", f.from.display(), f.to.display()))
    );
    assert_eq!(
        fs::read_to_string(f.to.join("workspaces.json")).unwrap(),
        "{\"w\":1}"
    );
    assert!(!f.from.exists());
}

#[tokio::test]
async fn touches_nothing_when_the_human_picks_not_now_and_asks_again_next_time() {
    let f = fixture();
    let (_, ask) = answering(&[1]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, ask, "en")).await,
        OldDirsOutcome::Later
    );
    assert!(f.from.join("workspaces.json").exists());
    assert!(!f.to.exists());
    let (_, again) = answering(&[1]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, again, "en")).await,
        OldDirsOutcome::Later
    );
}

#[tokio::test]
async fn names_what_will_be_deleted_because_ostia_already_has_it() {
    let f = fixture();
    fs::create_dir(&f.to).unwrap();
    fs::write(f.to.join("workspaces.json"), "{\"w\":2}").unwrap();
    let (asked, ask) = answering(&[1]);
    offer_old_dirs_move(&deps(&f.moves, ask, "en")).await;
    assert!(
        asked.lock().unwrap()[0]
            .detail
            .contains(&format!("{}/workspaces.json", f.from.display()))
    );
}

#[tokio::test]
async fn does_not_move_anything_while_the_old_app_is_still_running() {
    let f = fixture();
    fs::write(f.from.join("SingletonLock"), "").unwrap();
    let (asked, ask) = answering(&[0]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, ask, "en")).await,
        OldDirsOutcome::Running
    );
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].buttons, vec!["OK".to_owned()]);
    assert_eq!(asked[0].kind, DialogKind::Info);
    assert!(f.from.join("workspaces.json").exists());
    assert!(!f.to.exists());
}

#[tokio::test]
async fn treats_any_answer_but_the_first_button_as_not_now() {
    let f = fixture();
    let (_, ask) = answering(&[5]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, ask, "en")).await,
        OldDirsOutcome::Later
    );
    assert!(f.from.exists());
}

#[tokio::test]
async fn tells_the_human_what_failed_and_keeps_what_was_not_moved() {
    let f = fixture();
    fs::write(f.to.parent().unwrap().join("blocker"), "file").unwrap();
    let blocked = DirMove {
        to: f.to.parent().unwrap().join("blocker").join("ostia"),
        ..f.moves[0].clone()
    };
    let (asked, ask) = answering(&[0, 0]);
    assert_eq!(
        offer_old_dirs_move(&deps(&[blocked], ask, "en")).await,
        OldDirsOutcome::Failed
    );
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 2);
    assert_eq!(asked[1].kind, DialogKind::Error);
    assert_eq!(asked[1].title, "Could not move your Pine data");
    assert_eq!(asked[1].buttons, vec!["OK".to_owned()]);
    assert!(f.from.join("workspaces.json").exists());
}

#[tokio::test]
async fn logs_each_folder_it_moved_with_the_counts() {
    let f = fixture();
    let lines: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&lines);
    let (_, ask) = answering(&[0]);
    let deps = OldDirsDeps {
        log: Some(Arc::new(move |line| {
            sink.lock().unwrap().push(line.to_owned())
        })),
        ..deps(&f.moves, ask, "en")
    };
    offer_old_dirs_move(&deps).await;
    assert_eq!(
        *lines.lock().unwrap(),
        vec![format!(
            "pine folder moved: {} (1 moved, 0 replaced)",
            f.from.display()
        )]
    );
}

#[test]
fn speaks_traditional_chinese_for_a_zh_hant_zh_tw_or_zh_hk_locale_and_english_otherwise() {
    assert_eq!(old_dirs_text("zh-TW").move_action, "移動並刪除舊資料夾");
    assert_eq!(old_dirs_text("zh-Hant").not_now, "稍後");
    assert_eq!(old_dirs_text("zh-HK").not_now, "稍後");
    assert_eq!(old_dirs_text("zh-MO").not_now, "稍後");
    assert_eq!(
        old_dirs_text("zh-CN").move_action,
        "Move and delete old folders"
    );
    assert_eq!(old_dirs_text("fr").title, "Move your Pine data");
}

#[test]
fn fills_the_old_and_new_product_names_into_every_line() {
    let text = old_dirs_text("en");
    assert_eq!(text.running_title, "Pine is still running");
    assert!(
        text.later
            .starts_with("Ostia starts without your Pine data")
    );
    assert!(!text.message.contains('{'));
    assert!(!old_dirs_text("zh-TW").running.contains('{'));
}

#[tokio::test]
async fn fails_with_an_error_dialog_and_never_asks_to_move_when_the_preview_cannot_be_read() {
    let f = fixture();
    fs::remove_dir_all(&f.from).unwrap();
    let (asked, ask) = answering(&[0]);
    assert_eq!(
        offer_old_dirs_move(&deps(&f.moves, ask, "en")).await,
        OldDirsOutcome::Failed
    );
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].kind, DialogKind::Error);
    assert!(!f.to.exists());
}
