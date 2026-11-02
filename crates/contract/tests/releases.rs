#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::cmp::Ordering;

use ostia_contract::releases::{
    ParsedRelease, ReleaseInfo, UpdateChannel, Version, compare_versions, dmg_asset_name,
    is_main_channel_version, is_newer_version, parse_latest_release, parse_update_channel,
    parse_version, pick_beta_release, pick_main_channel_release, tarball_asset_name,
};
use serde_json::{Value, json};

fn version(text: &str) -> Version {
    parse_version(text).unwrap_or_else(|| panic!("not a version: {text}"))
}

fn page(tag: &str) -> String {
    format!("https://github.com/aurigax-ai/ostia/releases/tag/{tag}")
}

fn base_release() -> Value {
    json!({
        "tag_name": "v1.4.0",
        "html_url": page("v1.4.0"),
        "draft": false,
        "prerelease": false
    })
}

fn with(base: Value, key: &str, value: Value) -> Value {
    let mut base = base;
    base[key] = value;
    base
}

fn release(tag: &str) -> Value {
    release_flagged(tag, tag.contains('-'))
}

fn release_flagged(tag: &str, prerelease: bool) -> Value {
    json!({
        "tag_name": tag,
        "html_url": page(tag),
        "draft": false,
        "prerelease": prerelease
    })
}

fn offered(version: &str, tag: &str) -> ParsedRelease {
    ParsedRelease::Release(ReleaseInfo {
        version: version.to_owned(),
        url: page(tag),
        dmg_sha256: None,
    })
}

fn picked_version(parsed: ParsedRelease) -> String {
    match parsed {
        ParsedRelease::Release(release) => release.version,
        other => panic!("nothing offered: {other:?}"),
    }
}

const NOT_STABLE: ParsedRelease = ParsedRelease::NotStable;
const MALFORMED: ParsedRelease = ParsedRelease::Malformed;

#[test]
fn reads_the_numbers_and_the_prerelease_parts_and_ignores_build_metadata() {
    assert_eq!(
        parse_version("1.20.3"),
        Some(Version {
            major: 1,
            minor: 20,
            patch: 3,
            prerelease: vec![]
        })
    );
    assert_eq!(
        parse_version("1.0.0-beta.2+build.7"),
        Some(Version {
            major: 1,
            minor: 0,
            patch: 0,
            prerelease: vec!["beta".to_owned(), "2".to_owned()]
        })
    );
}

#[test]
fn refuses_text_that_is_not_a_semantic_version() {
    for text in [
        "", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", " 1.2.3",
    ] {
        assert_eq!(parse_version(text), None, "text {text:?}");
    }
    assert_eq!(parse_version(&format!("1.2.3-{}", "a".repeat(80))), None);
}

#[test]
fn orders_numerically_not_as_text() {
    let order = |a: &str, b: &str| compare_versions(&version(a), &version(b));
    assert_eq!(order("0.10.0", "0.9.9"), Ordering::Greater);
    assert_eq!(order("1.0.0", "0.99.99"), Ordering::Greater);
    assert_eq!(order("1.2.3", "1.2.10"), Ordering::Less);
    assert_eq!(order("2.0.0", "2.0.0"), Ordering::Equal);
}

#[test]
fn follows_the_semver_precedence_chain_for_prereleases() {
    let chain = [
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-alpha.beta",
        "1.0.0-beta",
        "1.0.0-beta.2",
        "1.0.0-beta.11",
        "1.0.0-rc.1",
        "1.0.0",
    ];
    for pair in chain.windows(2) {
        assert_eq!(
            compare_versions(&version(pair[0]), &version(pair[1])),
            Ordering::Less,
            "{} then {}",
            pair[0],
            pair[1]
        );
        assert_eq!(
            compare_versions(&version(pair[1]), &version(pair[0])),
            Ordering::Greater,
            "{} then {}",
            pair[1],
            pair[0]
        );
    }
}

#[test]
fn treats_versions_that_differ_only_in_build_metadata_as_equal() {
    assert_eq!(
        compare_versions(&version("1.0.0+a"), &version("1.0.0+b")),
        Ordering::Equal
    );
}

#[test]
fn is_true_only_for_a_strictly_newer_version() {
    assert!(is_newer_version("0.3.0", "0.2.0"));
    assert!(!is_newer_version("0.2.0", "0.2.0"));
    assert!(!is_newer_version("0.1.9", "0.2.0"));
    assert!(is_newer_version("1.0.0", "1.0.0-rc.1"));
}

#[test]
fn is_false_when_either_side_is_not_a_version() {
    assert!(!is_newer_version("latest", "0.2.0"));
    assert!(!is_newer_version("9.9.9", "dev"));
}

