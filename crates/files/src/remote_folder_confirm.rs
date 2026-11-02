use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::remote_folders::RemoteFolderConfirm;

pub trait ConfirmWindow {
    fn is_destroyed(&self) -> bool;
    fn is_minimized(&self) -> bool;
    fn restore(&self);
    fn focus(&self);
    fn ask(&self, ask: RemoteFolderConfirm) -> BoxFuture<'static, Value>;
}

pub async fn confirm_remote_folder<W: ConfirmWindow>(
    win: Option<&W>,
    ask: RemoteFolderConfirm,
) -> bool {
    let Some(win) = win else {
        return false;
    };
    if win.is_destroyed() {
        return false;
    }
    if win.is_minimized() {
        win.restore();
    }
    win.focus();
    win.ask(ask).await == Value::Bool(true)
}
