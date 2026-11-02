#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures_util::FutureExt;
use ostia_model::theme::local_fonts::{FontQuery, LocalFonts};

fn bundled() -> Vec<String> {
    vec!["\"Inter\"".to_string(), "JetBrains Mono".to_string()]
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|name| (*name).to_string()).collect()
}

fn counted_query(
    calls: &Arc<AtomicUsize>,
    answer: impl Fn(usize) -> Result<Vec<String>, String> + Send + Sync + 'static,
) -> FontQuery {
    let calls = Arc::clone(calls);
    Arc::new(move || {
        let call = calls.fetch_add(1, Ordering::SeqCst);
        let result = answer(call);
        async move { result }.boxed()
    })
}

#[tokio::test]
async fn lists_the_bundled_and_installed_families_sorted_and_unique() {
    let calls = Arc::new(AtomicUsize::new(0));
    let query = counted_query(&calls, |_| Ok(names(&["Fira Code", "Inter"])));
    let fonts = LocalFonts::new(bundled(), Some(query));
    assert_eq!(
        fonts.families().await,
        names(&["Fira Code", "Inter", "JetBrains Mono"])
    );
}

#[tokio::test]
async fn returns_the_bundled_families_when_the_query_throws() {
    let calls = Arc::new(AtomicUsize::new(0));
    let query = counted_query(&calls, |_| Err("no gesture".to_string()));
    let fonts = LocalFonts::new(bundled(), Some(query));
    assert_eq!(fonts.families().await, names(&["Inter", "JetBrains Mono"]));
}

#[tokio::test]
async fn queries_again_after_a_failed_load() {
    let calls = Arc::new(AtomicUsize::new(0));
    let query = counted_query(&calls, |call| {
        if call == 0 {
            Err("no gesture".to_string())
        } else {
            Ok(names(&["Fira Code"]))
        }
    });
    let fonts = LocalFonts::new(bundled(), Some(query));
    fonts.families().await;
    assert_eq!(
        fonts.families().await,
        names(&["Fira Code", "Inter", "JetBrains Mono"])
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn keeps_a_successful_load() {
    let calls = Arc::new(AtomicUsize::new(0));
    let query = counted_query(&calls, |_| Ok(names(&["Fira Code"])));
    let fonts = LocalFonts::new(bundled(), Some(query));
    fonts.families().await;
    fonts.families().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lists_only_the_bundled_families_when_there_is_no_query() {
    let fonts = LocalFonts::new(bundled(), None);
    assert_eq!(fonts.families().await, names(&["Inter", "JetBrains Mono"]));
}

#[tokio::test]
async fn queries_again_after_a_load_that_finds_no_family() {
    let calls = Arc::new(AtomicUsize::new(0));
    let query = counted_query(&calls, |_| Ok(Vec::new()));
    let fonts = LocalFonts::new(Vec::new(), Some(query));
    assert!(fonts.families().await.is_empty());
    assert!(fonts.families().await.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
