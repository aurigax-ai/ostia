#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use ostia_terminal::generated_folder::{
    GENERATED_LIST, has_files, install_generated, remove_generated, remove_untouched_generations,
    touch_generated,
};
use serde_json::Value;
use tempfile::{TempDir, tempdir};

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

const PLUGIN: [(&str, &str); 2] = [
    ("claude-plugin/hooks/hooks.json", "{}"),
    ("codex/session-context.md", "context"),
];

struct Fixture {
    _guard: TempDir,
    base: PathBuf,
    root: PathBuf,
    now: SystemTime,
}

impl Fixture {
    fn new() -> Self {
        let guard = tempdir().unwrap();
        let base = fs::canonicalize(guard.path()).unwrap();
        let root = base.join("run").join("agents");
        Self {
            _guard: guard,
            base,
            root,
            now: SystemTime::now(),
        }
    }

    fn cutoff(&self) -> SystemTime {
        self.now - 30 * DAY
    }

    fn age(&self, dir: &Path, days: u32) {
        set_mtime(dir, self.now - days * DAY);
    }

    fn install(&self, digest: &str, files: &[(&str, &str)]) -> PathBuf {
        let names: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
        install_generated(&self.root, &self.root.join(digest), &names, write(files)).unwrap()
    }
}

fn set_mtime(path: &Path, when: SystemTime) {
    fs::File::open(path).unwrap().set_modified(when).unwrap();
}

fn mtime(path: &Path) -> SystemTime {
    fs::symlink_metadata(path).unwrap().modified().unwrap()
}

fn write_into(dir: &Path, files: &[(&str, &str)]) -> io::Result<()> {
    for (name, text) in files {
        let file = dir.join(name);
        fs::create_dir_all(file.parent().unwrap())?;
        fs::write(file, text)?;
    }
    Ok(())
}

fn write(files: &[(&str, &str)]) -> impl FnOnce(&Path) -> io::Result<()> {
    let files: Vec<(String, String)> = files
        .iter()
        .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
        .collect();
    move |staging| {
        let borrowed: Vec<(&str, &str)> = files
            .iter()
            .map(|(name, text)| (name.as_str(), text.as_str()))
            .collect();
        write_into(staging, &borrowed)
    }
}

fn listed(dir: &Path) -> Vec<String> {
    let value: Value =
        serde_json::from_str(&fs::read_to_string(dir.join(GENERATED_LIST)).unwrap()).unwrap();
    let mut names: Vec<String> = value
        .as_array()
        .unwrap()
        .iter()
        .map(|name| name.as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

fn plugin_names() -> Vec<String> {
    let mut names: Vec<String> = PLUGIN.iter().map(|(name, _)| (*name).to_owned()).collect();
    names.sort();
    names
}

fn keep(dirs: &[&Path]) -> HashSet<PathBuf> {
    dirs.iter().map(|dir| dir.to_path_buf()).collect()
}

#[test]
fn lists_the_files_it_wrote_inside_the_generation() {
    let fx = Fixture::new();
    let dir = fx.install(&"a".repeat(32), &PLUGIN);
    assert_eq!(listed(&dir), plugin_names());
}

#[test]
fn adds_the_list_to_a_complete_generation_written_before_lists_existed() {
    let fx = Fixture::new();
    let dir = fx.root.join("b".repeat(32));
    write_into(&dir, &PLUGIN).unwrap();
    assert_eq!(fx.install(&"b".repeat(32), &PLUGIN), dir);
    assert_eq!(listed(&dir), plugin_names());
}

#[test]
fn removes_a_generation_untouched_past_the_limit_and_keeps_the_current_and_recent_ones() {
    let fx = Fixture::new();
    let old = fx.install(&"1".repeat(32), &PLUGIN);
    let current = fx.install(&"2".repeat(32), &PLUGIN);
    let recent = fx.install(&"3".repeat(32), &PLUGIN);
    fx.age(&old, 31);
    fx.age(&current, 90);
    fx.age(&recent, 29);
    let removed = remove_untouched_generations(&fx.root, &keep(&[&current]), fx.cutoff());
    assert_eq!(removed, vec![old.clone()]);
    assert!(!old.exists());
    assert!(current.join("codex/session-context.md").exists());
    assert!(recent.join("codex/session-context.md").exists());
}

#[test]
fn keeps_a_generation_that_was_touched_again_within_the_limit() {
    let fx = Fixture::new();
    let dir = fx.install(&"4".repeat(32), &PLUGIN);
    fx.age(&dir, 45);
    touch_generated(&dir, fx.now - DAY);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.join("claude-plugin/hooks/hooks.json").exists());
}

#[test]
fn leaves_files_ostia_did_not_write_and_the_folders_that_hold_them() {
    let fx = Fixture::new();
    let dir = fx.install(&"5".repeat(32), &PLUGIN);
    fs::write(dir.join("claude-plugin/hooks/mine.sh"), "user file").unwrap();
    fs::write(dir.join("notes.txt"), "user file").unwrap();
    fx.age(&dir, 40);
    remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff());
    assert_eq!(
        fs::read_to_string(dir.join("claude-plugin/hooks/mine.sh")).unwrap(),
        "user file"
    );
    assert_eq!(
        fs::read_to_string(dir.join("notes.txt")).unwrap(),
        "user file"
    );
    assert!(!dir.join("claude-plugin/hooks/hooks.json").exists());
    assert!(!dir.join("codex").exists());
    assert!(!dir.join(GENERATED_LIST).exists());
}

