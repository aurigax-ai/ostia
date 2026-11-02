#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use ostia_sandbox::package_policy::{
    MalwareCheck, PackageBlockReason, PackageDecision, PackageLookups, PackagePolicy,
    decide_package,
};
use ostia_sandbox::packages::{Ecosystem, PackageRef, parse_package_download};

const NOW: i64 = 1_790_769_600_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

struct Lookups {
    malware: MalwareCheck,
    published_at: Option<i64>,
}

fn lookups() -> Lookups {
    Lookups {
        malware: MalwareCheck::Clean,
        published_at: Some(NOW - 400 * DAY),
    }
}

impl PackageLookups for Lookups {
    fn malware(&self, _pkg: &PackageRef) -> BoxFuture<'static, MalwareCheck> {
        let check = self.malware;
        async move { check }.boxed()
    }

    fn published_at(&self, _pkg: &PackageRef) -> BoxFuture<'static, Option<i64>> {
        let at = self.published_at;
        async move { at }.boxed()
    }
}

fn policy() -> PackagePolicy {
    PackagePolicy {
        malware: true,
        cooldown_days: 2,
        deny_list: Vec::new(),
        allow_only: None,
        allowances: Vec::new(),
    }
}

fn pkg() -> PackageRef {
    PackageRef {
        ecosystem: Ecosystem::Npm,
        name: "fresh-pkg".to_owned(),
        version: "1.0.0".to_owned(),
    }
}

fn blocked(reason: PackageBlockReason) -> PackageDecision {
    PackageDecision::Block(reason)
}

#[test]
fn reads_ecosystem_name_and_version_from_registry_download_urls() {
    let cases = [
        (
            "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
            Some((Ecosystem::Npm, "left-pad", "1.3.0")),
        ),
        (
            "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz",
            Some((Ecosystem::Npm, "@scope/pkg", "2.0.0-beta.1")),
        ),
        (
            "https://files.pythonhosted.org/packages/ab/cd/ef/requests-2.32.3-py3-none-any.whl",
            Some((Ecosystem::PyPi, "requests", "2.32.3")),
        ),
        (
            "https://files.pythonhosted.org/packages/ab/cd/ef/evil_pkg-1.0.0.tar.gz",
            Some((Ecosystem::PyPi, "evil-pkg", "1.0.0")),
        ),
        (
            "https://static.crates.io/crates/serde/serde-1.0.200.crate",
            Some((Ecosystem::CratesIo, "serde", "1.0.200")),
        ),
        (
            "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.3.2.zip",
            Some((Ecosystem::Go, "github.com/BurntSushi/toml", "v1.3.2")),
        ),
        ("https://registry.npmjs.org/left-pad", None),
        ("https://example.com/left-pad-1.0.0.tgz", None),
    ];
    for (url, expected) in cases {
        let expected = expected.map(|(ecosystem, name, version)| PackageRef {
            ecosystem,
            name: name.to_owned(),
            version: version.to_owned(),
        });
        assert_eq!(parse_package_download(url), expected, "{url}");
    }
}

#[tokio::test]
async fn sbx_c81_denies_a_version_younger_than_the_cooldown() {
    let young = Lookups {
        published_at: Some(NOW - HOUR),
        ..lookups()
    };
    let decision = decide_package(&pkg(), &policy(), &young, NOW).await;
    assert_eq!(decision, blocked(PackageBlockReason::Cooldown));
}

#[tokio::test]
async fn sbx_c82_denies_a_version_with_a_malware_record() {
    let evil = PackageRef {
        ecosystem: Ecosystem::PyPi,
        name: "evil-pkg".to_owned(),
        version: "1.0.0".to_owned(),
    };
    let flagged = Lookups {
        malware: MalwareCheck::Malicious,
        ..lookups()
    };
    let decision = decide_package(&evil, &policy(), &flagged, NOW).await;
    assert_eq!(decision, blocked(PackageBlockReason::Malware));
}

#[tokio::test]
async fn sbx_c83_denies_when_osv_cannot_be_reached() {
    let offline = Lookups {
        malware: MalwareCheck::Unavailable,
        ..lookups()
    };
    let decision = decide_package(&pkg(), &policy(), &offline, NOW).await;
    assert_eq!(decision, blocked(PackageBlockReason::OsvUnavailable));
}

#[tokio::test]
async fn honours_the_deny_list_the_allow_only_list_and_allowances() {
    let old = lookups();
    assert_eq!(
        decide_package(
            &pkg(),
            &PackagePolicy {
                deny_list: vec!["npm:fresh-pkg".to_owned()],
                ..policy()
            },
            &old,
            NOW
        )
        .await,
        blocked(PackageBlockReason::DenyList)
    );
    assert_eq!(
        decide_package(
            &pkg(),
            &PackagePolicy {
                allow_only: Some(vec!["npm:other".to_owned()]),
                ..policy()
            },
            &old,
            NOW
        )
        .await,
        blocked(PackageBlockReason::NotAllowed)
    );
    let young = Lookups {
        published_at: Some(NOW - HOUR),
        ..lookups()
    };
    assert_eq!(
        decide_package(
            &pkg(),
            &PackagePolicy {
                allowances: vec!["npm:fresh-pkg@1.0.0".to_owned()],
                ..policy()
            },
            &young,
            NOW
        )
        .await,
        PackageDecision::Allow
    );
}

