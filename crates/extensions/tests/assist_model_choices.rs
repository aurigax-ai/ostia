#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;

use ostia_contract::assist::{
    AssistModelChoice, AssistModelClass, AssistModelRef, AssistModelSettings, AssistPoint,
};
use ostia_contract::capabilities::Capability;
use ostia_extensions::assist_model_choices::{
    AssistModelChoices, AssistModelChoicesHost, AssistRuntime,
};
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct FakeHost {
    runtimes: Vec<AssistRuntime>,
    inactive: Vec<String>,
    grants: HashMap<String, Vec<Capability>>,
    names: HashMap<String, String>,
    settings: AssistModelSettings,
}

impl AssistModelChoicesHost for FakeHost {
    fn runtimes(&self) -> Vec<AssistRuntime> {
        self.runtimes.clone()
    }

    fn active(&self, ext_id: &str) -> bool {
        !self.inactive.iter().any(|id| id == ext_id)
    }

    fn granted(&self, ext_id: &str) -> Vec<Capability> {
        self.grants
            .get(ext_id)
            .cloned()
            .unwrap_or_else(|| vec![Capability::Assist])
    }

    fn shown_name(&self, ext_id: &str) -> String {
        self.names
            .get(ext_id)
            .cloned()
            .unwrap_or_else(|| format!("Name of {ext_id}"))
    }

    fn settings(&self) -> AssistModelSettings {
        self.settings.clone()
    }
}

fn runtime(
    ext_id: &str,
    contributes: &[AssistPoint],
    report: Option<Value>,
    status: Value,
) -> AssistRuntime {
    AssistRuntime {
        ext_id: ext_id.to_owned(),
        connected: true,
        contributes: contributes.to_vec(),
        report,
        status,
    }
}

fn host_of(runtimes: Vec<AssistRuntime>) -> FakeHost {
    FakeHost {
        runtimes,
        ..FakeHost::default()
    }
}

fn model_ref(ext_id: &str, provider: Option<&str>, model: Option<&str>) -> AssistModelRef {
    AssistModelRef {
        ext_id: ext_id.to_owned(),
        provider: provider.map(str::to_owned),
        model: model.map(str::to_owned),
    }
}

fn ready(points: &[&str]) -> Value {
    Value::Object(
        points
            .iter()
            .map(|point| ((*point).to_owned(), json!({"ready": true})))
            .collect(),
    )
}

fn choices_json(choices: &[AssistModelChoice]) -> Value {
    serde_json::to_value(choices).unwrap()
}

#[test]
fn serves_assist_only_when_the_extension_is_active_connected_reporting_and_granted_assist() {
    let report = Some(json!({}));
    let rt = runtime("a", &[AssistPoint::Chat], report.clone(), ready(&["chat"]));
    let serving = AssistModelChoices::new(host_of(vec![rt.clone()]));
    assert!(serving.serves_assist(&rt));

    let mut inactive = host_of(vec![rt.clone()]);
    inactive.inactive.push("a".to_owned());
    assert!(!AssistModelChoices::new(inactive).serves_assist(&rt));

    let mut not_granted = host_of(vec![rt.clone()]);
    not_granted
        .grants
        .insert("a".to_owned(), vec![Capability::Notify, Capability::Shell]);
    assert!(!AssistModelChoices::new(not_granted).serves_assist(&rt));

    let disconnected = AssistRuntime {
        connected: false,
        ..rt.clone()
    };
    assert!(!serving.serves_assist(&disconnected));

    let silent = AssistRuntime {
        report: None,
        ..rt.clone()
    };
    assert!(!serving.serves_assist(&silent));
}

#[test]
fn offers_one_choice_for_an_extension_with_no_providers_named_after_the_extension() {
    let mut host = host_of(vec![runtime(
        "local",
        &[AssistPoint::Input, AssistPoint::Chat],
        Some(json!({})),
        ready(&["input", "chat"]),
    )]);
    host.names
        .insert("local".to_owned(), "Local model".to_owned());
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(
        choices_json(&choices),
        json!([{
            "ref": {"extId": "local"},
            "group": "Local model",
            "label": "Local model",
            "points": ["input", "chat"],
        }])
    );
}

#[test]
fn uses_the_reported_label_instead_of_the_shown_name_and_keeps_an_empty_one() {
    let host = host_of(vec![
        runtime(
            "a",
            &[AssistPoint::Chat],
            Some(json!({"label": "Fast one"})),
            ready(&["chat"]),
        ),
        runtime(
            "b",
            &[AssistPoint::Chat],
            Some(json!({"label": ""})),
            ready(&["chat"]),
        ),
    ]);
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(choices[0].group, "Name of a");
    assert_eq!(choices[0].label, "Fast one");
    assert_eq!(choices[1].group, "Name of b");
    assert_eq!(choices[1].label, "");
}