#[test]
fn leaves_a_generation_that_has_no_list_of_its_files() {
    let fx = Fixture::new();
    let dir = fx.root.join("6".repeat(32));
    write_into(&dir, &PLUGIN).unwrap();
    fx.age(&dir, 40);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.join("codex/session-context.md").exists());
}

#[test]
fn does_not_follow_a_folder_inside_the_generation_that_became_a_symlink() {
    let fx = Fixture::new();
    let outside = fx.base.join("outside");
    fs::create_dir_all(outside.join("hooks")).unwrap();
    fs::write(outside.join("hooks/hooks.json"), "outside").unwrap();
    let dir = fx.install(&"7".repeat(32), &PLUGIN);
    fs::remove_dir_all(dir.join("claude-plugin")).unwrap();
    symlink(&outside, dir.join("claude-plugin")).unwrap();
    fx.age(&dir, 40);
    remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff());
    assert_eq!(
        fs::read_to_string(outside.join("hooks/hooks.json")).unwrap(),
        "outside"
    );
}

#[test]
fn does_not_follow_listed_names_that_climb_out_of_the_generation() {
    let fx = Fixture::new();
    let victim = fx.root.join("victim.txt");
    let dir = fx.install(&"8".repeat(32), &PLUGIN);
    fs::write(&victim, "outside").unwrap();
    let escape = fx.base.join("escape.txt");
    fs::write(&escape, "outside").unwrap();
    let mut names = vec![
        "../victim.txt".to_owned(),
        escape.to_string_lossy().into_owned(),
    ];
    names.extend(PLUGIN.iter().map(|(name, _)| (*name).to_owned()));
    fs::write(
        dir.join(GENERATED_LIST),
        serde_json::to_string(&names).unwrap(),
    )
    .unwrap();
    fx.age(&dir, 40);
    remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "outside");
    assert_eq!(fs::read_to_string(&escape).unwrap(), "outside");
    assert!(!dir.exists());
}

#[test]
fn does_not_follow_a_generation_that_is_a_symlink_to_a_folder_elsewhere() {
    let fx = Fixture::new();
    let outside = fx.base.join("elsewhere");
    write_into(&outside, &PLUGIN).unwrap();
    let names: Vec<&str> = PLUGIN.iter().map(|(name, _)| *name).collect();
    fs::write(
        outside.join(GENERATED_LIST),
        serde_json::to_string(&names).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(&fx.root).unwrap();
    symlink(&outside, fx.root.join("9".repeat(32))).unwrap();
    fx.age(&outside, 40);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(outside.join("codex/session-context.md").exists());
    assert!(outside.join(GENERATED_LIST).exists());
}

#[test]
fn does_nothing_when_the_generations_folder_itself_is_a_symlink() {
    let fx = Fixture::new();
    let real = fx.base.join("real-root");
    fs::create_dir(&real).unwrap();
    let names: Vec<&str> = PLUGIN.iter().map(|(name, _)| *name).collect();
    let dir = install_generated(&real, &real.join("c".repeat(32)), &names, write(&PLUGIN)).unwrap();
    fx.age(&dir, 40);
    fs::create_dir_all(fx.root.parent().unwrap()).unwrap();
    symlink(&real, &fx.root).unwrap();
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.join("codex/session-context.md").exists());
}

