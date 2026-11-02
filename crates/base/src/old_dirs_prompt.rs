use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock};

use regex::Regex;

use crate::js::static_regex;
use crate::user_dirs::{
    DirMove, MoveHooks, MoveResult, OLD_PRODUCT_NAME, move_old_dir, old_app_running,
    preview_old_dir,
};

const OLD_DISPLAY_NAME: &str = "Pine";
const NEW_DISPLAY_NAME: &str = "Ostia";

static TRADITIONAL_CHINESE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i-u)^zh-(Hant|TW|HK|MO)"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OldDirsOutcome {
    None,
    Moved,
    Later,
    Running,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DialogKind {
    Info,
    Question,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskOptions {
    pub kind: DialogKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: Option<usize>,
    pub cancel_id: Option<usize>,
    pub no_link: bool,
}

pub type Ask = Arc<dyn Fn(AskOptions) -> Pin<Box<dyn Future<Output = usize> + Send>> + Send + Sync>;

pub type Log = Arc<dyn Fn(&str) + Send + Sync>;

pub struct OldDirsDeps {
    pub moves: Vec<DirMove>,
    pub ask: Ask,
    pub locale: String,
    pub log: Option<Log>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OldDirsText {
    pub title: String,
    pub message: String,
    pub folders: String,
    pub replaced: String,
    pub later: String,
    pub move_action: String,
    pub not_now: String,
    pub running_title: String,
    pub running: String,
    pub ok: String,
    pub failed_title: String,
    pub failed: String,
}

const ENGLISH: [&str; 12] = [
    "Move your {old} data",
    "{old} folders were found. Move their contents to {new} and delete the old folders?",
    "Folders:",
    "{new} already has these, so the {old} copies are deleted instead of moved:",
    "{new} starts without your {old} data and asks again next time.",
    "Move and delete old folders",
    "Not now",
    "{old} is still running",
    "Quit {old}, then start {new} again to move your {old} data.",
    "OK",
    "Could not move your {old} data",
    "Some files were not moved. What is left stays in the old folder: {error}",
];

const TRADITIONAL: [&str; 12] = [
    "移動你的 {old} 資料",
    "找到 {old} 的資料夾。要把內容移到 {new} 並刪除舊資料夾嗎？",
    "資料夾：",
    "{new} 已經有以下項目，所以 {old} 的副本會被刪除而不是移動：",
    "{new} 會在沒有 {old} 資料的情況下啟動，下次啟動時再詢問。",
    "移動並刪除舊資料夾",
    "稍後",
    "{old} 仍在執行",
    "請先結束 {old}，再重新啟動 {new} 以移動你的 {old} 資料。",
    "確定",
    "無法移動你的 {old} 資料",
    "有些檔案沒有移動，剩下的仍在舊資料夾中：{error}",
];

pub fn old_dirs_text(locale: &str) -> OldDirsText {
    let table = if TRADITIONAL_CHINESE.is_match(locale) {
        &TRADITIONAL
    } else {
        &ENGLISH
    };
    let fill = |index: usize| {
        table[index]
            .replace("{old}", OLD_DISPLAY_NAME)
            .replace("{new}", NEW_DISPLAY_NAME)
    };
    OldDirsText {
        title: fill(0),
        message: fill(1),
        folders: fill(2),
        replaced: fill(3),
        later: fill(4),
        move_action: fill(5),
        not_now: fill(6),
        running_title: fill(7),
        running: fill(8),
        ok: fill(9),
        failed_title: fill(10),
        failed: fill(11),
    }
}

fn detail(text: &OldDirsText, moves: &[DirMove], previews: &[MoveResult]) -> String {
    let mut lines = vec![text.folders.clone()];
    lines.extend(
        moves
            .iter()
            .map(|dir_move| format!("  {} → {}", dir_move.from.display(), dir_move.to.display())),
    );
    let replaced: Vec<String> = previews
        .iter()
        .zip(moves)
        .flat_map(|(preview, dir_move)| {
            preview
                .replaced
                .iter()
                .map(move |entry| format!("  {}/{entry}", dir_move.from.display()))
        })
        .collect();
    if !replaced.is_empty() {
        lines.push(String::new());
        lines.push(text.replaced.clone());
        lines.extend(replaced);
    }
    lines.push(String::new());
    lines.push(text.later.clone());
    lines.join("\n")
}

pub async fn offer_old_dirs_move(deps: &OldDirsDeps) -> OldDirsOutcome {
    if deps.moves.is_empty() {
        return OldDirsOutcome::None;
    }
    let text = old_dirs_text(&deps.locale);
    if old_app_running(&deps.moves) {
        (deps.ask)(AskOptions {
            kind: DialogKind::Info,
            title: text.running_title.clone(),
            message: text.running_title.clone(),
            detail: text.running.clone(),
            buttons: vec![text.ok.clone()],
            default_id: None,
            cancel_id: None,
            no_link: false,
        })
        .await;
        return OldDirsOutcome::Running;
    }
    let previews: Vec<MoveResult> = deps.moves.iter().map(preview_old_dir).collect();
    let answer = (deps.ask)(AskOptions {
        kind: DialogKind::Question,
        title: text.title.clone(),
        message: text.message.clone(),
        detail: detail(&text, &deps.moves, &previews),
        buttons: vec![text.move_action.clone(), text.not_now.clone()],
        default_id: Some(0),
        cancel_id: Some(1),
        no_link: true,
    })
    .await;
    if answer != 0 {
        return OldDirsOutcome::Later;
    }
    for dir_move in &deps.moves {
        match move_old_dir(dir_move, MoveHooks::default()) {
            Ok(result) => {
                if let Some(log) = &deps.log {
                    log(&format!(
                        "{OLD_PRODUCT_NAME} folder moved: {} ({} moved, {} replaced)",
                        dir_move.from.display(),
                        result.moved.len(),
                        result.replaced.len()
                    ));
                }
            }
            Err(err) => {
                (deps.ask)(AskOptions {
                    kind: DialogKind::Error,
                    title: text.failed_title.clone(),
                    message: text.failed_title.clone(),
                    detail: text.failed.replacen("{error}", &err.to_string(), 1),
                    buttons: vec![text.ok.clone()],
                    default_id: None,
                    cancel_id: None,
                    no_link: false,
                })
                .await;
                return OldDirsOutcome::Failed;
            }
        }
    }
    OldDirsOutcome::Moved
}
