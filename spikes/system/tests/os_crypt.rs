use std::collections::HashMap;

use ostia_spike_system::keyring_password;
use ostia_spike_system::os_crypt::{Keys, OsCryptError, Prefix, open_base64, seal_base64};
use rand::RngCore;

const SERVICE: &str = "ostia-spike-test";
const USER: &str = "safe-storage";

#[test]
fn v10_round_trips_with_the_fixed_linux_key() {
    let keys = Keys::linux(None);
    let stored = seal_base64(Prefix::V10, "token-123", &keys).unwrap();
    assert_eq!(open_base64(&stored, &keys).unwrap(), "token-123");
}

#[test]
fn v11_without_a_keyring_password_is_refused() {
    let sealed = seal_base64(Prefix::V11, "x", &Keys::linux(Some(b"pw"))).unwrap();
    assert!(matches!(
        open_base64(&sealed, &Keys::linux(None)),
        Err(OsCryptError::NoKeyForPrefix("v11"))
    ));
}

#[test]
fn unknown_prefix_and_short_values_are_refused() {
    let keys = Keys::linux(None);
    assert!(matches!(
        open_base64("djEyYWJj", &keys),
        Err(OsCryptError::UnknownPrefix(_))
    ));
    assert!(matches!(
        open_base64("dg==", &keys),
        Err(OsCryptError::TooShort)
    ));
}

#[test]
fn wrong_key_does_not_return_plaintext() {
    let stored = seal_base64(Prefix::V11, "secret", &Keys::linux(Some(b"right"))).unwrap();
    let opened = open_base64(&stored, &Keys::linux(Some(b"wrong")));
    assert!(!matches!(opened, Ok(ref plain) if plain == "secret"));
}

#[test]
fn mac_keys_use_1003_iterations_and_v10() {
    let keys = Keys::mac(b"keychain-password");
    let stored = seal_base64(Prefix::V10, "mac-value", &keys).unwrap();
    assert_eq!(open_base64(&stored, &keys).unwrap(), "mac-value");
    let linux_opened = open_base64(&stored, &Keys::linux(None));
    assert!(!matches!(linux_opened, Ok(ref plain) if plain == "mac-value"));
}

#[test]
#[ignore = "needs an unlocked Secret Service on a private D-Bus session"]
fn v11_value_opens_with_a_password_read_from_the_keyring() {
    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    let password = base64_password(&raw);

    keyring::Entry::store_status().as_ref().unwrap();
    let entry = keyring_core::Entry::new(SERVICE, USER).unwrap();
    entry.set_password(&password).unwrap();

    let stored = seal_base64(
        Prefix::V11,
        "hello from the test",
        &Keys::linux(Some(password.as_bytes())),
    )
    .unwrap();

    let attributes = HashMap::from([("service", SERVICE), ("username", USER)]);
    let from_keyring = keyring_password::read(&attributes).unwrap();
    let opened = open_base64(&stored, &Keys::linux(Some(&from_keyring)));

    entry.delete_credential().unwrap();
    assert_eq!(opened.unwrap(), "hello from the test");
}

fn base64_password(raw: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(raw)
}
