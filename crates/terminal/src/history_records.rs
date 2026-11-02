use std::io::{Read, Write};

use aes_gcm::aead::Aead;
use aes_gcm::aead::consts::U12;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use ostia_base::random::random_bytes;

pub const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

pub type HistoryKey = [u8; KEY_BYTES];

#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    #[error("the history record is too short")]
    Short,
    #[error("the history record did not pass authentication")]
    Authentication,
    #[error("the history record could not be deflated: {0}")]
    Deflate(std::io::Error),
    #[error("the history record could not be inflated: {0}")]
    Inflate(std::io::Error),
}

pub fn new_history_key() -> HistoryKey {
    random_bytes::<KEY_BYTES>()
}

fn cipher(key: &HistoryKey) -> Aes256Gcm {
    Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key))
}

pub fn seal_lines(key: &HistoryKey, lines: &[String]) -> Result<Vec<u8>, RecordError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(lines.join("\n").as_bytes())
        .map_err(RecordError::Deflate)?;
    let packed = encoder.finish().map_err(RecordError::Deflate)?;
    let nonce_bytes = random_bytes::<NONCE_BYTES>();
    let sealed = cipher(key)
        .encrypt(&Nonce::<U12>::from(nonce_bytes), packed.as_slice())
        .map_err(|_| RecordError::Authentication)?;
    let mut record = Vec::with_capacity(NONCE_BYTES + sealed.len());
    record.extend_from_slice(&nonce_bytes);
    record.extend_from_slice(&sealed);
    Ok(record)
}

pub fn open_lines(key: &HistoryKey, record: &[u8]) -> Result<Vec<String>, RecordError> {
    if record.len() < NONCE_BYTES + TAG_BYTES {
        return Err(RecordError::Short);
    }
    let (nonce_bytes, sealed) = record.split_at(NONCE_BYTES);
    let nonce_array: [u8; NONCE_BYTES] = nonce_bytes.try_into().map_err(|_| RecordError::Short)?;
    let packed = cipher(key)
        .decrypt(&Nonce::<U12>::from(nonce_array), sealed)
        .map_err(|_| RecordError::Authentication)?;
    let mut text = Vec::new();
    DeflateDecoder::new(packed.as_slice())
        .read_to_end(&mut text)
        .map_err(RecordError::Inflate)?;
    Ok(String::from_utf8_lossy(&text)
        .split('\n')
        .map(ToString::to_string)
        .collect())
}
