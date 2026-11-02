#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::dict;
use ostia_model::workspaces::merge_eligibility::MergeOptionRefusal;
use ostia_model::workspaces::merge_refusal_text::merge_refusal_text;

#[test]
fn gives_no_text_when_the_merge_is_allowed() {
    assert_eq!(merge_refusal_text(dict::en(), None), None);
}

#[test]
fn reads_the_other_window_text_from_the_merge_strings() {
    assert_eq!(
        merge_refusal_text(dict::en(), Some(MergeOptionRefusal::OtherWindow)),
        Some("In another window".to_owned())
    );
}

#[test]
fn reads_the_sandbox_texts_from_the_merge_strings() {
    assert_eq!(
        merge_refusal_text(dict::en(), Some(MergeOptionRefusal::SandboxMixed)),
        Some("Only one of them is sandboxed".to_owned())
    );
    assert_eq!(
        merge_refusal_text(dict::en(), Some(MergeOptionRefusal::SandboxDiffers)),
        Some("Their sandbox settings differ".to_owned())
    );
}

#[test]
fn follows_the_language_of_the_dictionary_it_is_given() {
    let zh = dict::zh_hant();
    for refusal in [
        MergeOptionRefusal::OtherWindow,
        MergeOptionRefusal::SandboxMixed,
        MergeOptionRefusal::SandboxDiffers,
    ] {
        let text = merge_refusal_text(zh, Some(refusal)).unwrap();
        let english = merge_refusal_text(dict::en(), Some(refusal)).unwrap();
        assert_ne!(text, english, "{refusal:?}");
    }
}