#[test]
fn carries_the_chat_tool_mode_of_the_chat_status_only() {
    let host = host_of(vec![
        runtime(
            "a",
            &[AssistPoint::Chat],
            Some(json!({})),
            json!({"chat": {"ready": true, "tools": "native"}}),
        ),
        runtime(
            "b",
            &[AssistPoint::Input],
            Some(json!({})),
            json!({"input": {"ready": true, "tools": "native"}}),
        ),
        runtime(
            "c",
            &[AssistPoint::Chat],
            Some(json!({})),
            json!({"chat": {"ready": true}}),
        ),
    ]);
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(choices[0].tools, Some("native"));
    assert_eq!(choices[1].tools, None);
    assert_eq!(choices[2].tools, None);
}

#[test]
fn lists_only_the_points_the_extension_contributes_and_reports_ready_in_point_order() {
    let host = host_of(vec![runtime(
        "a",
        &[
            AssistPoint::Chat,
            AssistPoint::Terminal,
            AssistPoint::Command,
            AssistPoint::Completion,
        ],
        Some(json!({})),
        json!({
            "input": {"ready": true},
            "command": {"ready": false},
            "completion": {"ready": true},
            "terminal": {},
            "chat": {"ready": true},
        }),
    )]);
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(choices[0].points, ["completion", "chat"]);
}

#[test]
fn a_point_with_a_ready_status_that_is_not_true_is_not_listed() {
    let host = host_of(vec![runtime(
        "a",
        &[AssistPoint::Input, AssistPoint::Command, AssistPoint::Chat],
        Some(json!({})),
        json!({
            "input": {"ready": "yes"},
            "command": {"ready": 1},
            "chat": {"ready": true},
        }),
    )]);
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(choices[0].points, ["chat"]);
}

#[test]
fn offers_one_choice_per_model_of_each_provider_that_needs_no_setup() {
    let host = host_of(vec![runtime(
        "gateway",
        &[AssistPoint::Chat, AssistPoint::Input],
        Some(json!({"providers": [
            {"id": "p1", "name": "Provider One", "setup": null, "models": [
                {"id": "m1", "tools": "native"},
                {"id": "m2", "tools": "prompted"},
            ]},
            {"id": "p2", "name": "Provider Two", "setup": "no-key", "models": [{"id": "m3"}]},
            {"id": "p3", "name": "Provider Three", "setup": null, "models": [{"id": "m4"}]},
        ]})),
        ready(&["input", "chat"]),
    )]);
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(
        choices_json(&choices),
        json!([
            {
                "ref": {"extId": "gateway", "provider": "p1", "model": "m1"},
                "group": "Provider One",
                "label": "m1",
                "tools": "native",
                "points": ["input", "chat"],
            },
            {
                "ref": {"extId": "gateway", "provider": "p1", "model": "m2"},
                "group": "Provider One",
                "label": "m2",
                "tools": "prompted",
                "points": ["input", "chat"],
            },
            {
                "ref": {"extId": "gateway", "provider": "p3", "model": "m4"},
                "group": "Provider Three",
                "label": "m4",
                "points": ["input", "chat"],
            },
        ])
    );
}

#[test]
fn a_report_with_an_empty_provider_list_offers_nothing() {
    let host = host_of(vec![runtime(
        "gateway",
        &[AssistPoint::Chat],
        Some(json!({"providers": []})),
        ready(&["chat"]),
    )]);
    assert!(AssistModelChoices::new(host).model_choices().is_empty());
}

#[test]
fn skips_an_extension_that_does_not_serve_assist() {
    let report = Some(json!({}));
    let mut host = host_of(vec![
        runtime(
            "off",
            &[AssistPoint::Chat],
            report.clone(),
            ready(&["chat"]),
        ),
        AssistRuntime {
            connected: false,
            ..runtime(
                "down",
                &[AssistPoint::Chat],
                report.clone(),
                ready(&["chat"]),
            )
        },
        runtime("quiet", &[AssistPoint::Chat], None, ready(&["chat"])),
        runtime(
            "denied",
            &[AssistPoint::Chat],
            report.clone(),
            ready(&["chat"]),
        ),
        runtime("ok", &[AssistPoint::Chat], report, ready(&["chat"])),
    ]);
    host.inactive.push("off".to_owned());
    host.grants.insert("denied".to_owned(), Vec::new());
    let choices = AssistModelChoices::new(host).model_choices();
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0].model_ref.ext_id, "ok");
}

#[test]
fn keeps_the_runtime_order_of_the_host() {
    let report = Some(json!({}));
    let host = host_of(vec![
        runtime(
            "zeta",
            &[AssistPoint::Chat],
            report.clone(),
            ready(&["chat"]),
        ),
        runtime(
            "alpha",
            &[AssistPoint::Chat],
            report.clone(),
            ready(&["chat"]),
        ),
        runtime("mid", &[AssistPoint::Chat], report, ready(&["chat"])),
    ]);
    let ids: Vec<String> = AssistModelChoices::new(host)
        .model_choices()
        .into_iter()
        .map(|choice| choice.model_ref.ext_id)
        .collect();
    assert_eq!(ids, ["zeta", "alpha", "mid"]);
}

