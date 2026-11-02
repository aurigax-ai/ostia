#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use ostia_panes::worktree_share::{SharePane, WorktreeShare, WorktreeShareDeps};
use parking_lot::Mutex;
use tokio::runtime::Handle;

#[derive(Default)]
struct World {
    entries: BTreeMap<String, SharePane>,
    remote: BTreeSet<String>,
}

struct Deps {
    world: Arc<Mutex<World>>,
    key_calls: Arc<AtomicUsize>,
    failing: Arc<AtomicBool>,
}

#[derive(Debug)]
struct Down;

impl WorktreeShareDeps for Deps {
    type Error = Down;

    async fn panes(&self) -> Result<Vec<SharePane>, Down> {
        if self.failing.load(Ordering::SeqCst) && self.world.lock().entries.is_empty() {
            return Err(Down);
        }
        Ok(self.world.lock().entries.values().cloned().collect())
    }

    async fn key(&self, cwd: &str) -> Result<Option<String>, Down> {
        self.key_calls.fetch_add(1, Ordering::SeqCst);
        if self.failing.load(Ordering::SeqCst) {
            return Err(Down);
        }
        Ok(if cwd.starts_with("/repo") {
            Some("/repo\0/repo/.git".to_owned())
        } else if cwd.starts_with("/wt") {
            Some("/wt\0/repo/.git/worktrees/wt".to_owned())
        } else {
            None
        })
    }

    fn identity(&self, external_id: &str) -> Option<String> {
        external_id
            .starts_with("x-")
            .then(|| format!("p-{external_id}"))
    }

    fn remote(&self, pane_id: &str) -> bool {
        self.world.lock().remote.contains(pane_id)
    }
}

struct Fixture {
    world: Arc<Mutex<World>>,
    key_calls: Arc<AtomicUsize>,
    failing: Arc<AtomicBool>,
    share: WorktreeShare<Deps>,
}

fn fixture() -> Fixture {
    let world = Arc::new(Mutex::new(World::default()));
    let key_calls = Arc::new(AtomicUsize::new(0));
    let failing = Arc::new(AtomicBool::new(false));
    let share = WorktreeShare::new(
        Deps {
            world: world.clone(),
            key_calls: key_calls.clone(),
            failing: failing.clone(),
        },
        Handle::current(),
    );
    Fixture {
        world,
        key_calls,
        failing,
        share,
    }
}

fn pane(id: &str) -> SharePane {
    SharePane {
        pane_id: id.to_owned(),
        agent: None,
        cwd: None,
        hibernated: false,
        agent_session_id: None,
    }
}

fn agent(id: &str, cwd: &str) -> SharePane {
    SharePane {
        agent: Some("claude".to_owned()),
        cwd: Some(cwd.to_owned()),
        ..pane(id)
    }
}

impl Fixture {
    fn set(&self, pane: SharePane) {
        self.world.lock().entries.insert(pane.pane_id.clone(), pane);
    }

    fn calls(&self) -> usize {
        self.key_calls.load(Ordering::SeqCst)
    }
}

fn names(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[tokio::test]
async fn pairs_two_running_agents_in_the_same_worktree() {
    let f = fixture();
    f.set(agent("x-a", "/repo/src"));
    f.set(agent("x-b", "/repo"));
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), names(&["x-b"]));
    assert_eq!(f.share.others("x-b"), names(&["x-a"]));
}

#[tokio::test]
async fn does_not_pair_agents_in_different_worktrees_of_one_repository_or_one_agent_alone() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(agent("x-b", "/wt"));
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), Vec::<String>::new());
}

#[tokio::test]
async fn leaves_out_shells_hibernated_agents_panes_without_a_folder_or_a_git_repository_and_remote_panes()
 {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(SharePane {
        cwd: Some("/repo".to_owned()),
        ..pane("x-shell")
    });
    f.set(SharePane {
        hibernated: true,
        ..agent("x-asleep", "/repo")
    });
    f.set(SharePane {
        agent: Some("codex".to_owned()),
        ..pane("x-nofolder")
    });
    f.set(agent("x-nogit", "/elsewhere"));
    f.set(agent("x-remote", "/repo"));
    f.world.lock().remote.insert("p-x-remote".to_owned());
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), Vec::<String>::new());
}