#[test]
fn skips_staging_folders_and_plain_files_beside_the_generations() {
    let fx = Fixture::new();
    fx.install(&"d".repeat(32), &PLUGIN);
    let staging = fx.root.join(".staging-left");
    fs::create_dir(&staging).unwrap();
    fs::write(staging.join(GENERATED_LIST), "[]").unwrap();
    fs::write(fx.root.join("stray"), "x").unwrap();
    fx.age(&staging, 40);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(staging.exists());
    assert!(fx.root.join("stray").is_file());
}

#[test]
fn keeps_a_generation_modified_exactly_at_the_cutoff() {
    let fx = Fixture::new();
    let dir = fx.install(&"e".repeat(32), &PLUGIN);
    set_mtime(&dir, fx.cutoff());
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.join("codex/session-context.md").exists());
}

#[test]
fn leaves_a_generation_whose_list_is_not_a_json_array_of_strings() {
    let fx = Fixture::new();
    for (index, bad) in ["not json", "{}", "[1, 2]", "[\"a\", null]", ""]
        .iter()
        .enumerate()
    {
        let dir = fx.install(&format!("{index:x}").repeat(32), &PLUGIN);
        fs::write(dir.join(GENERATED_LIST), bad).unwrap();
        fx.age(&dir, 40);
    }
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new(),
        "every bad list keeps its generation"
    );
}

#[test]
fn leaves_a_generation_whose_list_is_larger_than_one_mebibyte() {
    let fx = Fixture::new();
    let dir = fx.install(&"f".repeat(32), &PLUGIN);
    let padding = " ".repeat(1024 * 1024 + 1);
    fs::write(dir.join(GENERATED_LIST), format!("[]{padding}")).unwrap();
    fx.age(&dir, 40);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.exists());
}

#[test]
fn skips_generations_whose_name_starts_with_a_dot() {
    let fx = Fixture::new();
    let dir = fx.install(&".hidden".repeat(4), &PLUGIN);
    fx.age(&dir, 40);
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
    assert!(dir.exists());
}

#[test]
fn returns_nothing_when_the_generations_folder_does_not_exist() {
    let fx = Fixture::new();
    assert_eq!(
        remove_untouched_generations(&fx.root, &HashSet::new(), fx.cutoff()),
        Vec::<PathBuf>::new()
    );
}

#[test]
fn does_not_write_again_when_the_generation_is_complete() {
    let fx = Fixture::new();
    let dir = fx.root.join("a1".repeat(16));
    write_into(&dir, &PLUGIN).unwrap();
    let names: Vec<&str> = PLUGIN.iter().map(|(name, _)| *name).collect();
    let called = AtomicBool::new(false);
    let result = install_generated(&fx.root, &dir, &names, |_| {
        called.store(true, Ordering::SeqCst);
        Ok(())
    })
    .unwrap();
    assert_eq!(result, dir);
    assert!(!called.load(Ordering::SeqCst));
}

#[test]
fn keeps_the_list_of_a_complete_generation_that_already_has_one() {
    let fx = Fixture::new();
    let dir = fx.root.join("b2".repeat(16));
    write_into(&dir, &PLUGIN).unwrap();
    fs::write(dir.join(GENERATED_LIST), "[\"only-this\"]").unwrap();
    fx.install(&"b2".repeat(16), &PLUGIN);
    assert_eq!(
        fs::read_to_string(dir.join(GENERATED_LIST)).unwrap(),
        "[\"only-this\"]"
    );
}

#[test]
fn lists_extra_files_the_writer_made_and_never_lists_the_list_itself() {
    let fx = Fixture::new();
    let dir = install_generated(
        &fx.root,
        &fx.root.join("c3".repeat(16)),
        &["a.txt", GENERATED_LIST, "a.txt"],
        write(&[("a.txt", "a"), ("extra/b.txt", "b")]),
    )
    .unwrap();
    assert_eq!(listed(&dir), vec!["a.txt", "extra/b.txt"]);
}

#[test]
fn creates_the_generations_folder_with_owner_only_access_and_the_list_the_same_way() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let dir = fx.install(&"d4".repeat(16), &PLUGIN);
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&fx.root), 0o700);
    assert_eq!(mode(&dir.join("claude-plugin")), 0o700);
    assert_eq!(mode(&dir.join(GENERATED_LIST)), 0o600);
}

