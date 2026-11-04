#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use ostia_browser::credentials::{
    CredentialDeps, CredentialError, CredentialImportResult, CredentialInput, CredentialSaveResult,
    CredentialStore, CredentialSummary, StoredCredential, create_credential_store,
    normalize_origin, password_rows_from_csv,
};
use parking_lot::Mutex;

struct Memory {
    store: CredentialStore,
    saved: Arc<Mutex<Vec<StoredCredential>>>,
    fail_save: Arc<AtomicBool>,
    fail_encrypt: Arc<AtomicBool>,
    fail_decrypt: Arc<AtomicBool>,
}

fn memory_store(can_encrypt: bool) -> Memory {
    let saved = Arc::new(Mutex::new(Vec::<StoredCredential>::new()));
    let counter = Arc::new(AtomicUsize::new(0));
    let fail_save = Arc::new(AtomicBool::new(false));
    let fail_encrypt = Arc::new(AtomicBool::new(false));
    let fail_decrypt = Arc::new(AtomicBool::new(false));
    let store = create_credential_store(CredentialDeps {
        load: {
            let saved = saved.clone();
            Box::new(move || saved.lock().clone())
        },
        save: {
            let saved = saved.clone();
            let fail = fail_save.clone();
            Box::new(move |list| {
                if fail.load(Ordering::SeqCst) {
                    return Err(CredentialError::Storage);
                }
                *saved.lock() = list.to_vec();
                Ok(())
            })
        },
        can_encrypt: Box::new(move || can_encrypt),
        encrypt: {
            let fail = fail_encrypt.clone();
            Box::new(move |plain| {
                if fail.load(Ordering::SeqCst) {
                    return Err(CredentialError::Crypto);
                }
                Ok(format!("enc:{plain}"))
            })
        },
        decrypt: {
            let fail = fail_decrypt.clone();
            Box::new(move |secret| {
                if fail.load(Ordering::SeqCst) {
                    return Err(CredentialError::Crypto);
                }
                Ok(secret.strip_prefix("enc:").unwrap_or(secret).to_owned())
            })
        },
        now: Box::new(|| 1000),
        new_id: Box::new(move || format!("c{}", counter.fetch_add(1, Ordering::SeqCst) + 1)),
    });
    Memory {
        store,
        saved,
        fail_save,
        fail_encrypt,
        fail_decrypt,
    }
}

fn input(origin: &str, username: &str, password: &str) -> CredentialInput {
    CredentialInput {
        origin: origin.to_owned(),
        username: username.to_owned(),
        password: password.to_owned(),
    }
}

fn saved(id: &str, updated: bool) -> CredentialSaveResult {
    CredentialSaveResult::Saved {
        id: id.to_owned(),
        updated,
    }
}

fn failed(error: CredentialError) -> CredentialSaveResult {
    CredentialSaveResult::Failed { error }
}

fn summary(id: &str, origin: &str, username: &str) -> CredentialSummary {
    CredentialSummary {
        id: id.to_owned(),
        origin: origin.to_owned(),
        username: username.to_owned(),
        updated_at: 1000,
    }
}

#[test]
fn stores_passwords_encrypted_under_the_exact_origin_and_lists_them_without_passwords() {
    let m = memory_store(true);
    assert_eq!(
        m.store.save(input("https://github.com/login", "me", "pw")),
        saved("c1", false)
    );
    assert!(m.saved.lock().iter().all(|c| c.secret != "pw"));
    assert_eq!(m.saved.lock()[0].secret, "enc:pw");
    assert_eq!(
        m.store.list(),
        vec![summary("c1", "https://github.com", "me")]
    );
    assert_eq!(m.store.password("c1"), Ok(Some("pw".to_owned())));
}

#[test]
fn updates_the_password_of_the_same_origin_and_username_instead_of_adding_a_duplicate() {
    let m = memory_store(true);
    m.store.save(input("https://github.com", "me", "old"));
    assert_eq!(
        m.store.save(input("https://github.com/", "me", "new")),
        saved("c1", true)
    );
    assert_eq!(m.store.list().len(), 1);
    assert_eq!(m.store.password("c1"), Ok(Some("new".to_owned())));
}

