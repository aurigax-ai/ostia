#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

use ostia_model::theme::icon_weight::{IconWeight, icon_weight};

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

fn app_sources() -> Vec<(PathBuf, String)> {
    let app = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("app")
        .join("src");
    let mut files = Vec::new();
    rust_sources(&app, &mut files);
    files
        .into_iter()
        .map(|file| {
            let text = fs::read_to_string(&file).unwrap();
            (file, text)
        })
        .collect()
}

#[test]
fn keeps_the_regular_weight_only_where_its_1_px_strokes_land_on_whole_device_pixels() {
    assert_eq!(icon_weight(2.0), IconWeight::Regular);
    assert_eq!(icon_weight(4.0), IconWeight::Regular);
    assert_eq!(icon_weight(2.0000001), IconWeight::Regular);
}

#[test]
fn uses_the_bold_weight_on_1x_fractional_scales_and_app_zoom_other_than_100_percent() {
    for ratio in [1.0, 1.25, 1.5, 1.75, 1.8, 2.2, 2.4, 3.0] {
        assert_eq!(icon_weight(ratio), IconWeight::Bold, "{ratio}");
    }
}

#[test]
fn comes_from_the_one_sync_call_in_the_root_view() {
    let callers: Vec<String> = app_sources()
        .into_iter()
        .filter(|(_, text)| text.contains("sync_icon_weight("))
        .filter(|(file, _)| !file.ends_with("icons.rs"))
        .map(|(file, _)| file.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(callers, vec!["root.rs".to_string()]);
}

#[test]
fn is_never_set_on_a_single_icon() {
    let overrides: Vec<PathBuf> = app_sources()
        .into_iter()
        .filter(|(file, _)| !file.ends_with("root.rs"))
        .filter(|(_, text)| text.contains("IconWeight"))
        .map(|(file, _)| file)
        .collect();
    assert!(overrides.is_empty(), "{overrides:?}");
}
