#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod history_support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use history_support::put;
use ostia_terminal::history_feed::SpillClient;
use ostia_terminal::pane_histories::{PaneHistories, PaneHistoriesDeps};
use ostia_terminal::scrollback_history::ScrollbackHistory;
use parking_lot::Mutex;

#[tokio::test]
async fn reports_the_error_code_of_a_run_folder_it_cannot_create_instead_of_disk_full() {
    let root = tempfile::tempdir().unwrap();
    let failures: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let recorded = failures.clone();
    let store = PaneHistories::new(PaneHistoriesDeps {
        root: root.path().to_path_buf(),
        setting: Arc::new(|| ScrollbackHistory::Unlimited),
        start_spill: Arc::new(|| SpillClient::spawn().unwrap()),
        free_bytes: Some(Arc::new(|_| u64::MAX)),
        on_failed: Some(Arc::new(move |pane, reason| {
            recorded.lock().push((pane.to_string(), reason.to_string()));
        })),
        segment_bytes: None,
    });
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    let history = store.for_pane("p1").unwrap();
    put(&history, &["a".to_string()]);
    history.flush().await;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!history.live());
    assert_eq!(
        *failures.lock(),
        vec![("p1".to_string(), "EACCES".to_string())]
    );
}