#[tokio::test]
async fn names_each_block_reason_the_way_the_firewall_reports_it() {
    let table = [
        (PackageBlockReason::DenyList, "deny-list"),
        (PackageBlockReason::NotAllowed, "not-allowed"),
        (PackageBlockReason::Malware, "malware"),
        (PackageBlockReason::OsvUnavailable, "osv-unavailable"),
        (PackageBlockReason::Cooldown, "cooldown"),
    ];
    for (reason, text) in table {
        assert_eq!(reason.as_str(), text);
    }
}

#[tokio::test]
async fn checks_the_deny_list_before_the_allow_only_list_and_before_an_allowance() {
    let decision = decide_package(
        &pkg(),
        &PackagePolicy {
            deny_list: vec!["npm:fresh-pkg".to_owned()],
            allow_only: Some(vec!["npm:other".to_owned()]),
            allowances: vec!["npm:fresh-pkg@1.0.0".to_owned()],
            ..policy()
        },
        &lookups(),
        NOW,
    )
    .await;
    assert_eq!(decision, blocked(PackageBlockReason::DenyList));
}

#[tokio::test]
async fn an_allowance_does_not_pass_a_malware_record() {
    let flagged = Lookups {
        malware: MalwareCheck::Malicious,
        ..lookups()
    };
    let decision = decide_package(
        &pkg(),
        &PackagePolicy {
            allowances: vec!["npm:fresh-pkg@1.0.0".to_owned()],
            ..policy()
        },
        &flagged,
        NOW,
    )
    .await;
    assert_eq!(decision, blocked(PackageBlockReason::Malware));
}

#[tokio::test]
async fn an_allowance_passes_when_osv_cannot_be_reached() {
    let offline = Lookups {
        malware: MalwareCheck::Unavailable,
        ..lookups()
    };
    let decision = decide_package(
        &pkg(),
        &PackagePolicy {
            allowances: vec!["npm:fresh-pkg@1.0.0".to_owned()],
            ..policy()
        },
        &offline,
        NOW,
    )
    .await;
    assert_eq!(decision, PackageDecision::Allow);
}

#[tokio::test]
async fn an_allowance_for_another_version_does_not_pass() {
    let young = Lookups {
        published_at: Some(NOW - HOUR),
        ..lookups()
    };
    let decision = decide_package(
        &pkg(),
        &PackagePolicy {
            allowances: vec!["npm:fresh-pkg@2.0.0".to_owned()],
            ..policy()
        },
        &young,
        NOW,
    )
    .await;
    assert_eq!(decision, blocked(PackageBlockReason::Cooldown));
}

#[tokio::test]
async fn skips_the_malware_lookup_when_the_policy_turns_it_off() {
    let flagged = Lookups {
        malware: MalwareCheck::Malicious,
        ..lookups()
    };
    let decision = decide_package(
        &pkg(),
        &PackagePolicy {
            malware: false,
            ..policy()
        },
        &flagged,
        NOW,
    )
    .await;
    assert_eq!(decision, PackageDecision::Allow);
}

#[tokio::test]
async fn skips_the_cooldown_when_it_is_zero_and_allows_an_unknown_publish_time() {
    let young = Lookups {
        published_at: Some(NOW - HOUR),
        ..lookups()
    };
    let no_cooldown = PackagePolicy {
        cooldown_days: 0,
        ..policy()
    };
    assert_eq!(
        decide_package(&pkg(), &no_cooldown, &young, NOW).await,
        PackageDecision::Allow
    );
    let unknown = Lookups {
        published_at: None,
        ..lookups()
    };
    assert_eq!(
        decide_package(&pkg(), &policy(), &unknown, NOW).await,
        PackageDecision::Allow
    );
}

#[tokio::test]
async fn allows_a_version_published_exactly_one_cooldown_ago() {
    let edge = Lookups {
        published_at: Some(NOW - 2 * DAY),
        ..lookups()
    };
    assert_eq!(
        decide_package(&pkg(), &policy(), &edge, NOW).await,
        PackageDecision::Allow
    );
    let inside = Lookups {
        published_at: Some(NOW - 2 * DAY + 1),
        ..lookups()
    };
    assert_eq!(
        decide_package(&pkg(), &policy(), &inside, NOW).await,
        blocked(PackageBlockReason::Cooldown)
    );
}
