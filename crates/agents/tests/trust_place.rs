#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use ostia_agents::trust_place::{
    CwdReport, PaneIdentity, TrustPlace, TrustPlaceDeps, trust_place_of,
};

struct Setup {
    work_dirs: HashMap<String, String>,
    reports: HashMap<String, CwdReport>,
    scratch: HashSet<String>,
    sandboxed: HashSet<String>,
    hostname: Option<String>,
}

impl Setup {
    fn ready() -> Self {
        Self {
            work_dirs: HashMap::from([("w1".to_owned(), "/home/u/api".to_owned())]),
            reports: HashMap::from([(
                "p1".to_owned(),
                CwdReport {
                    host: "box".to_owned(),
                    path: "/home/u/api/src".to_owned(),
                },
            )]),
            scratch: HashSet::new(),
            sandboxed: HashSet::new(),
            hostname: Some("box".to_owned()),
        }
    }

    fn deps(self) -> TrustPlaceDeps {
        let Self {
            work_dirs,
            reports,
            scratch,
            sandboxed,
            hostname,
        } = self;
        TrustPlaceDeps {
            home: PathBuf::from("/home/u"),
            hostname,
            work_dir_of: Box::new(move |workspace| work_dirs.get(workspace).cloned()),
            cwd_report: Box::new(move |pane| reports.get(pane).cloned()),
            is_scratch: Box::new(move |workspace| scratch.contains(workspace)),
            sandbox_enabled: Box::new(move |workspace| sandboxed.contains(workspace)),
        }
    }
}

fn identity(manager: bool) -> PaneIdentity {
    PaneIdentity {
        pane_id: "p1".to_owned(),
        workspace_id: "w1".to_owned(),
        manager,
    }
}

fn place(folder: &str, work_dir: &str) -> TrustPlace {
    TrustPlace {
        folder: PathBuf::from(folder),
        work_dir: PathBuf::from(work_dir),
        home: PathBuf::from("/home/u"),
    }
}

#[test]
fn gives_the_reported_folder_the_workspace_folder_and_home() {
    let deps = Setup::ready().deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), None),
        Some(place("/home/u/api/src", "/home/u/api"))
    );
}

#[test]
fn gives_no_place_to_a_manager_pane_before_any_other_check() {
    let mut deps = Setup::ready().deps();
    deps.sandbox_enabled = Box::new(|_| panic!("the sandbox was asked"));
    deps.is_scratch = Box::new(|_| panic!("scratch was asked"));
    deps.work_dir_of = Box::new(|_| panic!("the work dir was asked"));
    deps.cwd_report = Box::new(|_| panic!("the report was asked"));
    assert_eq!(trust_place_of(&deps, &identity(true), None), None);
}

#[test]
fn gives_no_place_in_a_sandboxed_workspace() {
    let mut setup = Setup::ready();
    setup.sandboxed.insert("w1".to_owned());
    let deps = setup.deps();
    assert_eq!(trust_place_of(&deps, &identity(false), None), None);
    assert_eq!(
        trust_place_of(&deps, &identity(false), Some("/home/u/scratch")),
        None
    );
}

#[test]
fn gives_no_place_in_a_scratch_workspace_with_no_scratch_folder() {
    let mut setup = Setup::ready();
    setup.scratch.insert("w1".to_owned());
    let deps = setup.deps();
    assert_eq!(trust_place_of(&deps, &identity(false), None), None);
    assert_eq!(trust_place_of(&deps, &identity(false), Some("")), None);
}

#[test]
fn uses_the_scratch_folder_as_the_workspace_folder() {
    let mut setup = Setup::ready();
    setup.scratch.insert("w1".to_owned());
    setup.work_dirs.clear();
    let deps = setup.deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), Some("/home/u/scratch/a")),
        Some(place("/home/u/api/src", "/home/u/scratch/a"))
    );
}

