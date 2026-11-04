#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ostia_base::host::{Host, Platform};
use ostia_gateway::cert::{GatewayCert, GatewayCerts};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const RSA_ENCRYPTION_OID: [u8; 9] = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

fn host_in(dir: &TempDir) -> Host {
    let env: BTreeMap<String, String> = [(
        "XDG_DATA_HOME".to_owned(),
        dir.path().to_string_lossy().into_owned(),
    )]
    .into_iter()
    .collect();
    Host {
        env,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        platform: Platform::Linux,
    }
}

fn pem_body(pem: &str) -> Vec<u8> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    STANDARD.decode(body).unwrap()
}

fn fingerprint_of(cert_pem: &str) -> String {
    format!(
        "sha256/{}",
        STANDARD.encode(Sha256::digest(pem_body(cert_pem)))
    )
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn made(dir: &TempDir) -> (GatewayCerts, GatewayCert) {
    let certs = GatewayCerts::for_host(host_in(dir));
    let cert = certs.get_in(&dir.path().join("gateway")).unwrap();
    (certs, cert)
}

#[test]
fn makes_a_certificate_and_a_key_in_a_private_folder() {
    let dir = TempDir::new().unwrap();
    let (_, cert) = made(&dir);
    let gateway = dir.path().join("gateway");
    assert!(cert.cert.starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(cert.key.contains("PRIVATE KEY"));
    assert_eq!(mode(&gateway), 0o700);
    assert_eq!(mode(&gateway.join("cert.pem")), 0o600);
    assert_eq!(mode(&gateway.join("key.pem")), 0o600);
    assert_eq!(
        fs::read_to_string(gateway.join("cert.pem")).unwrap(),
        cert.cert
    );
    assert_eq!(
        fs::read_to_string(gateway.join("key.pem")).unwrap(),
        cert.key
    );
}

#[test]
fn names_the_certificate_by_the_sha256_of_its_der_in_base64() {
    let dir = TempDir::new().unwrap();
    let (_, cert) = made(&dir);
    assert!(cert.fingerprint.starts_with("sha256/"));
    assert_eq!(cert.fingerprint, fingerprint_of(&cert.cert));
}

#[test]
fn makes_an_rsa_2048_certificate_for_the_common_name_ostia_gateway() {
    let dir = TempDir::new().unwrap();
    let (_, cert) = made(&dir);
    let der = pem_body(&cert.cert);
    assert!(contains(&der, b"ostia-gateway"));
    assert!(contains(&der, &RSA_ENCRYPTION_OID));
    let key = pem_body(&cert.key);
    assert!((1100..1400).contains(&key.len()), "{}", key.len());
}

#[test]
fn reads_back_the_same_certificate_from_the_files_it_made() {
    let dir = TempDir::new().unwrap();
    let (_, first) = made(&dir);
    let again = GatewayCerts::for_host(host_in(&dir))
        .get_in(&dir.path().join("gateway"))
        .unwrap();
    assert_eq!(again, first);
}

#[test]
fn tightens_the_modes_of_a_folder_and_files_it_finds() {
    let dir = TempDir::new().unwrap();
    let (_, cert) = made(&dir);
    let gateway = dir.path().join("gateway");
    fs::set_permissions(&gateway, fs::Permissions::from_mode(0o755)).unwrap();
    for name in ["cert.pem", "key.pem"] {
        fs::set_permissions(gateway.join(name), fs::Permissions::from_mode(0o644)).unwrap();
    }
    let again = GatewayCerts::for_host(host_in(&dir))
        .get_in(&gateway)
        .unwrap();
    assert_eq!(again, cert);
    assert_eq!(mode(&gateway), 0o700);
    assert_eq!(mode(&gateway.join("cert.pem")), 0o600);
    assert_eq!(mode(&gateway.join("key.pem")), 0o600);
}

#[test]
fn makes_a_new_pair_when_only_one_of_the_two_files_exists() {
    let dir = TempDir::new().unwrap();
    let (_, first) = made(&dir);
    let gateway = dir.path().join("gateway");
    fs::remove_file(gateway.join("key.pem")).unwrap();
    let second = GatewayCerts::for_host(host_in(&dir))
        .get_in(&gateway)
        .unwrap();
    assert_ne!(second.fingerprint, first.fingerprint);
    assert_ne!(second.key, first.key);
    assert_eq!(
        fs::read_to_string(gateway.join("key.pem")).unwrap(),
        second.key
    );
    assert_eq!(
        fs::read_to_string(gateway.join("cert.pem")).unwrap(),
        second.cert
    );
}

#[test]
fn refuses_a_stored_certificate_that_is_not_a_certificate_and_leaves_the_files_alone() {
    let dir = TempDir::new().unwrap();
    made(&dir);
    let gateway = dir.path().join("gateway");
    fs::write(gateway.join("cert.pem"), "not a certificate").unwrap();
    let key_before = fs::read(gateway.join("key.pem")).unwrap();
    assert!(
        GatewayCerts::for_host(host_in(&dir))
            .get_in(&gateway)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(gateway.join("cert.pem")).unwrap(),
        "not a certificate"
    );
    assert_eq!(fs::read(gateway.join("key.pem")).unwrap(), key_before);
}

#[tokio::test]
async fn keeps_the_certificate_of_the_app_folder_in_memory_after_the_first_call() {
    let dir = TempDir::new().unwrap();
    let certs = GatewayCerts::for_host(host_in(&dir));
    let first = certs.get().await.unwrap();
    assert!(
        dir.path()
            .join("ostia-rs")
            .join("gateway")
            .join("cert.pem")
            .exists()
    );
    fs::remove_dir_all(dir.path().join("ostia-rs").join("gateway")).unwrap();
    let second = certs.get().await.unwrap();
    assert_eq!(second, first);
    assert!(!dir.path().join("ostia-rs").join("gateway").exists());
}

#[test]
fn does_not_keep_the_certificate_of_a_folder_it_was_given() {
    let dir = TempDir::new().unwrap();
    let certs = GatewayCerts::for_host(host_in(&dir));
    let gateway = dir.path().join("elsewhere");
    let first = certs.get_in(&gateway).unwrap();
    fs::remove_dir_all(&gateway).unwrap();
    let second = certs.get_in(&gateway).unwrap();
    assert_ne!(second.fingerprint, first.fingerprint);
}

#[tokio::test]
async fn does_not_let_a_folder_it_was_given_fill_the_memory_of_the_app_folder() {
    let dir = TempDir::new().unwrap();
    let certs = GatewayCerts::for_host(host_in(&dir));
    let other = certs.get_in(&dir.path().join("elsewhere")).unwrap();
    let app = certs.get().await.unwrap();
    assert_ne!(app.fingerprint, other.fingerprint);
}

#[test]
fn refuses_a_stored_certificate_whose_envelope_is_right_but_whose_bytes_are_not_x509() {
    let dir = TempDir::new().unwrap();
    made(&dir);
    let gateway = dir.path().join("gateway");
    fs::write(
        gateway.join("cert.pem"),
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    )
    .unwrap();
    assert!(
        GatewayCerts::for_host(host_in(&dir))
            .get_in(&gateway)
            .is_err()
    );
}

#[tokio::test]
async fn makes_one_pair_when_two_callers_ask_at_once() {
    let dir = TempDir::new().unwrap();
    let certs = GatewayCerts::for_host(host_in(&dir));
    let (first, second) = tokio::join!(certs.get(), certs.get());
    assert_eq!(first.unwrap(), second.unwrap());
}
