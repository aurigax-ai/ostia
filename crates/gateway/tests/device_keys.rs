#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ostia_gateway::device_keys::{
    DeviceKeys, DeviceSeeds, StampedKind, digest_of, generate_device_keys, keys_from_seeds,
    registration_of, seeds_of, sign_challenge, sign_stamped,
};
use serde_json::Value;

const BOX_SEED_START: u8 = 101;
const BOX_SEED_BYTES: u8 = 32;

fn vectors() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/server/vectors/auth.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn text(vectors: &Value, key: &str) -> String {
    vectors[key].as_str().unwrap().to_owned()
}

fn stamp_of(vectors: &Value) -> i64 {
    vectors["timestamp"].as_i64().unwrap()
}

fn if_match_of(vectors: &Value) -> String {
    vectors["ifMatch"].as_i64().unwrap().to_string()
}

fn vector_keys(vectors: &Value) -> DeviceKeys {
    let box_seed: Vec<u8> = (0..BOX_SEED_BYTES).map(|i| BOX_SEED_START + i).collect();
    let sign = URL_SAFE_NO_PAD
        .decode(vectors["signSeed"].as_str().unwrap())
        .unwrap();
    keys_from_seeds(&DeviceSeeds { sign, box_seed }).expect("the vector seeds are valid")
}

#[test]
fn sva_c1_derives_the_vector_public_keys_and_registration_proof_from_the_seeds() {
    let vectors = vectors();
    let registration = registration_of(&vector_keys(&vectors));
    assert_eq!(registration.sign_pub, text(&vectors, "signPub"));
    assert_eq!(registration.box_pub, text(&vectors, "boxPub"));
    assert_eq!(registration.proof, text(&vectors, "registrationProof"));
}

#[test]
fn sva_c2_signs_the_challenge_exactly_as_the_vector() {
    let vectors = vectors();
    assert_eq!(
        sign_challenge(
            &vector_keys(&vectors),
            &text(&vectors, "deviceId"),
            &text(&vectors, "nonce")
        ),
        text(&vectors, "challengeSignature")
    );
}

#[test]
fn sya_c190_signs_the_key_replacement_and_the_manifest_bound_clean_up_exactly_as_the_vectors() {
    let vectors = vectors();
    let keys = vector_keys(&vectors);
    let device_id = text(&vectors, "deviceId");
    let stamp = stamp_of(&vectors);
    let if_match = if_match_of(&vectors);

    let rotate_hash = text(&vectors, "syncRotateBodyHash");
    assert_eq!(digest_of(&text(&vectors, "syncRotateBody")), rotate_hash);
    assert_eq!(
        text(&vectors, "syncRotateMessage"),
        format!("ostia-server/sync-rotate/v1\n{device_id}\n{stamp}\n{if_match}\n{rotate_hash}")
    );
    assert_eq!(
        sign_stamped(
            &keys,
            StampedKind::SyncRotate,
            &device_id,
            stamp,
            &[&if_match, &rotate_hash]
        ),
        text(&vectors, "syncRotateSignature")
    );

    let gc_hash = text(&vectors, "syncGcBodyHash");
    assert_eq!(digest_of(&text(&vectors, "syncGcBody")), gc_hash);
    assert_eq!(
        text(&vectors, "syncGcMessage"),
        format!("ostia-server/sync-gc/v1\n{device_id}\n{stamp}\n{if_match}\n{gc_hash}")
    );
    assert_eq!(
        sign_stamped(
            &keys,
            StampedKind::SyncGc,
            &device_id,
            stamp,
            &[&if_match, &gc_hash]
        ),
        text(&vectors, "syncGcSignature")
    );
}

#[test]
fn sva_c60_signs_the_slot_bound_wrap_read_and_the_version_and_body_bound_manifest_push_exactly_as_the_vector()
 {
    let vectors = vectors();
    let keys = vector_keys(&vectors);
    let device_id = text(&vectors, "deviceId");
    let stamp = stamp_of(&vectors);
    let slot = text(&vectors, "wrapSlot");
    let if_match = if_match_of(&vectors);

    assert_eq!(
        text(&vectors, "wrapReadMessage"),
        format!("ostia-server/wrap-read/v1\n{device_id}\n{stamp}\n{slot}")
    );
    assert_eq!(
        sign_stamped(&keys, StampedKind::WrapRead, &device_id, stamp, &[&slot]),
        text(&vectors, "wrapReadSignature")
    );

    let body = text(&vectors, "manifestBody");
    let body_hash = text(&vectors, "manifestBodyHash");
    assert_eq!(digest_of(&body), body_hash);
    assert_eq!(
        text(&vectors, "manifestPutMessage"),
        format!("ostia-server/manifest-put/v1\n{device_id}\n{stamp}\n{if_match}\n{body_hash}")
    );
    assert_eq!(
        sign_stamped(
            &keys,
            StampedKind::ManifestPut,
            &device_id,
            stamp,
            &[&if_match, &digest_of(&body)]
        ),
        text(&vectors, "manifestPutSignature")
    );
}

