#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::agent_settings::{
    AGENT_PROVIDER_MODELS_MAX, DEFAULT_AGENT_SETTINGS, parse_agent_settings,
};
use serde_json::{Value, json};

fn local() -> Value {
    json!({
        "id": "llama",
        "name": "llama.cpp",
        "baseUrl": "http://127.0.0.1:8080/v1",
        "models": ["qwen"],
    })
}

fn with(key: &str, value: Value) -> Value {
    let mut provider = local();
    provider[key] = value;
    provider
}

fn parsed(raw: &Value) -> Value {
    serde_json::to_value(parse_agent_settings(raw)).unwrap()
}

fn providers(raw: &Value) -> Value {
    parsed(raw)["providers"].clone()
}

fn always_ask(raw: &Value) -> Value {
    parsed(raw)["alwaysAsk"].clone()
}

#[test]
fn keeps_a_well_formed_key_less_http_provider() {
    assert_eq!(
        providers(&json!({ "providers": [local()] })),
        json!([local()])
    );
}

#[test]
fn drops_a_provider_whose_url_carries_credentials_a_query_or_another_scheme() {
    let bad = [
        "http://user:pw@127.0.0.1:8080/v1",
        "http://127.0.0.1:8080/v1?key=1",
        "unix:/tmp/llama.sock",
        "file:///etc/passwd",
    ];
    let list: Vec<Value> = bad.iter().map(|url| with("baseUrl", json!(url))).collect();
    assert_eq!(providers(&json!({ "providers": list })), json!([]));
}

#[test]
fn drops_a_provider_without_models_with_a_bad_id_or_a_repeated_id() {
    let list = vec![
        with("models", json!([])),
        with("id", json!("Bad Id")),
        local(),
        with("name", json!("again")),
    ];
    assert_eq!(providers(&json!({ "providers": list })), json!([local()]));
}

#[test]
fn answers_empty_settings_for_anything_that_is_not_an_object() {
    let empty = json!({ "providers": [], "alwaysAsk": [] });
    for raw in [json!(null), json!([]), json!("x"), json!(7), json!(true)] {
        assert_eq!(parsed(&raw), empty, "{raw}");
    }
    assert_eq!(
        serde_json::to_value(&*DEFAULT_AGENT_SETTINGS).unwrap(),
        empty
    );
}

#[test]
fn has_an_empty_always_ask_list_until_the_human_turns_tools_on() {
    assert_eq!(always_ask(&json!({})), json!([]));
    assert_eq!(
        always_ask(&json!({ "alwaysAsk": "ostia_bus_send" })),
        json!([])
    );
}

#[test]
fn keeps_only_acting_ostia_tools_in_the_list_and_an_empty_list_stays_empty() {
    assert_eq!(
        always_ask(&json!({ "alwaysAsk": ["ostia_bus_send", "ostia_panes", "open_url", 7] })),
        json!(["ostia_bus_send"])
    );
    assert_eq!(always_ask(&json!({ "alwaysAsk": [] })), json!([]));
}

#[test]
fn lists_always_ask_tools_in_the_order_of_the_acting_tools_without_repeats() {
    assert_eq!(
        always_ask(&json!({
            "alwaysAsk": ["ostia_bus_send", "ostia_agent_run", "ostia_bus_send"]
        })),
        json!(["ostia_agent_run", "ostia_bus_send"])
    );
}

#[test]
fn keeps_an_https_url_and_refuses_a_url_with_a_fragment_or_an_empty_password() {
    let https = with("baseUrl", json!("https://models.example.com/v1"));
    assert_eq!(
        providers(&json!({ "providers": [https.clone()] })),
        json!([https])
    );
    for url in [
        "https://models.example.com/v1#frag",
        "http://user@127.0.0.1/v1",
        "http://:pw@127.0.0.1/v1",
        "not a url",
        "",
    ] {
        assert_eq!(
            providers(&json!({ "providers": [with("baseUrl", json!(url))] })),
            json!([]),
            "{url:?}"
        );
    }
    assert_eq!(
        providers(&json!({ "providers": [with("baseUrl", json!(7))] })),
        json!([])
    );
}

#[test]
fn keeps_the_url_text_as_written_and_limits_it_to_2048_units() {
    let tail = "a".repeat(2048 - "http://h/".len());
    let fits = format!("http://h/{tail}");
    assert_eq!(fits.len(), 2048);
    assert_eq!(
        providers(&json!({ "providers": [with("baseUrl", json!(fits))] }))[0]["baseUrl"],
        json!(fits)
    );
    let long = format!("{fits}a");
    assert_eq!(
        providers(&json!({ "providers": [with("baseUrl", json!(long))] })),
        json!([])
    );
    assert_eq!(
        providers(&json!({ "providers": [with("baseUrl", json!("HTTP://Host"))] }))[0]["baseUrl"],
        json!("HTTP://Host")
    );
}

