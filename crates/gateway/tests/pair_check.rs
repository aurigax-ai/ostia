#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use ostia_gateway::pair_check::{check_code, commit_of};
use serde_json::Value;

const FINGERPRINT: &str = "sha256/q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=";
const PUBKEY: &str = "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=";

fn phone_nonce() -> [u8; 32] {
    [1; 32]
}

fn desktop_nonce() -> [u8; 32] {
    [2; 32]
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust")
        .join(name)
}

#[test]
fn cpd_c18_computes_the_contract_test_vector() {
    assert_eq!(
        check_code(FINGERPRINT, PUBKEY, &phone_nonce(), &desktop_nonce()),
        "396848"
    );
}

#[test]
fn cpd_c16_gives_a_relay_holding_another_certificate_different_digits() {
    let relay = "sha256/OTHERfingerprintOTHERfingerprintOTHERfing=";
    let phone_sees = check_code(relay, PUBKEY, &phone_nonce(), &desktop_nonce());
    let desktop_shows = check_code(FINGERPRINT, PUBKEY, &phone_nonce(), &desktop_nonce());
    assert_eq!(phone_sees, "274033");
    assert_ne!(phone_sees, desktop_shows);
}

#[test]
fn gives_the_codes_the_ts_function_gave_for_the_same_inputs() {
    let rows: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("gateway-pair-check.json")).unwrap())
            .unwrap();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 300);
    let mut leading_zeros = 0;
    for (index, row) in rows.iter().enumerate() {
        let text = |key: &str| row[key].as_str().unwrap();
        let code = check_code(
            text("fingerprint"),
            text("pubkey"),
            &hex::decode(text("phone")).unwrap(),
            &hex::decode(text("desktop")).unwrap(),
        );
        assert_eq!(code, text("code"), "row {index}");
        assert_eq!(code.len(), 6, "row {index}");
        if code.starts_with('0') {
            leading_zeros += 1;
        }
    }
    assert!(leading_zeros > 0);
}

#[test]
fn keeps_the_fields_apart_with_a_separator() {
    let phone = phone_nonce();
    let desktop = desktop_nonce();
    for ((left_fp, left_pk), (right_fp, right_pk)) in
        [(("ab", "c"), ("a", "bc")), (("", "abc"), ("abc", ""))]
    {
        assert_ne!(
            check_code(left_fp, left_pk, &phone, &desktop),
            check_code(right_fp, right_pk, &phone, &desktop),
            "{left_fp}|{left_pk} against {right_fp}|{right_pk}"
        );
    }
}

#[test]
fn hashes_the_phone_nonce_before_the_desktop_nonce() {
    assert_ne!(
        check_code(FINGERPRINT, PUBKEY, &phone_nonce(), &desktop_nonce()),
        check_code(FINGERPRINT, PUBKEY, &desktop_nonce(), &phone_nonce())
    );
}

#[test]
fn commits_to_a_nonce_with_its_sha256_as_lowercase_hex() {
    assert_eq!(
        commit_of(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        commit_of(&phone_nonce()),
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(phone_nonce()))
    );
}