#[test]
fn returns_the_version_and_the_release_page_of_a_stable_release() {
    assert_eq!(
        parse_latest_release(&base_release()),
        offered("1.4.0", "v1.4.0")
    );
}

#[test]
fn ignores_drafts_prereleases_and_prerelease_tags() {
    assert_eq!(
        parse_latest_release(&with(base_release(), "draft", json!(true))),
        NOT_STABLE
    );
    assert_eq!(
        parse_latest_release(&with(base_release(), "prerelease", json!(true))),
        NOT_STABLE
    );
    let beta = with(
        with(base_release(), "tag_name", json!("v1.4.0-beta.1")),
        "html_url",
        json!(page("v1.4.0-beta.1")),
    );
    assert_eq!(parse_latest_release(&beta), NOT_STABLE);
}

#[test]
fn refuses_a_release_page_that_is_not_https_on_github_com_under_the_repository() {
    let pages = [
        json!("http://github.com/aurigax-ai/ostia/releases/tag/v1.4.0"),
        json!("https://github.com.evil.example/aurigax-ai/ostia/releases/tag/v1.4.0"),
        json!("https://evil.example/aurigax-ai/ostia/releases/tag/v1.4.0"),
        json!("https://github.com:8443/aurigax-ai/ostia/releases/tag/v1.4.0"),
        json!("https://user@github.com/aurigax-ai/ostia/releases/tag/v1.4.0"),
        json!("https://github.com/someone-else/ostia/releases/tag/v1.4.0"),
        json!("https://github.com/aurigax-ai/other/releases/tag/v1.4.0"),
        json!("https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0/../../../../evil/repo"),
        json!("https://github.com/aurigax-ai/ostia/releases/tag/v9.9.9"),
        json!("https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0?next=https://evil.example"),
        json!("https://github.com/aurigax-ai/ostia/releases/tag/v1.4.0#x"),
        json!("javascript:alert(1)"),
        json!("file:///etc/passwd"),
        json!(""),
        json!(null),
    ];
    for html_url in pages {
        assert_eq!(
            parse_latest_release(&with(base_release(), "html_url", html_url.clone())),
            MALFORMED,
            "html_url {html_url}"
        );
    }
}

#[test]
fn refuses_a_response_without_a_valid_tag_or_flags() {
    assert_eq!(parse_latest_release(&json!(null)), MALFORMED);
    assert_eq!(parse_latest_release(&json!("v1.4.0")), MALFORMED);
    assert_eq!(parse_latest_release(&json!([])), MALFORMED);
    assert_eq!(
        parse_latest_release(&with(base_release(), "tag_name", json!("nightly"))),
        MALFORMED
    );
    assert_eq!(
        parse_latest_release(&with(base_release(), "tag_name", json!(14))),
        MALFORMED
    );
    let mut no_draft = base_release();
    no_draft.as_object_mut().unwrap().remove("draft");
    assert_eq!(parse_latest_release(&no_draft), MALFORMED);
    assert_eq!(
        parse_latest_release(&with(base_release(), "prerelease", json!("no"))),
        MALFORMED
    );
}

#[test]
fn accepts_main_builds_and_release_candidates_nothing_else() {
    assert!(is_main_channel_version(&version("0.5.10-main.412")));
    assert!(is_main_channel_version(&version("0.5.9-rc.3")));
    for text in [
        "0.5.9",
        "0.5.10-main",
        "0.5.10-main.x",
        "0.5.10-main.4.1",
        "1.0.0-beta.1",
    ] {
        assert!(!is_main_channel_version(&version(text)), "text {text}");
    }
}

#[test]
fn picks_the_highest_main_build_release_candidate_or_stable_release() {
    let list = json!([
        release("v0.5.10-main.411"),
        release("v0.5.10-main.412"),
        release("v0.5.9-rc.3"),
        release("v0.5.9")
    ]);
    assert_eq!(
        pick_main_channel_release(&list),
        offered("0.5.10-main.412", "v0.5.10-main.412")
    );
}

#[test]
fn offers_a_stable_release_that_is_higher_than_every_main_build() {
    let list = json!([
        release("v0.5.10-main.412"),
        release("v0.5.10"),
        release("v0.5.11-rc.1")
    ]);
    assert_eq!(
        pick_main_channel_release(&list),
        offered("0.5.11-rc.1", "v0.5.11-rc.1")
    );
    let first_two = json!([release("v0.5.10-main.412"), release("v0.5.10")]);
    assert_eq!(
        pick_main_channel_release(&first_two),
        offered("0.5.10", "v0.5.10")
    );
}