#[test]
fn matches_only_the_exact_origin_never_a_look_alike_host() {
    let m = memory_store(true);
    m.store.save(input("https://github.com", "me", "pw"));
    assert_eq!(
        m.store
            .for_origin("https://github.com/settings")
            .unwrap()
            .len(),
        1
    );
    assert!(
        m.store
            .for_origin("https://github.com.evil.io/login")
            .unwrap()
            .is_empty()
    );
    assert!(m.store.for_origin("http://github.com").unwrap().is_empty());
}

#[test]
fn refuses_bad_input_and_works_only_when_encryption_is_available() {
    let m = memory_store(true);
    assert_eq!(
        m.store.save(input("ftp://x", "a", "b")),
        failed(CredentialError::InvalidOrigin)
    );
    assert_eq!(
        m.store.save(input("https://x.dev", "a", "")),
        failed(CredentialError::Empty)
    );
    let locked = memory_store(false);
    assert_eq!(
        locked.store.save(input("https://x.dev", "a", "b")),
        failed(CredentialError::EncryptionUnavailable)
    );
}

#[test]
fn imports_rows_counting_new_updated_and_skipped_entries() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "old"));
    assert_eq!(
        m.store.import_rows(vec![
            input("https://a.dev", "me", "new"),
            input("https://b.dev", "me", "pw"),
            input("not a url", "me", "pw"),
        ]),
        CredentialImportResult::Imported {
            imported: 1,
            updated: 1,
            skipped: 1
        }
    );
    let origins: Vec<String> = m.store.list().into_iter().map(|c| c.origin).collect();
    assert_eq!(origins, ["https://a.dev", "https://b.dev"]);
}

#[test]
fn removes_an_entry_by_id() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "pw"));
    assert_eq!(m.store.remove("c1"), Ok(true));
    assert_eq!(m.store.remove("c1"), Ok(false));
    assert!(m.store.list().is_empty());
}

#[test]
fn trims_the_username_and_keeps_at_most_1024_utf16_units_of_it() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "  me  ", "pw"));
    assert_eq!(m.store.list()[0].username, "me");
    m.store
        .save(input("https://b.dev", &"u".repeat(1030), "pw"));
    let b = m
        .store
        .list()
        .into_iter()
        .find(|c| c.origin == "https://b.dev")
        .unwrap();
    assert_eq!(b.username.len(), 1024);
}

#[test]
fn refuses_a_password_longer_than_1024_utf16_units_and_accepts_one_of_exactly_1024() {
    let m = memory_store(true);
    assert_eq!(
        m.store
            .save(input("https://a.dev", "me", &"p".repeat(1025))),
        failed(CredentialError::Empty)
    );
    assert_eq!(
        m.store
            .save(input("https://a.dev", "me", &"p".repeat(1024))),
        saved("c1", false)
    );
    assert_eq!(
        m.store
            .save(input("https://c.dev", "me", &"😀".repeat(513))),
        failed(CredentialError::Empty)
    );
}

#[test]
fn keeps_a_failed_save_out_of_the_file_and_does_not_burn_an_id() {
    let m = memory_store(true);
    m.store.save(input("ftp://x", "a", "b"));
    assert!(m.saved.lock().is_empty());
    assert_eq!(
        m.store.save(input("https://a.dev", "me", "pw")),
        saved("c1", false)
    );
}

#[test]
fn lists_entries_by_origin_and_then_by_username() {
    let m = memory_store(true);
    m.store.save(input("https://b.dev", "zed", "pw"));
    m.store.save(input("https://a.dev", "bob", "pw"));
    m.store.save(input("https://b.dev", "amy", "pw"));
    let order: Vec<(String, String)> = m
        .store
        .list()
        .into_iter()
        .map(|c| (c.origin, c.username))
        .collect();
    assert_eq!(
        order,
        [
            ("https://a.dev".to_owned(), "bob".to_owned()),
            ("https://b.dev".to_owned(), "amy".to_owned()),
            ("https://b.dev".to_owned(), "zed".to_owned()),
        ]
    );
}

