#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_sandbox::packages::{
    Ecosystem, PackageRef, REGISTRY_HOSTS, package_key, package_version_key, parse_package_download,
};

fn pkg(ecosystem: Ecosystem, name: &str, version: &str) -> PackageRef {
    PackageRef {
        ecosystem,
        name: name.to_owned(),
        version: version.to_owned(),
    }
}

#[test]
fn builds_the_package_key_and_the_version_key() {
    let serde = pkg(Ecosystem::CratesIo, "serde", "1.0.200");
    assert_eq!(package_key(&serde), "crates.io:serde");
    assert_eq!(package_version_key(&serde), "crates.io:serde@1.0.200");
    assert_eq!(
        package_version_key(&pkg(Ecosystem::PyPi, "requests", "2.32.3")),
        "PyPI:requests@2.32.3"
    );
    assert_eq!(
        package_version_key(&pkg(Ecosystem::Go, "github.com/BurntSushi/toml", "v1.3.2")),
        "Go:github.com/BurntSushi/toml@v1.3.2"
    );
    assert_eq!(
        package_version_key(&pkg(Ecosystem::Npm, "left-pad", "1.3.0")),
        "npm:left-pad@1.3.0"
    );
}

#[test]
fn names_the_ecosystem_the_way_osv_does() {
    assert_eq!(Ecosystem::Npm.as_str(), "npm");
    assert_eq!(Ecosystem::PyPi.as_str(), "PyPI");
    assert_eq!(Ecosystem::CratesIo.as_str(), "crates.io");
    assert_eq!(Ecosystem::Go.as_str(), "Go");
}

#[test]
fn lists_the_registry_hosts() {
    assert_eq!(
        REGISTRY_HOSTS,
        [
            "registry.npmjs.org",
            "files.pythonhosted.org",
            "static.crates.io",
            "crates.io",
            "proxy.golang.org",
        ]
    );
}

#[test]
fn reads_the_crates_io_api_download_url() {
    assert_eq!(
        parse_package_download("https://crates.io/api/v1/crates/serde/1.0.200/download"),
        Some(pkg(Ecosystem::CratesIo, "serde", "1.0.200"))
    );
    assert_eq!(
        parse_package_download("https://crates.io/api/v1/crates/serde/download"),
        None
    );
}

#[test]
fn reads_a_python_wheel_and_an_sdist_with_every_archive_type() {
    let cases = [
        (
            "https://files.pythonhosted.org/packages/a/b/My_Pkg.Name-1.2-py3-none-any.whl",
            Some(pkg(Ecosystem::PyPi, "my-pkg-name", "1.2")),
        ),
        (
            "https://files.pythonhosted.org/packages/a/b/demo-1.0.zip",
            Some(pkg(Ecosystem::PyPi, "demo", "1.0")),
        ),
        (
            "https://files.pythonhosted.org/packages/a/b/demo-pkg-3.4.5.tar.bz2",
            Some(pkg(Ecosystem::PyPi, "demo-pkg", "3.4.5")),
        ),
        (
            "https://files.pythonhosted.org/packages/a/b/readme.txt",
            None,
        ),
        ("https://files.pythonhosted.org/packages/a/b/", None),
    ];
    for (url, expected) in cases {
        assert_eq!(parse_package_download(url), expected, "{url}");
    }
}

#[test]
fn refuses_an_npm_tarball_whose_file_name_does_not_start_with_the_package_name() {
    let cases = [
        "https://registry.npmjs.org/left-pad/-/other-1.3.0.tgz",
        "https://registry.npmjs.org/@scope/pkg/-/other-2.0.0.tgz",
        "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.zip",
    ];
    for url in cases {
        assert_eq!(parse_package_download(url), None, "{url}");
    }
}

#[test]
fn refuses_a_crate_file_whose_name_differs_from_its_folder() {
    assert_eq!(
        parse_package_download("https://static.crates.io/crates/serde/other-1.0.200.crate"),
        None
    );
}

#[test]
fn reads_a_go_module_path_with_escaped_capitals() {
    assert_eq!(
        parse_package_download("https://proxy.golang.org/golang.org/x/net/@v/v0.20.0.zip"),
        Some(pkg(Ecosystem::Go, "golang.org/x/net", "v0.20.0"))
    );
    assert_eq!(
        parse_package_download("https://proxy.golang.org/golang.org/x/net/@v/v0.20.0.info"),
        None
    );
}

#[test]
fn returns_nothing_for_text_that_is_not_a_url() {
    assert_eq!(parse_package_download("not a url"), None);
    assert_eq!(parse_package_download(""), None);
}