#[test]
fn reports_a_failing_write_when_the_files_are_missing_and_leaves_no_staging_folder() {
    let fx = Fixture::new();
    let result = install_generated(
        &fx.root,
        &fx.root.join("e5".repeat(16)),
        &["a.txt"],
        |staging| {
            fs::write(staging.join("partial.txt"), "x")?;
            Err(io::Error::other("disk full"))
        },
    );
    assert!(result.is_err());
    let left: Vec<_> = fs::read_dir(&fx.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "left {left:?}");
}

#[test]
fn accepts_a_failing_write_when_the_generation_is_complete_by_the_end() {
    let fx = Fixture::new();
    let dir = fx.root.join("f6".repeat(16));
    let target = dir.clone();
    let result = install_generated(&fx.root, &dir, &["a.txt"], move |_| {
        write_into(&target, &[("a.txt", "a")])?;
        Err(io::Error::other("raced"))
    })
    .unwrap();
    assert_eq!(result, dir);
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "a");
}

#[test]
fn has_files_is_true_only_when_every_name_exists() {
    let fx = Fixture::new();
    let dir = fx.base.join("g");
    write_into(&dir, &[("a.txt", "a"), ("sub/b.txt", "b")]).unwrap();
    assert!(has_files(&dir, &["a.txt", "sub/b.txt"]));
    assert!(!has_files(&dir, &["a.txt", "missing.txt"]));
    assert!(has_files(&dir, &[]));
}

#[test]
fn remove_generated_does_nothing_when_the_folder_is_a_symlink() {
    let fx = Fixture::new();
    let real = fx.base.join("real");
    write_into(&real, &[("a.txt", "a")]).unwrap();
    let link = fx.base.join("link");
    symlink(&real, &link).unwrap();
    remove_generated(&link, &["a.txt"]);
    assert!(real.join("a.txt").exists());
}

#[test]
fn remove_generated_ignores_names_with_empty_dot_or_dotdot_parts_and_absolute_names() {
    let fx = Fixture::new();
    let dir = fx.base.join("h");
    write_into(&dir, &[("a/b.txt", "b")]).unwrap();
    fs::write(fx.base.join("outside.txt"), "outside").unwrap();
    let absolute = fx.base.join("outside.txt").to_string_lossy().into_owned();
    remove_generated(
        &dir,
        &["a//b.txt", "./a/b.txt", "a/../a/b.txt", "", "..", &absolute],
    );
    assert!(dir.join("a/b.txt").exists());
    assert!(fx.base.join("outside.txt").exists());
}

#[test]
fn remove_generated_removes_listed_files_and_the_folders_they_leave_empty() {
    let fx = Fixture::new();
    let dir = fx.base.join("i");
    write_into(&dir, &[("a/b/c.txt", "c"), ("keep/d.txt", "d")]).unwrap();
    fs::write(dir.join("keep/mine.txt"), "mine").unwrap();
    remove_generated(&dir, &["a/b/c.txt", "keep/d.txt"]);
    assert!(!dir.join("a").exists());
    assert!(dir.join("keep/mine.txt").exists());
    assert!(!dir.join("keep/d.txt").exists());
}

#[test]
fn remove_generated_does_not_remove_a_listed_name_that_is_a_symlink_to_a_folder() {
    let fx = Fixture::new();
    let dir = fx.base.join("j");
    fs::create_dir_all(&dir).unwrap();
    let outside = fx.base.join("target");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, dir.join("folder")).unwrap();
    remove_generated(&dir, &["folder"]);
    assert!(outside.exists());
    assert!(fs::symlink_metadata(dir.join("folder")).is_ok());
}

#[test]
fn touch_generated_sets_the_modified_time() {
    let fx = Fixture::new();
    let dir = fx.install(&"k".repeat(32), &PLUGIN);
    let when = fx.now - 7 * DAY;
    touch_generated(&dir, when);
    assert_eq!(mtime(&dir), when);
}

#[test]
fn touch_generated_ignores_a_missing_folder_and_does_not_touch_through_a_symlink() {
    let fx = Fixture::new();
    touch_generated(&fx.base.join("missing"), fx.now);
    let real = fx.base.join("real");
    fs::create_dir(&real).unwrap();
    let before = fx.now - 50 * DAY;
    set_mtime(&real, before);
    let link = fx.base.join("link");
    symlink(&real, &link).unwrap();
    touch_generated(&link, fx.now);
    assert_eq!(mtime(&real), before);
}