fn mixed_host() -> FakeHost {
    let report = Some(json!({}));
    host_of(vec![
        runtime(
            "fast-a",
            &[AssistPoint::Input],
            report.clone(),
            ready(&["input"]),
        ),
        runtime(
            "chat-b",
            &[AssistPoint::Chat],
            report.clone(),
            ready(&["chat"]),
        ),
        runtime(
            "both-c",
            &[AssistPoint::Command, AssistPoint::Chat],
            report,
            ready(&["command", "chat"]),
        ),
    ])
}

#[test]
fn selects_the_first_choice_of_an_extension_that_offers_the_class_when_none_is_set() {
    let choices = AssistModelChoices::new(mixed_host());
    let all = choices.model_choices();
    let chat = choices
        .selected_choice(AssistModelClass::Chat, &all)
        .unwrap();
    let fast = choices
        .selected_choice(AssistModelClass::Fast, &all)
        .unwrap();
    assert_eq!(chat.model_ref.ext_id, "chat-b");
    assert_eq!(fast.model_ref.ext_id, "fast-a");
    assert_eq!(choices.selected_choice(AssistModelClass::Chat, &[]), None);
}

#[test]
fn selects_the_chosen_model_for_each_class_and_nothing_when_it_is_gone() {
    let mut host = mixed_host();
    host.settings.chat_model = Some(model_ref("both-c", None, None));
    host.settings.fast_model = Some(model_ref("both-c", None, None));
    let choices = AssistModelChoices::new(host.clone());
    let all = choices.model_choices();
    assert_eq!(
        choices
            .selected_choice(AssistModelClass::Chat, &all)
            .unwrap()
            .model_ref
            .ext_id,
        "both-c"
    );
    assert_eq!(
        choices
            .selected_choice(AssistModelClass::Fast, &all)
            .unwrap()
            .model_ref
            .ext_id,
        "both-c"
    );

    host.settings.chat_model = Some(model_ref("removed", None, None));
    host.settings.fast_model = Some(model_ref("fast-a", Some("p"), Some("m")));
    let choices = AssistModelChoices::new(host);
    let all = choices.model_choices();
    assert_eq!(choices.selected_choice(AssistModelClass::Chat, &all), None);
    assert_eq!(choices.selected_choice(AssistModelClass::Fast, &all), None);
}

#[test]
fn a_chosen_model_of_an_extension_that_does_not_offer_the_class_is_not_selected() {
    let mut host = mixed_host();
    host.settings.chat_model = Some(model_ref("fast-a", None, None));
    host.settings.fast_model = Some(model_ref("chat-b", None, None));
    let choices = AssistModelChoices::new(host);
    let all = choices.model_choices();
    assert_eq!(choices.selected_choice(AssistModelClass::Chat, &all), None);
    assert_eq!(choices.selected_choice(AssistModelClass::Fast, &all), None);
}

#[test]
fn assist_target_finds_the_explicit_model_when_it_has_the_point() {
    let choices = AssistModelChoices::new(mixed_host());
    let target = choices
        .assist_target(AssistPoint::Chat, Some(&model_ref("both-c", None, None)))
        .unwrap();
    assert_eq!(target.runtime.ext_id, "both-c");
    assert_eq!(target.choice.model_ref, model_ref("both-c", None, None));
    let other_point = choices
        .assist_target(AssistPoint::Command, Some(&model_ref("both-c", None, None)))
        .unwrap();
    assert_eq!(other_point.runtime.ext_id, "both-c");
}

#[test]
fn assist_target_refuses_an_explicit_model_that_is_unknown_or_lacks_the_point() {
    let choices = AssistModelChoices::new(mixed_host());
    assert!(
        choices
            .assist_target(AssistPoint::Chat, Some(&model_ref("fast-a", None, None)))
            .is_none()
    );
    assert!(
        choices
            .assist_target(AssistPoint::Chat, Some(&model_ref("nobody", None, None)))
            .is_none()
    );
    assert!(
        choices
            .assist_target(
                AssistPoint::Chat,
                Some(&model_ref("both-c", Some("p"), Some("m")))
            )
            .is_none()
    );
}

#[test]
fn assist_target_uses_the_selected_model_of_the_class_of_the_point() {
    let choices = AssistModelChoices::new(mixed_host());
    let chat = choices.assist_target(AssistPoint::Chat, None).unwrap();
    assert_eq!(chat.runtime.ext_id, "chat-b");
    let input = choices.assist_target(AssistPoint::Input, None).unwrap();
    assert_eq!(input.runtime.ext_id, "fast-a");
    assert!(choices.assist_target(AssistPoint::Terminal, None).is_none());

    let mut host = mixed_host();
    host.settings.fast_model = Some(model_ref("both-c", None, None));
    let choices = AssistModelChoices::new(host);
    let command = choices.assist_target(AssistPoint::Command, None).unwrap();
    assert_eq!(command.runtime.ext_id, "both-c");
    assert!(choices.assist_target(AssistPoint::Input, None).is_none());
}
