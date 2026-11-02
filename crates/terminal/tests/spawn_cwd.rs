#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use ostia_terminal::spawn_cwd::{SpawnFolder, sandbox_cwd, spawn_folder};
use tempfile::TempDir;

fn folder(cwd: &Path, missing: bool) -> SpawnFolder {
    SpawnFolder {
        cwd: cwd.to_path_buf(),
        missing,
    }
}

fn text(path: &Path) -> &str {
    path.to_str().unwrap()
}

mod spawn_folder_cases {
    use super::*;

    #[test]
    fn starts_in_the_folder_asked_for_when_it_exists() {
        let home = TempDir::new().unwrap();
        assert_eq!(
            spawn_folder(Some(text(home.path())), Path::new("/nowhere")),
            folder(home.path(), false)
        );
    }

    #[test]
    fn starts_in_home_without_a_note_when_no_folder_was_asked_for() {
        let home = TempDir::new().unwrap();
        assert_eq!(spawn_folder(None, home.path()), folder(home.path(), false));
    }

    #[test]
    fn expands_a_leading_tilde_against_home() {
        let home = TempDir::new().unwrap();
        assert_eq!(
            spawn_folder(Some("~"), home.path()),
            folder(home.path(), false)
        );
        fs::create_dir(home.path().join("sub")).unwrap();
        assert_eq!(
            spawn_folder(Some("~/sub"), home.path()),
            folder(&home.path().join("sub"), false)
        );
    }

    #[test]
    fn falls_back_to_home_and_says_so_when_the_folder_asked_for_is_gone() {
        let home = TempDir::new().unwrap();
        let gone = home.path().join("removed-worktree");
        assert_eq!(
            spawn_folder(Some(text(&gone)), home.path()),
            folder(home.path(), true)
        );
    }

    #[test]
    fn falls_back_to_home_and_says_so_when_the_path_asked_for_is_a_file() {
        let home = TempDir::new().unwrap();
        let file = home.path().join("a-file");
        fs::write(&file, "").unwrap();
        assert_eq!(
            spawn_folder(Some(text(&file)), home.path()),
            folder(home.path(), true)
        );
    }
}

mod sandbox_cwd_cases {
    use super::*;

    struct Tree {
        _guard: TempDir,
        root: PathBuf,
        w: PathBuf,
    }

    fn tree() -> Tree {
        let guard = TempDir::new().unwrap();
        let root = fs::canonicalize(guard.path()).unwrap();
        let w = root.join("w");
        fs::create_dir_all(w.join("tree")).unwrap();
        fs::create_dir(root.join("wide")).unwrap();
        fs::create_dir(root.join("wx")).unwrap();
        symlink("/etc", w.join("etc-link")).unwrap();
        symlink("/", w.join("root-link")).unwrap();
        symlink(w.join("tree"), w.join("tree-link")).unwrap();
        Tree {
            _guard: guard,
            root,
            w,
        }
    }

    fn clamp(cwd: &str, w: &Path) -> PathBuf {
        sandbox_cwd(Path::new(cwd), Some(w))
    }

    #[test]
    fn keeps_a_folder_inside_the_workspace_and_clamps_one_outside_to_the_workspace_folder() {
        let t = tree();
        assert_eq!(clamp(text(&t.w.join("tree")), &t.w), t.w.join("tree"));
        assert_eq!(clamp(text(&t.w), &t.w), t.w);
        assert_eq!(clamp(text(&t.root.join("wide")), &t.w), t.w);
        assert_eq!(clamp(text(&t.root.join("wx")), &t.w), t.w);
    }

    #[test]
    fn clamps_a_folder_that_leaves_the_workspace_through_dot_dot_to_the_workspace_folder() {
        let t = tree();
        let w = text(&t.w);
        assert_eq!(clamp(&format!("{w}/../wide"), &t.w), t.w);
        assert_eq!(clamp(&format!("{w}/tree/../../wide"), &t.w), t.w);
    }

    #[test]
    fn starts_in_the_resolved_folder_which_the_kernel_would_reach() {
        let t = tree();
        let w = text(&t.w);
        assert_eq!(clamp(&format!("{w}/tree/.."), &t.w), t.w);
        assert_eq!(clamp(text(&t.w.join("tree-link")), &t.w), t.w.join("tree"));
    }

    #[test]
    fn clamps_a_symbolic_link_that_points_out_of_the_workspace() {
        let t = tree();
        let w = text(&t.w);
        assert_eq!(clamp(text(&t.w.join("etc-link")), &t.w), t.w);
        assert_eq!(clamp(text(&t.w.join("root-link")), &t.w), t.w);
        assert_eq!(clamp(&format!("{w}/etc-link/.."), &t.w), t.w);
    }

    #[test]
    fn clamps_a_folder_that_does_not_exist_to_the_workspace_folder() {
        let t = tree();
        assert_eq!(clamp(text(&t.w.join("gone")), &t.w), t.w);
    }

    #[test]
    fn returns_the_folder_unchanged_when_the_workspace_has_no_folder() {
        let t = tree();
        let outside = t.root.join("wide");
        assert_eq!(sandbox_cwd(&outside, None), outside);
        assert_eq!(sandbox_cwd(&outside, Some(Path::new(""))), outside);
    }

    #[test]
    fn returns_the_workspace_folder_when_it_cannot_be_resolved() {
        let t = tree();
        let gone = t.root.join("gone-workspace");
        assert_eq!(sandbox_cwd(&t.w, Some(&gone)), gone);
    }
}
