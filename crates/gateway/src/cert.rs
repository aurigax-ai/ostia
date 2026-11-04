use std::fmt;
use std::fs::{self, DirBuilder, OpenOptions, Permissions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ostia_base::error::io_error;
use ostia_base::{Error, Host, Result};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_RSA_SHA256};
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use tokio::sync::OnceCell;
use x509_parser::parse_x509_certificate;

const CERT_LIFETIME_MS: i64 = 10 * 365 * 24 * 60 * 60 * 1000;
const COMMON_NAME: &str = "ostia-gateway";
const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

#[derive(Clone, PartialEq, Eq)]
pub struct GatewayCert {
    pub cert: String,
    pub key: String,
    pub fingerprint: String,
}

impl fmt::Debug for GatewayCert {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GatewayCert")
            .field("cert", &self.cert)
            .field("key", &"<hidden>")
            .field("fingerprint", &self.fingerprint)
            .finish()
    }
}

#[derive(Clone)]
pub struct GatewayCerts {
    host: Host,
    cached: Arc<OnceCell<GatewayCert>>,
}

fn invalid(path: &Path, reason: impl ToString) -> Error {
    io_error(path)(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        reason.to_string(),
    ))
}

fn fingerprint_of(path: &Path, cert_pem: &str) -> Result<String> {
    let der = CertificateDer::from_pem_slice(cert_pem.as_bytes())
        .map_err(|source| invalid(path, source))?;
    let bytes: &[u8] = der.as_ref();
    parse_x509_certificate(bytes).map_err(|source| invalid(path, source))?;
    Ok(format!(
        "sha256/{}",
        STANDARD.encode(Sha256::digest(bytes).as_slice())
    ))
}

fn generate(path: &Path) -> Result<(String, String)> {
    let key = KeyPair::generate_for(&PKCS_RSA_SHA256).map_err(|source| invalid(path, source))?;
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, COMMON_NAME);
    let now = OffsetDateTime::now_utc();
    let mut params = CertificateParams::default();
    params.distinguished_name = name;
    params.not_before = now;
    params.not_after = now + Duration::milliseconds(CERT_LIFETIME_MS);
    let cert = params
        .self_signed(&key)
        .map_err(|source| invalid(path, source))?;
    Ok((cert.pem(), key.serialize_pem()))
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(FILE_MODE)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .map_err(io_error(path))?;
    fs::set_permissions(path, Permissions::from_mode(FILE_MODE)).map_err(io_error(path))
}

fn load_or_make(dir: &Path) -> Result<GatewayCert> {
    DirBuilder::new()
        .recursive(true)
        .mode(DIR_MODE)
        .create(dir)
        .map_err(io_error(dir))?;
    fs::set_permissions(dir, Permissions::from_mode(DIR_MODE)).map_err(io_error(dir))?;
    let cert_path: PathBuf = dir.join("cert.pem");
    let key_path: PathBuf = dir.join("key.pem");
    if cert_path.exists() && key_path.exists() {
        let cert = fs::read_to_string(&cert_path).map_err(io_error(&cert_path))?;
        let key = fs::read_to_string(&key_path).map_err(io_error(&key_path))?;
        fs::set_permissions(&cert_path, Permissions::from_mode(FILE_MODE))
            .map_err(io_error(&cert_path))?;
        fs::set_permissions(&key_path, Permissions::from_mode(FILE_MODE))
            .map_err(io_error(&key_path))?;
        let fingerprint = fingerprint_of(&cert_path, &cert)?;
        return Ok(GatewayCert {
            cert,
            key,
            fingerprint,
        });
    }
    let (cert, key) = generate(&cert_path)?;
    write_private(&cert_path, &cert)?;
    write_private(&key_path, &key)?;
    let fingerprint = fingerprint_of(&cert_path, &cert)?;
    Ok(GatewayCert {
        cert,
        key,
        fingerprint,
    })
}

impl GatewayCerts {
    pub fn for_host(host: Host) -> Self {
        Self {
            host,
            cached: Arc::new(OnceCell::new()),
        }
    }

    pub async fn get(&self) -> Result<GatewayCert> {
        let dir = self.host.app_data_dir().join("gateway");
        self.cached
            .get_or_try_init(|| async move {
                tokio::task::spawn_blocking(move || load_or_make(&dir))
                    .await
                    .map_err(|error| Error::Task(error.to_string()))?
            })
            .await
            .cloned()
    }

    pub fn get_in(&self, dir: &Path) -> Result<GatewayCert> {
        load_or_make(dir)
    }
}