#[test]
fn orders_main_builds_by_run_number_not_as_text() {
    let list = json!([release("v0.5.10-main.99"), release("v0.5.10-main.100")]);
    assert_eq!(
        picked_version(pick_main_channel_release(&list)),
        "0.5.10-main.100"
    );
}

#[test]
fn skips_drafts_other_prereleases_unflagged_main_tags_and_build_metadata() {
    let list = json!([
        with(release("v0.6.0-main.1"), "draft", json!(true)),
        release("v0.6.0-beta.1"),
        release_flagged("v0.6.0-main.2", false),
        release("v0.6.0-main.3+sha.1a2b3c"),
        release("v0.5.9")
    ]);
    assert_eq!(picked_version(pick_main_channel_release(&list)), "0.5.9");
}

#[test]
fn skips_an_entry_whose_release_page_is_not_the_exact_tag_page() {
    let list = json!([
        with(
            release("v0.6.0-main.5"),
            "html_url",
            json!("https://evil.example/aurigax-ai/ostia")
        ),
        release("v0.5.10-main.4")
    ]);
    assert_eq!(
        picked_version(pick_main_channel_release(&list)),
        "0.5.10-main.4"
    );
}

#[test]
fn reports_nothing_offered_for_an_empty_list_and_malformed_for_anything_but_a_list() {
    assert_eq!(pick_main_channel_release(&json!([])), NOT_STABLE);
    assert_eq!(
        pick_main_channel_release(&json!([null, "v1.0.0"])),
        NOT_STABLE
    );
    assert_eq!(pick_main_channel_release(&release("v0.5.9")), MALFORMED);
    assert_eq!(pick_main_channel_release(&json!(null)), MALFORMED);
}

fn sha() -> String {
    "ab".repeat(32)
}

fn with_dmg(tag: &str, digest: Value) -> Value {
    let bare = &tag[1..];
    with(
        release(tag),
        "assets",
        json!([
            {"name": format!("ostia-{bare}-linux-x64.tar.gz"), "digest": format!("sha256:{}", "cd".repeat(32))},
            {"name": format!("ostia-{bare}-arm64.dmg"), "digest": digest}
        ]),
    )
}

fn with_default_dmg(tag: &str) -> Value {
    with_dmg(tag, json!(format!("sha256:{}", sha())))
}

fn digest_of(parsed: ParsedRelease) -> Option<String> {
    match parsed {
        ParsedRelease::Release(release) => release.dmg_sha256,
        other => panic!("nothing offered: {other:?}"),
    }
}

#[test]
fn picks_the_highest_release_candidate_or_stable_release_that_ships_a_dmg_with_its_digest() {
    let list = json!([
        with_default_dmg("v0.5.12"),
        with_default_dmg("v0.5.13-rc.2"),
        with_default_dmg("v0.5.13-rc.1")
    ]);
    assert_eq!(
        pick_beta_release(&list, dmg_asset_name),
        ParsedRelease::Release(ReleaseInfo {
            version: "0.5.13-rc.2".to_owned(),
            url: page("v0.5.13-rc.2"),
            dmg_sha256: Some(sha())
        })
    );
    let with_stable = json!([
        with_default_dmg("v0.5.12"),
        with_default_dmg("v0.5.13-rc.2"),
        with_default_dmg("v0.5.13-rc.1"),
        with_default_dmg("v0.5.13")
    ]);
    assert_eq!(
        picked_version(pick_beta_release(&with_stable, dmg_asset_name)),
        "0.5.13"
    );
}

#[test]
fn skips_main_builds_drafts_other_prereleases_build_metadata_and_unflagged_rc_tags() {
    let list = json!([
        with_default_dmg("v0.6.0-main.4"),
        with(with_default_dmg("v0.6.0-rc.1"), "draft", json!(true)),
        with_default_dmg("v0.6.0-beta.1"),
        with_default_dmg("v0.6.0-rc.2+sha.1a2b3c"),
        with(with_default_dmg("v0.6.0-rc.3"), "prerelease", json!(false)),
        with_default_dmg("v0.5.12-rc.1")
    ]);
    assert_eq!(
        picked_version(pick_beta_release(&list, dmg_asset_name)),
        "0.5.12-rc.1"
    );
}

#[test]
fn skips_a_release_without_the_dmg_and_keeps_one_whose_digest_is_missing_without_a_digest() {
    let list = json!([
        release("v0.6.0-rc.1"),
        with_dmg("v0.5.13-rc.1", json!("md5:abc"))
    ]);
    assert_eq!(
        pick_beta_release(&list, dmg_asset_name),
        offered("0.5.13-rc.1", "v0.5.13-rc.1")
    );
    assert_eq!(
        pick_beta_release(&json!([release("v0.6.0-rc.1")]), dmg_asset_name),
        NOT_STABLE
    );
    assert_eq!(
        pick_beta_release(&with_default_dmg("v0.6.0-rc.1"), dmg_asset_name),
        MALFORMED
    );
}