#[test]
fn gives_the_password_and_the_origin_matches_only_while_encryption_is_available() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "pw"));
    let matches = m.store.for_origin("https://a.dev/x").unwrap();
    assert_eq!(matches[0].password, "pw");
    assert_eq!(matches[0].origin, "https://a.dev");
    assert_eq!(m.store.password("missing"), Ok(None));

    let locked = memory_store(false);
    *locked.saved.lock() = m.saved.lock().clone();
    assert_eq!(locked.store.password("c1"), Ok(None));
    assert!(locked.store.for_origin("https://a.dev").unwrap().is_empty());
}

#[test]
fn refuses_an_import_when_encryption_is_unavailable_and_changes_nothing() {
    let locked = memory_store(false);
    assert_eq!(
        locked
            .store
            .import_rows(vec![input("https://a.dev", "me", "pw")]),
        CredentialImportResult::Failed {
            error: CredentialError::EncryptionUnavailable
        }
    );
    assert!(locked.saved.lock().is_empty());
}

#[test]
fn counts_a_row_repeated_inside_one_import_as_new_then_updated() {
    let m = memory_store(true);
    assert_eq!(
        m.store.import_rows(vec![
            input("https://a.dev", "me", "one"),
            input("https://a.dev/", "me", "two"),
        ]),
        CredentialImportResult::Imported {
            imported: 1,
            updated: 1,
            skipped: 0
        }
    );
    assert_eq!(m.store.password("c1"), Ok(Some("two".to_owned())));
}

#[test]
fn reduces_an_url_to_its_origin_and_refuses_other_schemes_and_text() {
    assert_eq!(
        normalize_origin("  https://github.com:443/a?b#c "),
        Some("https://github.com".to_owned())
    );
    assert_eq!(
        normalize_origin("http://localhost:8080/x"),
        Some("http://localhost:8080".to_owned())
    );
    for raw in ["ftp://x", "javascript:alert(1)", "not a url", ""] {
        assert_eq!(normalize_origin(raw), None, "raw {raw:?}");
    }
}

#[test]
fn reads_a_chrome_export() {
    assert_eq!(
        password_rows_from_csv(
            "name,url,username,password,note\ngh,https://github.com/,me,s3cret,\n"
        ),
        Some(vec![input("https://github.com/", "me", "s3cret")])
    );
}

#[test]
fn reads_a_bitwarden_export_by_its_column_names() {
    let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n               ,,login,gh,,,0,https://github.com,me,pw,\n";
    assert_eq!(
        password_rows_from_csv(csv),
        Some(vec![input("https://github.com", "me", "pw")])
    );
}

#[test]
fn reads_quoted_fields_with_commas_doubled_quotes_and_newlines_and_skips_blank_lines() {
    let csv = "url,username,password\r\n\"https://a.test/x,y\",\"say \"\"hi\"\"\",\"two\nlines\"\r\n \r\nhttps://b.test,,p\r\n";
    assert_eq!(
        password_rows_from_csv(csv),
        Some(vec![
            input("https://a.test/x,y", "say \"hi\"", "two\nlines"),
            input("https://b.test", "", "p"),
        ])
    );
}

#[test]
fn reads_rows_the_same_whatever_mix_of_line_endings_the_file_has() {
    let rows = Some(vec![
        input("https://a.test", "me", "pw"),
        input("https://b.test", "you", "pw2"),
    ]);
    let lines = [
        "url,username,password",
        "https://a.test,me,pw",
        "https://b.test,you,pw2",
    ];
    assert_eq!(
        password_rows_from_csv(&format!("{}\r\n{}\n{}\n", lines[0], lines[1], lines[2])),
        rows
    );
    assert_eq!(
        password_rows_from_csv(&format!("{}\n{}\r\n{}\n", lines[0], lines[1], lines[2])),
        rows
    );
    assert_eq!(
        password_rows_from_csv(&format!("{}\r{}\r{}", lines[0], lines[1], lines[2])),
        rows
    );
}

#[test]
fn returns_none_for_a_file_with_a_stray_quote_instead_of_guessing_the_passwords() {
    assert_eq!(
        password_rows_from_csv(
            "url,username,password\nhttps://a.test,me,\"pw\"x\nhttps://b.test,you,pw2\n"
        ),
        None
    );
}