#[tokio::test]
async fn reads_a_panes_git_state_once_and_again_only_when_its_folder_or_session_changed() {
    let f = fixture();
    f.set(SharePane {
        agent_session_id: Some("s1".to_owned()),
        ..agent("x-a", "/repo")
    });
    f.set(agent("x-b", "/repo"));
    f.share.check().await.unwrap();
    f.share.check().await.unwrap();
    assert_eq!(f.calls(), 2);
    f.set(SharePane {
        agent_session_id: Some("s1".to_owned()),
        ..agent("x-a", "/wt")
    });
    f.share.check().await.unwrap();
    assert_eq!(f.calls(), 3);
    assert_eq!(f.share.others("x-a"), Vec::<String>::new());
    f.set(SharePane {
        agent_session_id: Some("s2".to_owned()),
        ..agent("x-a", "/wt")
    });
    f.share.check().await.unwrap();
    assert_eq!(f.calls(), 4);
}

#[tokio::test]
async fn clears_the_pairing_when_an_agent_leaves() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(agent("x-b", "/repo"));
    f.share.check().await.unwrap();
    f.world.lock().entries.remove("x-b");
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), Vec::<String>::new());
}

#[tokio::test]
async fn pairs_three_agents_with_each_of_the_others() {
    let f = fixture();
    for id in ["x-a", "x-b", "x-c"] {
        f.set(agent(id, "/repo"));
    }
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), names(&["x-b", "x-c"]));
}

#[tokio::test(start_paused = true)]
async fn waits_out_a_burst_of_changes_and_checks_once() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(agent("x-b", "/repo"));
    f.share.schedule();
    f.share.schedule();
    f.share.schedule();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(f.share.others("x-a"), names(&["x-b"]));
    assert_eq!(f.calls(), 2);
}

#[tokio::test]
async fn skips_panes_whose_agent_or_folder_is_an_empty_string() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(SharePane {
        agent: Some(String::new()),
        ..agent("x-b", "/repo")
    });
    f.set(SharePane {
        cwd: Some(String::new()),
        ..agent("x-c", "/repo")
    });
    f.share.check().await.unwrap();
    assert_eq!(f.share.others("x-a"), Vec::<String>::new());
    assert_eq!(f.calls(), 1);
}

#[tokio::test]
async fn keeps_the_old_pairing_and_caches_no_key_when_the_key_lookup_fails() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(agent("x-b", "/repo"));
    f.share.check().await.unwrap();
    f.set(agent("x-c", "/repo"));
    f.failing.store(true, Ordering::SeqCst);
    assert!(f.share.check().await.is_err());
    assert_eq!(f.share.others("x-a"), names(&["x-b"]));
    assert_eq!(f.share.others("x-c"), Vec::<String>::new());
    f.failing.store(false, Ordering::SeqCst);
    let before = f.calls();
    f.share.check().await.unwrap();
    assert_eq!(f.calls(), before + 1);
    assert_eq!(f.share.others("x-a"), names(&["x-b", "x-c"]));
}

#[tokio::test]
async fn keeps_the_old_pairing_when_the_pane_list_fails() {
    let f = fixture();
    f.set(agent("x-a", "/repo"));
    f.set(agent("x-b", "/repo"));
    f.share.check().await.unwrap();
    f.world.lock().entries.clear();
    f.failing.store(true, Ordering::SeqCst);
    assert!(f.share.check().await.is_err());
    assert_eq!(f.share.others("x-a"), names(&["x-b"]));
}

#[test]
fn schedules_from_outside_a_runtime_when_given_a_handle() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_time()
        .build()
        .unwrap();
    let world = Arc::new(Mutex::new(World::default()));
    let share = WorktreeShare::new(
        Deps {
            world: world.clone(),
            key_calls: Arc::new(AtomicUsize::new(0)),
            failing: Arc::new(AtomicBool::new(false)),
        },
        runtime.handle().clone(),
    );
    share.schedule();
}
