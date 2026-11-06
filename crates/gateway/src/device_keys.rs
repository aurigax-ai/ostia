use std::fmt;

use aws_lc_rs::agreement::{PrivateKey, X25519};
use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ostia_base::random::random_bytes;
use serde::Serialize;
use sha2::{Digest, Sha256};

const SEED_BYTES: usize = 32;
const REGISTER_CONTEXT: &str = "ostia-server/register/v1";
const CHALLENGE_CONTEXT: &str = "ostia-server/auth/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StampedKind {
    WrapRead,
    ManifestPut,
    SyncRotate,
    SyncGc,
}

impl StampedKind {
    fn context(self) -> &'static str {
        match self {
            Self::WrapRead => "ostia-server/wrap-read/v1",
            Self::ManifestPut => "ostia-server/manifest-put/v1",
            Self::SyncRotate => "ostia-server/sync-rotate/v1",
            Self::SyncGc => "ostia-server/sync-gc/v1",
        }
    }
}

pub struct DeviceSeeds {
    pub sign: Vec<u8>,
    pub box_seed: Vec<u8>,
}

impl fmt::Debug for DeviceSeeds {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeviceSeeds")
            .finish_non_exhaustive()
    }
}

pub struct DeviceKeys {
    sign_pair: Ed25519KeyPair,
    sign_seed: [u8; SEED_BYTES],
    box_seed: [u8; SEED_BYTES],
    box_public: Vec<u8>,
}

impl fmt::Debug for DeviceKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("DeviceKeys").finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub sign_pub: String,
    pub box_pub: String,
    pub proof: String,
}

pub fn keys_from_seeds(seeds: &DeviceSeeds) -> Option<DeviceKeys> {
    let sign_seed: [u8; SEED_BYTES] = seeds.sign.as_slice().try_into().ok()?;
    let box_seed: [u8; SEED_BYTES] = seeds.box_seed.as_slice().try_into().ok()?;
    let sign_pair = Ed25519KeyPair::from_seed_unchecked(&sign_seed).ok()?;
    let box_private = PrivateKey::from_private_key(&X25519, &box_seed).ok()?;
    let box_public = box_private.compute_public_key().ok()?.as_ref().to_vec();
    Some(DeviceKeys {
        sign_pair,
        sign_seed,
        box_seed,
        box_public,
    })
}

pub fn generate_device_keys() -> DeviceKeys {
    loop {
        let seeds = DeviceSeeds {
            sign: random_bytes::<SEED_BYTES>().to_vec(),
            box_seed: random_bytes::<SEED_BYTES>().to_vec(),
        };
        if let Some(keys) = keys_from_seeds(&seeds) {
            return keys;
        }
    }
}

pub fn seeds_of(keys: &DeviceKeys) -> DeviceSeeds {
    DeviceSeeds {
        sign: keys.sign_seed.to_vec(),
        box_seed: keys.box_seed.to_vec(),
    }
}

fn sign_text(keys: &DeviceKeys, message: &str) -> String {
    URL_SAFE_NO_PAD.encode(keys.sign_pair.sign(message.as_bytes()))
}

pub fn registration_of(keys: &DeviceKeys) -> Registration {
    let sign_pub = URL_SAFE_NO_PAD.encode(keys.sign_pair.public_key());
    let box_pub = URL_SAFE_NO_PAD.encode(&keys.box_public);
    let proof = sign_text(keys, &format!("{REGISTER_CONTEXT}\n{sign_pub}\n{box_pub}"));
    Registration {
        sign_pub,
        box_pub,
        proof,
    }
}

pub fn digest_of(body: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(body.as_bytes()))
}

pub fn sign_challenge(keys: &DeviceKeys, device_id: &str, nonce: &str) -> String {
    sign_text(keys, &format!("{CHALLENGE_CONTEXT}\n{device_id}\n{nonce}"))
}

pub fn sign_stamped(
    keys: &DeviceKeys,
    kind: StampedKind,
    device_id: &str,
    stamp: i64,
    bound: &[&str],
) -> String {
    let mut lines = vec![
        kind.context().to_owned(),
        device_id.to_owned(),
        stamp.to_string(),
    ];
    lines.extend(bound.iter().map(|line| (*line).to_owned()));
    sign_text(keys, &lines.join("\n"))
}