#[test]
fn matches_the_dmg_of_the_same_version_only() {
    let other = with(
        release("v0.6.0-rc.1"),
        "assets",
        json!([{"name": "ostia-0.5.0-arm64.dmg"}]),
    );
    assert_eq!(
        pick_beta_release(&json!([other]), dmg_asset_name),
        NOT_STABLE
    );
}

#[test]
fn needs_the_tarball_of_the_same_version_instead_of_the_dmg() {
    let tarball = |tag: &str| {
        with(
            release(tag),
            "assets",
            json!([{"name": format!("ostia-{}-linux-x64.tar.gz", &tag[1..])}]),
        )
    };
    let dmg_only = |tag: &str| {
        with(
            release(tag),
            "assets",
            json!([{"name": format!("ostia-{}-arm64.dmg", &tag[1..])}]),
        )
    };
    let list = json!([
        dmg_only("v0.6.0-rc.2"),
        tarball("v0.6.0-rc.1"),
        tarball("v0.5.12"),
        tarball("v0.7.0-main.3")
    ]);
    assert_eq!(
        pick_beta_release(&list, tarball_asset_name),
        offered("0.6.0-rc.1", "v0.6.0-rc.1")
    );
    assert_eq!(
        picked_version(pick_beta_release(&list, dmg_asset_name)),
        "0.6.0-rc.2"
    );
}

#[test]
fn carries_the_dmg_digest_of_the_stable_release() {
    let parsed = parse_latest_release(&with_default_dmg("v1.4.0"));
    assert_eq!(digest_of(parsed.clone()), Some(sha()));
    assert_eq!(picked_version(parsed), "1.4.0");
}

#[test]
fn is_main_or_beta_only_when_set_to_exactly_that_else_stable() {
    assert_eq!(parse_update_channel(&json!("main")), UpdateChannel::Main);
    assert_eq!(parse_update_channel(&json!("beta")), UpdateChannel::Beta);
    for raw in [
        json!("stable"),
        json!("Main"),
        json!("Beta"),
        json!("nightly"),
        Value::Null,
        json!(1),
    ] {
        assert_eq!(
            parse_update_channel(&raw),
            UpdateChannel::Stable,
            "raw {raw}"
        );
    }
}

#[test]
fn names_the_dmg_and_the_tarball_after_the_product_and_the_version_new_case() {
    assert_eq!(dmg_asset_name("1.2.3"), "ostia-1.2.3-arm64.dmg");
    assert_eq!(tarball_asset_name("1.2.3"), "ostia-1.2.3-linux-x64.tar.gz");
}

#[test]
fn refuses_non_ascii_digits_and_a_number_with_more_than_nine_digits_new_case() {
    for text in [
        "١.٢.٣",
        "1.2.3-٣",
        "1234567890.0.0",
        "1.2.1234567890",
        "1.2.3\n",
        "1.2.3-rc.1+",
        "1.2.3+a..b",
    ] {
        assert_eq!(parse_version(text), None, "text {text:?}");
    }
    assert_eq!(
        parse_version("123456789.0.0").map(|v| v.major),
        Some(123_456_789)
    );
}

#[test]
fn accepts_a_release_page_that_url_parsing_writes_as_the_exact_tag_page_new_case() {
    for html_url in [
        "https://GitHub.com/aurigax-ai/ostia/releases/tag/v1.4.0",
        "https://github.com:443/aurigax-ai/ostia/releases/tag/v1.4.0",
    ] {
        assert_eq!(
            parse_latest_release(&with(base_release(), "html_url", json!(html_url))),
            offered("1.4.0", "v1.4.0"),
            "html_url {html_url}"
        );
    }
}

#[test]
fn reads_a_tag_without_the_v_and_strips_one_v_only_new_case() {
    let bare = with(
        with(base_release(), "tag_name", json!("1.4.0")),
        "html_url",
        json!(page("1.4.0")),
    );
    assert_eq!(parse_latest_release(&bare), offered("1.4.0", "1.4.0"));
    let double = with(
        with(base_release(), "tag_name", json!("vv1.4.0")),
        "html_url",
        json!(page("vv1.4.0")),
    );
    assert_eq!(parse_latest_release(&double), MALFORMED);
}

#[test]
fn treats_a_stable_tag_with_build_metadata_as_not_stable_new_case() {
    let metadata = with(
        with(base_release(), "tag_name", json!("v1.4.0+sha.1")),
        "html_url",
        json!(page("v1.4.0+sha.1")),
    );
    assert_eq!(parse_latest_release(&metadata), NOT_STABLE);
}