#[test]
fn returns_none_when_there_is_no_url_or_password_column() {
    assert_eq!(password_rows_from_csv("name,note\na,b\n"), None);
    assert_eq!(password_rows_from_csv(""), None);
}

#[test]
fn matches_column_names_without_case_or_edge_spaces_and_takes_the_first_matching_column() {
    assert_eq!(
        password_rows_from_csv(" Website ,User, Password \nhttps://a.test,me,pw\n"),
        Some(vec![input("https://a.test", "me", "pw")])
    );
    assert_eq!(
        password_rows_from_csv("url,origin,password\nhttps://a.test,https://b.test,pw\n"),
        Some(vec![input("https://a.test", "", "pw")])
    );
}

#[test]
fn fills_a_missing_username_column_and_short_rows_with_empty_text() {
    assert_eq!(
        password_rows_from_csv("url,password\nhttps://a.test,pw\nhttps://b.test\n"),
        Some(vec![
            input("https://a.test", "", "pw"),
            input("https://b.test", "", ""),
        ])
    );
}

#[test]
fn returns_a_row_list_with_no_rows_for_a_header_only_file() {
    assert_eq!(password_rows_from_csv("url,password\n"), Some(vec![]));
}

#[test]
fn reports_a_failed_write_and_keeps_the_file_as_it_was() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "old"));
    m.fail_save.store(true, Ordering::SeqCst);
    assert_eq!(
        m.store.save(input("https://b.dev", "me", "pw")),
        failed(CredentialError::Storage)
    );
    assert_eq!(m.store.remove("c1"), Err(CredentialError::Storage));
    assert_eq!(
        m.store
            .import_rows(vec![input("https://c.dev", "me", "pw")]),
        CredentialImportResult::Failed {
            error: CredentialError::Storage
        }
    );
    m.fail_save.store(false, Ordering::SeqCst);
    assert_eq!(m.store.list().len(), 1);
}

#[test]
fn keeps_the_old_secret_when_encryption_fails_on_an_update() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "old"));
    m.fail_encrypt.store(true, Ordering::SeqCst);
    assert_eq!(
        m.store.save(input("https://a.dev", "me", "new")),
        failed(CredentialError::Crypto)
    );
    assert_eq!(
        m.store
            .import_rows(vec![input("https://a.dev", "me", "new")]),
        CredentialImportResult::Failed {
            error: CredentialError::Crypto
        }
    );
    assert_eq!(m.saved.lock()[0].secret, "enc:old");
}

#[test]
fn never_fills_a_password_when_decryption_fails() {
    let m = memory_store(true);
    m.store.save(input("https://a.dev", "me", "pw"));
    m.fail_decrypt.store(true, Ordering::SeqCst);
    assert_eq!(m.store.password("c1"), Err(CredentialError::Crypto));
    assert_eq!(
        m.store.for_origin("https://a.dev").unwrap_err(),
        CredentialError::Crypto
    );
}

#[test]
fn reads_a_file_that_starts_with_a_byte_order_mark() {
    assert_eq!(
        password_rows_from_csv("\u{feff}\"url\",\"username\",\"password\"\nhttps://a.test,me,pw\n"),
        Some(vec![input("https://a.test", "me", "pw")])
    );
}

#[test]
fn accepts_white_space_between_a_closing_quote_and_the_delimiter() {
    assert_eq!(
        password_rows_from_csv(
            "url,username,password\n\"https://a.test\" ,me,\"pw\"\t\nhttps://b.test,you,pw2\n"
        ),
        Some(vec![
            input("https://a.test", "me", "pw"),
            input("https://b.test", "you", "pw2"),
        ])
    );
}

#[test]
fn refuses_white_space_after_a_closing_quote_at_the_end_of_the_file() {
    assert_eq!(
        password_rows_from_csv("url,username,password\nhttps://a.test,me,\"pw\" "),
        None
    );
    assert_eq!(
        password_rows_from_csv("url,username,password\nhttps://a.test,me,\"pw\""),
        Some(vec![input("https://a.test", "me", "pw")])
    );
}
