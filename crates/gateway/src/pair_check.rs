use sha2::{Digest, Sha256};

const DIGITS: u32 = 1_000_000;

pub fn check_code(
    fingerprint: &str,
    pubkey: &str,
    phone_nonce: &[u8],
    desktop_nonce: &[u8],
) -> String {
    let digest = Sha256::new()
        .chain_update(fingerprint.as_bytes())
        .chain_update([0u8])
        .chain_update(pubkey.as_bytes())
        .chain_update([0u8])
        .chain_update(phone_nonce)
        .chain_update(desktop_nonce)
        .finalize();
    let bytes = digest.as_slice();
    let head = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    format!("{:06}", head % DIGITS)
}

pub fn commit_of(nonce: &[u8]) -> String {
    hex::encode(Sha256::digest(nonce).as_slice())
}
