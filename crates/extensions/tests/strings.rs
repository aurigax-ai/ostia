#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ostia_contract::PRODUCT_DISPLAY_NAME;
use ostia_contract::dict::{Dict, en, zh_hant};
use ostia_extensions::language_packs::{LanguageContribution, LanguageSource};
use ostia_extensions::strings::{MainStrings, MainStringsDeps, create_main_strings};
use serde_json::{Value, json};
use tempfile::TempDir;

fn pack(dirs: &mut Vec<TempDir>, catalog: &Value, id: &str) -> LanguageSource {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("catalog.json"), catalog.to_string()).unwrap();
    let source = LanguageSource {
        ext_id: format!("langpack-{id}"),
        dir: PathBuf::from(dir.path()),
        language: LanguageContribution {
            id: id.to_owned(),
            label: id.to_owned(),
            path: "catalog.json".to_owned(),
        },
    };
    dirs.push(dir);
    source
}

struct Harness {
    strings: MainStrings,
    errors: Arc<Mutex<Vec<String>>>,
}

fn strings(locale: Option<&str>, sources: Arc<Mutex<Vec<LanguageSource>>>) -> Harness {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&errors);
    let locale = locale.map(str::to_owned);
    let strings = create_main_strings(MainStringsDeps {
        locale: Box::new(move || locale.clone()),
        languages: Box::new(move || sources.lock().unwrap().clone()),
        on_error: Box::new(move |ext_id, error| {
            sink.lock().unwrap().push(format!("{ext_id}: {error}"));
        }),
    });
    Harness { strings, errors }
}

fn active(sources: Vec<LanguageSource>) -> Arc<Mutex<Vec<LanguageSource>>> {
    Arc::new(Mutex::new(sources))
}

fn text<'a>(dict: &'a Dict, pointer: &str) -> &'a str {
    dict.pointer(pointer).and_then(Value::as_str).unwrap()
}

#[test]
fn translates_native_text_with_the_language_pack_of_the_chosen_locale() {
    let mut dirs = Vec::new();
    let source = pack(&mut dirs, zh_hant(), "zh-Hant");
    let harness = strings(Some("zh-Hant"), active(vec![source]));
    let dict = harness.strings.dict();
    assert_eq!(
        text(&dict, "/native/quit/quit"),
        text(zh_hant(), "/native/quit/quit")
    );
    assert_eq!(
        text(&dict, "/native/tray/unread"),
        text(zh_hant(), "/native/tray/unread")
    );
    assert_eq!(
        text(&dict, "/native/signIn/done"),
        format!("已登入。你可以關閉此分頁並回到 {PRODUCT_DISPLAY_NAME}。")
    );
    assert_eq!(
        text(&dict, "/native/updateTitle"),
        format!("更新 {PRODUCT_DISPLAY_NAME}")
    );
}

#[test]
fn keeps_english_for_every_string_the_pack_leaves_out() {
    let mut dirs = Vec::new();
    let source = pack(
        &mut dirs,
        &json!({ "native": { "tray": { "show": "Afficher" } } }),
        "fr",
    );
    let harness = strings(Some("fr"), active(vec![source]));
    let dict = harness.strings.dict();
    let mut expected_tray = en().pointer("/native/tray").unwrap().clone();
    expected_tray["show"] = json!("Afficher");
    assert_eq!(dict.pointer("/native/tray").unwrap(), &expected_tray);
    assert_eq!(dict.pointer("/native/quit"), en().pointer("/native/quit"));
}

#[test]
fn speaks_english_without_a_locale_for_english_and_for_a_locale_no_pack_provides() {
    let mut dirs = Vec::new();
    let source = pack(&mut dirs, zh_hant(), "zh-Hant");
    for locale in [None, Some("en"), Some("fr")] {
        let harness = strings(locale, active(vec![source.clone()]));
        let dict = harness.strings.dict();
        assert_eq!(text(&dict, "/native/tray/quit"), "Quit", "{locale:?}");
        assert_eq!(
            text(&dict, "/native/updateTitle"),
            format!("Update {PRODUCT_DISPLAY_NAME}"),
            "{locale:?}"
        );
    }
}

#[test]
fn reports_a_pack_it_cannot_read_and_speaks_english() {
    let mut dirs = Vec::new();
    let source = pack(&mut dirs, zh_hant(), "zh-Hant");
    std::fs::write(source.dir.join("catalog.json"), "{").unwrap();
    let harness = strings(Some("zh-Hant"), active(vec![source]));
    let dict = harness.strings.dict();
    assert_eq!(text(&dict, "/native/tray/quit"), "Quit");
    assert_eq!(
        *harness.errors.lock().unwrap(),
        vec!["langpack-zh-Hant: catalog.json: not valid JSON".to_owned()]
    );
}

#[test]
fn reads_a_pack_once_and_follows_the_packs_that_are_active() {
    let mut dirs = Vec::new();
    let source = pack(&mut dirs, zh_hant(), "zh-Hant");
    let sources = active(vec![source.clone()]);
    let harness = strings(Some("zh-Hant"), Arc::clone(&sources));
    let first = harness.strings.dict();
    assert!(Arc::ptr_eq(&harness.strings.dict(), &first));
    *sources.lock().unwrap() = Vec::new();
    assert_eq!(text(&harness.strings.dict(), "/native/tray/quit"), "Quit");
    *sources.lock().unwrap() = vec![source];
    assert_eq!(
        text(&harness.strings.dict(), "/native/tray/quit"),
        text(zh_hant(), "/native/tray/quit")
    );
}

#[test]
fn speaks_english_from_one_shared_dictionary_while_no_pack_applies() {
    let harness = strings(None, active(Vec::new()));
    let first = harness.strings.dict();
    assert!(Arc::ptr_eq(&harness.strings.dict(), &first));
    assert_eq!(
        first.as_ref(),
        &ostia_contract::dict::merge_catalog(&json!({}))
    );
}