#[test]
fn sva_c61_signs_a_different_message_for_another_slot_version_body_device_or_time() {
    let vectors = vectors();
    let keys = vector_keys(&vectors);
    let device_id = text(&vectors, "deviceId");
    let stamp = stamp_of(&vectors);
    let body = text(&vectors, "manifestBody");
    let wrap_signature = text(&vectors, "wrapReadSignature");
    let put_signature = text(&vectors, "manifestPutSignature");

    let wrap = |id: &str, stamp: i64, slot: &str| {
        sign_stamped(&keys, StampedKind::WrapRead, id, stamp, &[slot])
    };
    let put = |id: &str, stamp: i64, if_match: &str, body: &str| {
        sign_stamped(
            &keys,
            StampedKind::ManifestPut,
            id,
            stamp,
            &[if_match, &digest_of(body)],
        )
    };

    assert_ne!(wrap(&device_id, stamp, "recovery"), wrap_signature);
    assert_ne!(wrap(&device_id, stamp + 1, "passphrase"), wrap_signature);
    assert_ne!(wrap("other", stamp, "passphrase"), wrap_signature);
    assert_ne!(put(&device_id, stamp, "4", &body), put_signature);
    assert_ne!(
        put(&device_id, stamp, "3", &format!("{body} ")),
        put_signature
    );
    assert_ne!(put(&device_id, stamp + 1, "3", &body), put_signature);
    assert_ne!(put("other", stamp, "3", &body), put_signature);
    assert_ne!(put(&device_id, stamp, "3", &body), wrap_signature);
}

#[test]
fn sva_c3_keeps_a_generated_pair_across_a_seed_round_trip() {
    let keys = generate_device_keys();
    let seeds = seeds_of(&keys);
    let again = keys_from_seeds(&seeds).expect("a generated pair round-trips");
    assert_eq!(registration_of(&again), registration_of(&keys));
    let seeds_again = seeds_of(&again);
    assert_eq!(seeds_again.sign, seeds.sign);
    assert_eq!(seeds_again.box_seed, seeds.box_seed);
    assert_ne!(
        registration_of(&generate_device_keys()).sign_pub,
        registration_of(&keys).sign_pub
    );
}

#[test]
fn sva_c4_refuses_a_seed_of_the_wrong_length() {
    assert!(
        keys_from_seeds(&DeviceSeeds {
            sign: vec![0; 31],
            box_seed: vec![0; 32]
        })
        .is_none()
    );
    assert!(
        keys_from_seeds(&DeviceSeeds {
            sign: vec![0; 32],
            box_seed: vec![0; 33]
        })
        .is_none()
    );
}

#[test]
fn serializes_a_registration_with_the_wire_names_in_the_ts_order() {
    let vectors = vectors();
    let registration = registration_of(&vector_keys(&vectors));
    let sent = serde_json::to_string(&registration).unwrap();
    assert_eq!(
        sent,
        format!(
            "{{\"signPub\":\"{}\",\"boxPub\":\"{}\",\"proof\":\"{}\"}}",
            registration.sign_pub, registration.box_pub, registration.proof
        )
    );
}

#[test]
fn hashes_a_body_as_unpadded_url_safe_sha256_of_its_utf8_bytes() {
    assert_eq!(digest_of(""), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
    assert_eq!(
        digest_of("é"),
        URL_SAFE_NO_PAD.encode(<sha2::Sha256 as sha2::Digest>::digest("é".as_bytes()))
    );
}

#[test]
fn keeps_the_private_keys_out_of_its_debug_text() {
    let vectors = vectors();
    let keys = vector_keys(&vectors);
    let shown = format!("{keys:?}");
    let sign_seed = text(&vectors, "signSeed");
    assert!(!shown.contains(&sign_seed), "{shown}");
    let seeds = seeds_of(&keys);
    let shown_seeds = format!("{seeds:?}");
    assert!(!shown_seeds.contains(&sign_seed), "{shown_seeds}");
    assert!(
        !shown_seeds.contains(&format!("{:?}", seeds.sign)),
        "{shown_seeds}"
    );
}
