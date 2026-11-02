use aes::Aes128;
use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const SALT: &[u8] = b"saltysalt";
const IV: [u8; 16] = [b' '; 16];
const KEY_LEN: usize = 16;
const PREFIX_LEN: usize = 3;
const LINUX_ITERATIONS: u32 = 1;
const MAC_ITERATIONS: u32 = 1003;
const LINUX_FALLBACK_PASSWORD: &[u8] = b"peanuts";

#[derive(Debug, thiserror::Error)]
pub enum OsCryptError {
    #[error("value is not base64")]
    NotBase64(#[from] base64::DecodeError),
    #[error("value is shorter than the 3 byte prefix")]
    TooShort,
    #[error("prefix {0:?} is not v10 or v11")]
    UnknownPrefix(String),
    #[error("prefix {0} has no key on this platform")]
    NoKeyForPrefix(&'static str),
    #[error("ciphertext does not decrypt with this key")]
    BadCiphertext,
    #[error("plaintext is not UTF-8")]
    NotUtf8(#[from] std::string::FromUtf8Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefix {
    V10,
    V11,
}

impl Prefix {
    fn tag(self) -> &'static [u8; PREFIX_LEN] {
        match self {
            Prefix::V10 => b"v10",
            Prefix::V11 => b"v11",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Prefix::V10 => "v10",
            Prefix::V11 => "v11",
        }
    }
}

pub struct Keys {
    v10: Option<[u8; KEY_LEN]>,
    v11: Option<[u8; KEY_LEN]>,
}

impl Keys {
    pub fn linux(keyring_password: Option<&[u8]>) -> Self {
        Self {
            v10: Some(derive_key(LINUX_FALLBACK_PASSWORD, LINUX_ITERATIONS)),
            v11: keyring_password.map(|password| derive_key(password, LINUX_ITERATIONS)),
        }
    }

    pub fn mac(keychain_password: &[u8]) -> Self {
        Self {
            v10: Some(derive_key(keychain_password, MAC_ITERATIONS)),
            v11: None,
        }
    }

    pub fn key(&self, prefix: Prefix) -> Result<&[u8; KEY_LEN], OsCryptError> {
        let slot = match prefix {
            Prefix::V10 => &self.v10,
            Prefix::V11 => &self.v11,
        };
        slot.as_ref()
            .ok_or(OsCryptError::NoKeyForPrefix(prefix.name()))
    }
}

fn derive_key(password: &[u8], iterations: u32) -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, SALT, iterations, &mut key);
    key
}

pub fn open_base64(stored: &str, keys: &Keys) -> Result<String, OsCryptError> {
    open(&STANDARD.decode(stored)?, keys)
}

pub fn open(blob: &[u8], keys: &Keys) -> Result<String, OsCryptError> {
    if blob.len() < PREFIX_LEN {
        return Err(OsCryptError::TooShort);
    }
    let (tag, ciphertext) = blob.split_at(PREFIX_LEN);
    let prefix = match tag {
        b"v10" => Prefix::V10,
        b"v11" => Prefix::V11,
        other => {
            return Err(OsCryptError::UnknownPrefix(
                String::from_utf8_lossy(other).into_owned(),
            ));
        }
    };
    let key = keys.key(prefix)?;
    let plain = cbc::Decryptor::<Aes128>::new_from_slices(key, &IV)
        .map_err(|_| OsCryptError::BadCiphertext)?
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| OsCryptError::BadCiphertext)?;
    Ok(String::from_utf8(plain)?)
}

pub fn seal_base64(prefix: Prefix, plain: &str, keys: &Keys) -> Result<String, OsCryptError> {
    Ok(STANDARD.encode(seal(prefix, plain, keys)?))
}

pub fn seal(prefix: Prefix, plain: &str, keys: &Keys) -> Result<Vec<u8>, OsCryptError> {
    let key = keys.key(prefix)?;
    let ciphertext = cbc::Encryptor::<Aes128>::new_from_slices(key, &IV)
        .map_err(|_| OsCryptError::BadCiphertext)?
        .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    let mut blob = prefix.tag().to_vec();
    blob.extend(ciphertext);
    Ok(blob)
}
