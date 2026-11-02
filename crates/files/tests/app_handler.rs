#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;

use futures_util::FutureExt;
use ostia_base::host::{Host, Platform};
use ostia_files::app_handler::{
    HandlerLookup, application_dirs, desktop_name, handler_name, read_desktop,
};
use tempfile::TempDir;

fn lookup(platform: Platform, default: &str, entry: Option<&str>, app: &str) -> HandlerLookup {
    let default = default.to_owned();
    let entry = entry.map(str::to_owned);
    let app = app.to_owned();
    HandlerLookup {
        platform,
        protocol_app: Arc::new(move |_| app.clone()),
        query_default: Arc::new(move |_| {
            let default = default.clone();
            async move { default }.boxed()
        }),
        read_desktop: Arc::new(move |_| {
            let entry = entry.clone();
            async move { entry }.boxed()
        }),
    }
}

fn linux(default: &str, entry: Option<&str>) -> HandlerLookup {
    lookup(Platform::Linux, default, entry, "unused")
}

fn host(pairs: &[(&str, &str)]) -> Host {
    Host {
        env: pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        home: "/home/u".into(),
        cwd: "/home/u".into(),
        platform: Platform::Linux,
    }
}

#[test]
fn reads_name_from_the_desktop_entry_section_only() {
    let entry =
        "[Desktop Action new]\nName=New window\n[Desktop Entry]\nName[de]=Notizen\nName=Obsidian\n";
    assert_eq!(desktop_name(entry).as_deref(), Some("Obsidian"));
    assert_eq!(desktop_name("[Desktop Entry]\nExec=x\n"), None);
}

#[test]
fn trims_the_name_reads_crlf_lines_and_treats_an_empty_name_as_none() {
    assert_eq!(
        desktop_name("[Desktop Entry]\r\nName=  Zed Editor  \r\n").as_deref(),
        Some("Zed Editor")
    );
    assert_eq!(desktop_name("[Desktop Entry]\nName=   \n"), None);
    assert_eq!(desktop_name("Name=Loose\n"), None);
}

#[tokio::test]
async fn uses_the_default_handler_file_of_a_scheme_on_linux() {
    let found = handler_name(
        "obsidian://a",
        &linux("obsidian.desktop\n", Some("[Desktop Entry]\nName=Obsidian")),
    )
    .await;
    assert_eq!(found.as_deref(), Some("Obsidian"));
}

#[tokio::test]
async fn falls_back_to_the_file_name_when_the_entry_has_no_name_or_cannot_be_read() {
    let unreadable = handler_name("zed://a", &linux("dev.zed.Zed.desktop", None)).await;
    assert_eq!(unreadable.as_deref(), Some("dev.zed.Zed"));
    let nameless = handler_name(
        "zed://a",
        &linux("dev.zed.Zed.desktop", Some("[Desktop Entry]\nExec=zed")),
    )
    .await;
    assert_eq!(nameless.as_deref(), Some("dev.zed.Zed"));
}

#[tokio::test]
async fn answers_null_when_no_handler_is_registered_or_the_answer_is_not_a_file_name() {
    assert_eq!(handler_name("slack://a", &linux("", None)).await, None);
    assert_eq!(
        handler_name("slack://a", &linux("../x.desktop", None)).await,
        None
    );
    assert_eq!(
        handler_name("slack://a", &linux("not-a-desktop-file", None)).await,
        None
    );
}

#[tokio::test]
async fn asks_the_system_on_other_systems() {
    let mac = lookup(Platform::Darwin, "", None, "Obsidian");
    assert_eq!(
        handler_name("obsidian://a", &mac).await.as_deref(),
        Some("Obsidian")
    );
    let none = lookup(Platform::Darwin, "", None, "");
    assert_eq!(handler_name("obsidian://a", &none).await, None);
}

#[test]
fn searches_the_user_data_folder_then_the_system_data_folders() {
    let dirs = application_dirs(&host(&[
        ("XDG_DATA_HOME", "/data"),
        ("XDG_DATA_DIRS", "/a:/b"),
    ]));
    assert_eq!(
        dirs,
        ["/data/applications", "/a/applications", "/b/applications"].map(std::path::PathBuf::from)
    );
}

#[test]
fn falls_back_to_the_home_folder_and_the_standard_data_folders() {
    let dirs = application_dirs(&host(&[("XDG_DATA_HOME", ""), ("XDG_DATA_DIRS", "::/a::")]));
    assert_eq!(
        dirs,
        ["/home/u/.local/share/applications", "/a/applications"].map(std::path::PathBuf::from)
    );
    let defaults = application_dirs(&host(&[]));
    assert_eq!(
        defaults,
        [
            "/home/u/.local/share/applications",
            "/usr/local/share/applications",
            "/usr/share/applications"
        ]
        .map(std::path::PathBuf::from)
    );
}

#[tokio::test]
async fn reads_a_desktop_file_from_the_first_folder_that_has_it() {
    let first = TempDir::new().unwrap();
    let second = TempDir::new().unwrap();
    for (root, name) in [(&first, "First"), (&second, "Second")] {
        fs::create_dir_all(root.path().join("applications")).unwrap();
        fs::write(
            root.path().join("applications/app.desktop"),
            format!("[Desktop Entry]\nName={name}\n"),
        )
        .unwrap();
    }
    fs::write(
        second.path().join("applications/only-second.desktop"),
        "[Desktop Entry]\nName=Only\n",
    )
    .unwrap();
    let dirs = format!("{}:{}", first.path().display(), second.path().display());
    let host = host(&[("XDG_DATA_HOME", "/nowhere"), ("XDG_DATA_DIRS", &dirs)]);
    let app = read_desktop(&host, "app.desktop").await.unwrap();
    assert!(app.contains("Name=First"), "{app}");
    let only = read_desktop(&host, "only-second.desktop").await.unwrap();
    assert!(only.contains("Name=Only"));
    assert_eq!(read_desktop(&host, "missing.desktop").await, None);
}