#[test]
fn prefers_the_scratch_folder_over_the_workspace_work_dir() {
    let deps = Setup::ready().deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), Some("/home/u/other")),
        Some(place("/home/u/api/src", "/home/u/other"))
    );
}

#[test]
fn ignores_an_empty_scratch_folder_in_a_normal_workspace() {
    let deps = Setup::ready().deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), Some("")),
        Some(place("/home/u/api/src", "/home/u/api"))
    );
}

#[test]
fn expands_the_home_marker_in_the_workspace_work_dir() {
    let mut setup = Setup::ready();
    setup.work_dirs.insert("w1".to_owned(), "~/api".to_owned());
    let deps = setup.deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), None),
        Some(place("/home/u/api/src", "/home/u/api"))
    );
}

#[test]
fn gives_no_place_when_the_work_dir_is_missing_empty_or_relative() {
    for work_dir in [None, Some(""), Some("api"), Some("./api")] {
        let mut setup = Setup::ready();
        setup.work_dirs.clear();
        if let Some(dir) = work_dir {
            setup.work_dirs.insert("w1".to_owned(), dir.to_owned());
        }
        let deps = setup.deps();
        assert_eq!(
            trust_place_of(&deps, &identity(false), None),
            None,
            "work dir {work_dir:?}"
        );
    }
}

#[test]
fn gives_no_place_when_the_pane_has_no_cwd_report() {
    let mut setup = Setup::ready();
    setup.reports.clear();
    let deps = setup.deps();
    assert_eq!(trust_place_of(&deps, &identity(false), None), None);
}

#[test]
fn reads_the_report_of_the_pane_in_the_identity() {
    let mut setup = Setup::ready();
    setup.reports.insert(
        "p2".to_owned(),
        CwdReport {
            host: "box".to_owned(),
            path: "/home/u/api/lib".to_owned(),
        },
    );
    let deps = setup.deps();
    let other = PaneIdentity {
        pane_id: "p2".to_owned(),
        workspace_id: "w1".to_owned(),
        manager: false,
    };
    assert_eq!(
        trust_place_of(&deps, &other, None),
        Some(place("/home/u/api/lib", "/home/u/api"))
    );
}

#[test]
fn gives_no_place_when_the_report_names_another_host() {
    let mut setup = Setup::ready();
    setup.reports.get_mut("p1").unwrap().host = "build-server".to_owned();
    let deps = setup.deps();
    assert_eq!(trust_place_of(&deps, &identity(false), None), None);
}

#[test]
fn accepts_the_local_host_name_in_any_case_the_short_name_and_loopback() {
    for (local, host) in [
        ("box.lan", "BOX.lan"),
        ("box.lan", "box"),
        ("box.lan", "Box"),
        ("box", "localhost"),
        ("box", ""),
        ("box", "LOCALHOST"),
    ] {
        let mut setup = Setup::ready();
        setup.hostname = Some(local.to_owned());
        setup.reports.get_mut("p1").unwrap().host = host.to_owned();
        let deps = setup.deps();
        assert_eq!(
            trust_place_of(&deps, &identity(false), None),
            Some(place("/home/u/api/src", "/home/u/api")),
            "local {local:?} report host {host:?}"
        );
    }
}

#[test]
fn accepts_any_host_when_the_local_name_is_unknown() {
    let mut setup = Setup::ready();
    setup.hostname = None;
    setup.reports.get_mut("p1").unwrap().host = "elsewhere".to_owned();
    let deps = setup.deps();
    assert_eq!(
        trust_place_of(&deps, &identity(false), None),
        Some(place("/home/u/api/src", "/home/u/api"))
    );
}

#[test]
fn keeps_the_reported_path_as_it_is() {
    let mut setup = Setup::ready();
    setup.reports.get_mut("p1").unwrap().path = "/elsewhere/not/under/work dir".to_owned();
    let deps = setup.deps();
    let found = trust_place_of(&deps, &identity(false), None).unwrap();
    assert_eq!(found.folder, Path::new("/elsewhere/not/under/work dir"));
}
