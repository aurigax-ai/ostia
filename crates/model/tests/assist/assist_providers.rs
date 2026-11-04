use ostia_contract::assist::{
    ASSIST_PROVIDER_MODELS_MAX, ASSIST_PROVIDERS_MAX, AssistProviderConfig, AssistProviderKind,
};
use ostia_model::assist::assist_providers::{
    ProviderPatch, new_provider_id, patch_provider, with_model, with_provider,
};

fn kind() -> AssistProviderKind {
    AssistProviderKind {
        id: "openai-compatible".to_owned(),
        title: "OpenAI-compatible".to_owned(),
        base_url: String::new(),
        key: "optional",
    }
}

fn first() -> AssistProviderConfig {
    AssistProviderConfig {
        id: "openai-compatible".to_owned(),
        ext_id: "assistant".to_owned(),
        kind: "openai-compatible".to_owned(),
        name: "OpenAI-compatible".to_owned(),
        base_url: "http://a/v1".to_owned(),
        enabled: true,
        models: vec!["m".to_owned()],
    }
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn uses_the_kind_then_numbers_the_next_ones() {
    assert_eq!(new_provider_id("ollama", &[]), "ollama");
    assert_eq!(new_provider_id("ollama", &strings(&["ollama"])), "ollama-2");
    assert_eq!(
        new_provider_id("ollama", &strings(&["ollama", "ollama-2"])),
        "ollama-3"
    );
}

#[test]
fn cuts_a_long_kind_to_28_characters_before_the_number() {
    let long = "k".repeat(40);
    let id = new_provider_id(&long, std::slice::from_ref(&long));
    assert_eq!(id, format!("{}-2", "k".repeat(28)));
}

#[test]
fn adds_a_second_provider_of_the_same_kind_with_its_own_id_and_a_name_that_tells_them_apart() {
    let next = with_provider(&[first()], "assistant", &kind());
    assert_eq!(
        next,
        Some(vec![
            first(),
            AssistProviderConfig {
                id: "openai-compatible-2".to_owned(),
                ext_id: "assistant".to_owned(),
                kind: "openai-compatible".to_owned(),
                name: "OpenAI-compatible (openai-compatible-2)".to_owned(),
                base_url: String::new(),
                enabled: true,
                models: Vec::new(),
            },
        ])
    );
}

#[test]
fn refuses_one_more_than_the_cap() {
    let full: Vec<AssistProviderConfig> = (0..ASSIST_PROVIDERS_MAX)
        .map(|n| AssistProviderConfig {
            id: format!("p{n}"),
            ..first()
        })
        .collect();
    assert_eq!(with_provider(&full, "assistant", &kind()), None);
}

#[test]
fn keeps_the_kind_title_as_the_name_when_no_provider_has_it() {
    let next = with_provider(&[], "assistant", &kind()).unwrap();
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].id, "openai-compatible");
    assert_eq!(next[0].name, "OpenAI-compatible");
}

#[test]
fn refuses_a_kind_whose_id_does_not_fit_the_provider_id_pattern() {
    let upper = AssistProviderKind {
        id: "OpenAI".to_owned(),
        ..kind()
    };
    assert_eq!(with_provider(&[], "assistant", &upper), None);
}

#[test]
fn changes_only_the_named_provider() {
    let other = AssistProviderConfig {
        id: "other".to_owned(),
        ..first()
    };
    let patch = ProviderPatch {
        enabled: Some(false),
        ..ProviderPatch::default()
    };
    assert_eq!(
        patch_provider(&[first(), other.clone()], "other", &patch),
        vec![
            first(),
            AssistProviderConfig {
                enabled: false,
                ..other
            }
        ]
    );
}

#[test]
fn patches_the_name_the_address_and_the_models_together() {
    let patch = ProviderPatch {
        name: Some("Local".to_owned()),
        base_url: Some("http://b/v1".to_owned()),
        models: Some(strings(&["x", "y"])),
        ..ProviderPatch::default()
    };
    assert_eq!(
        patch_provider(&[first()], "openai-compatible", &patch),
        vec![AssistProviderConfig {
            name: "Local".to_owned(),
            base_url: "http://b/v1".to_owned(),
            models: strings(&["x", "y"]),
            ..first()
        }]
    );
}

#[test]
fn leaves_every_provider_alone_when_the_id_is_unknown() {
    let patch = ProviderPatch {
        enabled: Some(false),
        ..ProviderPatch::default()
    };
    assert_eq!(patch_provider(&[first()], "missing", &patch), vec![first()]);
}

#[test]
fn adds_a_trimmed_id_once_and_refuses_blanks_duplicates_and_one_past_the_cap() {
    assert_eq!(
        with_model(&strings(&["a"]), "  b/c:d  "),
        Some(strings(&["a", "b/c:d"]))
    );
    assert_eq!(with_model(&strings(&["a"]), "a"), None);
    assert_eq!(with_model(&strings(&["a"]), "   "), None);
    let full: Vec<String> = (0..ASSIST_PROVIDER_MODELS_MAX)
        .map(|n| format!("m{n}"))
        .collect();
    assert_eq!(with_model(&full, "one-more"), None);
}

#[test]
fn refuses_a_model_id_longer_than_200_units() {
    assert_eq!(with_model(&[], &"m".repeat(201)), None);
    assert_eq!(
        with_model(&[], &"m".repeat(200)),
        Some(vec!["m".repeat(200)])
    );
}
