#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

use ostia_model::workspaces::workspace_title::workspace_title;

fn rust_sources(dir: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn prefers_the_custom_name() {
    assert_eq!(workspace_title("alpha", Some("Alpha")), "Alpha");
    assert_eq!(workspace_title("alpha", None), "alpha");
}

#[test]
fn keeps_an_empty_custom_name_as_ts_does() {
    assert_eq!(workspace_title("alpha", Some("")), "");
}

#[test]
fn is_the_only_place_that_falls_back_from_custom_name_to_name() {
    let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for entry in fs::read_dir(&crates).unwrap() {
        let src = entry.unwrap().path().join("src");
        if src.is_dir() {
            rust_sources(&src, &mut files);
        }
    }
    let offenders: Vec<&PathBuf> = files
        .iter()
        .filter(|file| !file.ends_with("workspace_title.rs"))
        .filter(|file| {
            fs::read_to_string(file).unwrap().lines().any(|line| {
                line.contains("custom_name")
                    && (line.contains(".unwrap_or(") || line.contains(".unwrap_or_else("))
            })
        })
        .collect();
    assert!(offenders.is_empty(), "{offenders:?}");
}