#[test]
fn checks_the_provider_id_shape() {
    let max = format!("a{}", "b".repeat(31));
    let too_long = format!("a{}", "b".repeat(32));
    for id in ["a", "0", "a-b", "9-x", max.as_str()] {
        assert_eq!(
            providers(&json!({ "providers": [with("id", json!(id))] }))[0]["id"],
            json!(id),
            "{id:?}"
        );
    }
    for id in ["", "-a", "A", "a_b", "a b", "a\n", too_long.as_str()] {
        assert_eq!(
            providers(&json!({ "providers": [with("id", json!(id))] })),
            json!([]),
            "{id:?}"
        );
    }
    assert_eq!(
        providers(&json!({ "providers": [with("id", json!(3))] })),
        json!([])
    );
}

#[test]
fn trims_the_name_cuts_it_to_80_units_and_falls_back_to_the_id() {
    let named =
        |name: Value| providers(&json!({ "providers": [with("name", name)] }))[0]["name"].clone();
    assert_eq!(named(json!("  Local  ")), json!("Local"));
    assert_eq!(named(json!("")), json!("llama"));
    assert_eq!(named(json!("   ")), json!("llama"));
    assert_eq!(named(json!(5)), json!("llama"));
    assert_eq!(named(json!(null)), json!("llama"));
    assert_eq!(named(json!("n".repeat(100))), json!("n".repeat(80)));
    assert_eq!(
        named(json!(format!("{}   z", "n".repeat(78)))),
        json!(format!("{}  ", "n".repeat(78)))
    );
    let mut missing = local();
    missing.as_object_mut().unwrap().remove("name");
    assert_eq!(
        providers(&json!({ "providers": [missing] }))[0]["name"],
        json!("llama")
    );
}

#[test]
fn counts_the_name_limit_in_utf16_units() {
    let name = "😀".repeat(41);
    let cut = providers(&json!({ "providers": [with("name", json!(name))] }))[0]["name"].clone();
    assert_eq!(cut.as_str().unwrap().encode_utf16().count(), 80);
}

#[test]
fn keeps_models_that_are_non_empty_strings_up_to_120_units_without_repeats() {
    let long = "m".repeat(120);
    let too_long = "m".repeat(121);
    let models = json!(["a", "", 7, null, "b", "a", long, too_long, "b"]);
    assert_eq!(
        providers(&json!({ "providers": [with("models", models)] }))[0]["models"],
        json!(["a", "b", long])
    );
    assert_eq!(
        providers(&json!({ "providers": [with("models", json!("qwen"))] })),
        json!([])
    );
    assert_eq!(
        providers(&json!({ "providers": [with("models", json!([7, ""]))] })),
        json!([])
    );
}

#[test]
fn cuts_the_model_list_to_the_provider_limit_after_removing_repeats() {
    assert_eq!(AGENT_PROVIDER_MODELS_MAX, 64);
    let mut names: Vec<String> = (0..80).map(|i| format!("m{i}")).collect();
    names.insert(0, "m0".to_owned());
    let kept =
        providers(&json!({ "providers": [with("models", json!(names))] }))[0]["models"].clone();
    let expected: Vec<String> = (0..64).map(|i| format!("m{i}")).collect();
    assert_eq!(kept, json!(expected));
}

#[test]
fn keeps_at_most_16_providers_and_counts_only_the_ones_it_kept() {
    let mut list = vec![with("id", json!("Bad"))];
    for i in 0..20 {
        list.push(with("id", json!(format!("p{i}"))));
    }
    let kept = providers(&json!({ "providers": list }));
    let ids: Vec<&str> = kept
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    let expected: Vec<String> = (0..16).map(|i| format!("p{i}")).collect();
    assert_eq!(ids, expected.iter().map(String::as_str).collect::<Vec<_>>());
}

#[test]
fn ignores_providers_that_are_not_a_list_and_items_that_are_not_objects() {
    assert_eq!(providers(&json!({ "providers": "x" })), json!([]));
    assert_eq!(
        providers(&json!({ "providers": { "0": local() } })),
        json!([])
    );
    assert_eq!(
        providers(&json!({ "providers": [null, 3, "x", [], local()] })),
        json!([local()])
    );
}

#[test]
fn writes_the_provider_fields_in_id_name_base_url_models_order() {
    let text = serde_json::to_string(&parse_agent_settings(&json!({
        "providers": [local()],
        "alwaysAsk": ["ostia_bus_send"],
    })))
    .unwrap();
    assert_eq!(
        text,
        r#"{"providers":[{"id":"llama","name":"llama.cpp","baseUrl":"http://127.0.0.1:8080/v1","models":["qwen"]}],"alwaysAsk":["ostia_bus_send"]}"#
    );
}
