#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ostia_contract::assist::{
    ASSIST_PROVIDERS_MAX, AssistModelRef, AssistPoint, CHAT_CONTEXT_TEXT_MAX, CHAT_TOOL_OUTPUT_MAX,
    COMPLETION_PREFIX_MAX, same_model_ref,
};
use ostia_contract::assist_payloads::{
    normalize_assist_request, normalize_assist_result, normalize_chat_context_item,
};
use ostia_contract::assist_reports::{
    normalize_assist_status, normalize_model_ref, normalize_provider_kinds,
    normalize_provider_states, parse_assist_model_settings,
};
use serde_json::{Value, json};

fn request(point: AssistPoint, raw: Value) -> Option<Value> {
    normalize_assist_request(point, &raw)
}

fn array<'a>(value: &'a Value, pointer: &str) -> &'a Vec<Value> {
    value.pointer(pointer).unwrap().as_array().unwrap()
}

fn text_len(value: &Value, pointer: &str) -> usize {
    value.pointer(pointer).unwrap().as_str().unwrap().len()
}

fn model_ref_value(model_ref: &Option<AssistModelRef>) -> Value {
    serde_json::to_value(model_ref).unwrap()
}

#[test]
fn keeps_only_known_typo_review_tasks_and_needs_a_non_empty_draft() {
    assert_eq!(
        request(
            AssistPoint::Input,
            json!({"text": "fix teh bug", "tasks": ["typos", "rm"]})
        ),
        Some(json!({"text": "fix teh bug", "tasks": ["typos"]}))
    );
    assert_eq!(
        request(
            AssistPoint::Input,
            json!({"text": "  ", "tasks": ["typos"]})
        ),
        None
    );
    assert_eq!(
        request(AssistPoint::Input, json!({"text": "x", "tasks": []})),
        None
    );
}

#[test]
fn keeps_the_tail_of_a_completion_prefix_where_the_cursor_is() {
    let prefix = format!("{}TAIL", "a".repeat(COMPLETION_PREFIX_MAX));
    let req = request(
        AssistPoint::Completion,
        json!({
            "path": "/p/a.ts",
            "language": "typescript",
            "prefix": prefix,
            "suffix": "",
            "neighbors": [{"path": "/p/b.ts", "text": "b"}, {"path": 5}],
        }),
    )
    .unwrap();
    assert!(req["prefix"].as_str().unwrap().ends_with("TAIL"));
    assert_eq!(text_len(&req, "/prefix"), COMPLETION_PREFIX_MAX);
    assert_eq!(req["neighbors"], json!([{"path": "/p/b.ts", "text": "b"}]));
}

#[test]
fn needs_a_chat_to_end_with_the_human_and_clips_context_text() {
    assert_eq!(
        request(
            AssistPoint::Chat,
            json!({"messages": [{"role": "assistant", "content": "hi"}]})
        ),
        None
    );
    assert_eq!(
        request(
            AssistPoint::Chat,
            json!({"messages": [{"role": "system", "content": "x"}]})
        ),
        None
    );
    let req = request(
        AssistPoint::Chat,
        json!({
            "messages": [{"role": "user", "content": "why?"}],
            "context": [{
                "kind": "error",
                "label": "ls",
                "text": "e".repeat(CHAT_CONTEXT_TEXT_MAX + 5),
            }],
        }),
    )
    .unwrap();
    assert_eq!(text_len(&req, "/context/0/text"), CHAT_CONTEXT_TEXT_MAX);
}

#[test]
fn keeps_attached_files_and_browser_pages_but_drops_unknown_context_kinds() {
    let req = request(
        AssistPoint::Chat,
        json!({
            "messages": [{"role": "user", "content": "summarize"}],
            "context": [
                {"kind": "file", "label": "README.md", "text": "hello"},
                {"kind": "browser", "label": "Docs", "text": "Docs\nhttps://example.com"},
                {"kind": "secret", "label": "x", "text": "y"},
            ],
        }),
    )
    .unwrap();
    let kinds: Vec<&str> = array(&req, "/context")
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, vec!["file", "browser"]);
}

fn call(over: Value) -> Value {
    let mut base = json!({
        "id": "t1",
        "name": "read_file",
        "input": {"path": "/p/a"},
        "state": "done",
        "output": "text",
    });
    for (key, value) in over.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}

#[test]
fn may_end_with_an_assistant_turn_whose_tool_calls_all_have_outcomes() {
    let req = request(
        AssistPoint::Chat,
        json!({
            "messages": [
                {"role": "assistant", "content": "dropped: a chat starts with the human"},
                {"role": "user", "content": "read a"},
                {
                    "role": "assistant",
                    "content": "",
                    "tools": [call(json!({})), call(json!({"id": "t2", "state": "denied"}))],
                },
            ],
        }),
    )
    .unwrap();
    let roles: Vec<&str> = array(&req, "/messages")
        .iter()
        .map(|m| m["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, vec!["user", "assistant"]);
    assert_eq!(
        req["messages"][1]["tools"],
        json!([
            {"id": "t1", "name": "read_file", "input": {"path": "/p/a"}, "state": "done", "output": "text"},
            {"id": "t2", "name": "read_file", "input": {"path": "/p/a"}, "state": "denied"},
        ])
    );
}

#[test]
fn clips_tool_output_drops_calls_with_a_bad_name_or_state_and_ignores_tools_on_user_turns() {
    let req = request(
        AssistPoint::Chat,
        json!({
            "messages": [
                {"role": "user", "content": "x", "tools": [call(json!({}))]},
                {
                    "role": "assistant",
                    "content": "",
                    "tools": [
                        call(json!({"output": "o".repeat(CHAT_TOOL_OUTPUT_MAX + 10)})),
                        call(json!({"id": "t2", "name": "bad name"})),
                        call(json!({"id": "t3", "state": "running"})),
                        call(json!({"id": "t4", "state": "error", "error": "nope"})),
                    ],
                },
            ],
        }),
    )
    .unwrap();
    assert_eq!(req["messages"][0], json!({"role": "user", "content": "x"}));
    let tools = array(&req, "/messages/1/tools");
    let ids: Vec<&str> = tools.iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["t1", "t4"]);
    assert_eq!(text_len(&tools[0], "/output"), CHAT_TOOL_OUTPUT_MAX);
    assert_eq!(tools[1]["state"], "error");
    assert_eq!(tools[1]["error"], "nope");
}

#[test]
fn keeps_only_tool_specs_with_a_safe_name_a_description_and_an_object_schema() {
    let req = request(
        AssistPoint::Chat,
        json!({
            "messages": [{"role": "user", "content": "x"}],
            "tools": [
                {"name": "read_file", "description": "Read", "inputSchema": {"type": "object"}},
                {"name": "read_file", "description": "Dup", "inputSchema": {"type": "object"}},
                {"name": "has space", "description": "x", "inputSchema": {"type": "object"}},
                {"name": "no_desc", "description": " ", "inputSchema": {"type": "object"}},
                {"name": "arr", "description": "x", "inputSchema": {"type": "array"}},
            ],
        }),
    )
    .unwrap();
    let names: Vec<&str> = array(&req, "/tools")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["read_file"]);
    assert_eq!(
        request(
            AssistPoint::Chat,
            json!({"messages": [{"role": "user", "content": "x"}]})
        ),
        Some(json!({"messages": [{"role": "user", "content": "x"}], "context": []}))
    );
}

#[test]
fn bounds_a_prompt_review_and_rounds_its_score_into_1_5() {
    assert_eq!(
        normalize_assist_result(
            AssistPoint::Input,
            &json!({"review": {"score": 9.4, "notes": ["a", "", "b", "c", "d", "e", "f"]}})
        ),
        json!({"review": {"score": 5, "notes": ["a", "b", "c", "d", "e"]}})
    );
}

#[test]
fn returns_an_empty_text_for_a_malformed_reply() {
    assert_eq!(
        normalize_assist_result(AssistPoint::Chat, &json!("nope")),
        json!({"text": ""})
    );
}

#[test]
fn keeps_known_points_with_a_boolean_ready_and_a_short_label() {
    assert_eq!(
        normalize_assist_status(&json!({
            "chat": {"ready": "yes", "label": "x"},
            "shell": {"ready": true},
        })),
        json!({"chat": {"ready": false, "label": "x"}})
    );
}

#[test]
fn keeps_a_known_tool_mode_only_on_the_chat_point() {
    assert_eq!(
        normalize_assist_status(&json!({
            "chat": {"ready": true, "tools": "prompted"},
            "input": {"ready": true, "tools": "native"},
        })),
        json!({"chat": {"ready": true, "tools": "prompted"}, "input": {"ready": true}})
    );
    assert_eq!(
        normalize_assist_status(&json!({"chat": {"ready": true, "tools": true}})),
        json!({"chat": {"ready": true}})
    );
}

fn ollama() -> Value {
    json!({
        "id": "ollama",
        "extId": "assistant",
        "kind": "ollama",
        "name": "Ollama",
        "baseUrl": "",
        "enabled": true,
        "models": ["qwen"],
    })
}

fn with(base: Value, over: Value) -> Value {
    let mut merged = base;
    for (key, value) in over.as_object().unwrap() {
        merged[key] = value.clone();
    }
    merged
}

fn settings_value(raw: &Value) -> Value {
    serde_json::to_value(parse_assist_model_settings(raw)).unwrap()
}

#[test]
fn is_empty_for_missing_or_malformed_settings() {
    let empty = json!({"providers": [], "fastModel": null, "chatModel": null});
    for raw in [
        Value::Null,
        json!("x"),
        json!([]),
        json!({"providers": "ollama"}),
    ] {
        assert_eq!(settings_value(&raw), empty, "raw {raw}");
    }
}

#[test]
fn keeps_several_providers_with_their_own_address_switch_and_models() {
    let settings = settings_value(&json!({
        "providers": [
            ollama(),
            {
                "id": "openai-2",
                "extId": "assistant",
                "kind": "openai",
                "name": "  Work OpenAI  ",
                "baseUrl": " https://proxy.example/v1 ",
                "enabled": false,
                "models": ["gpt-a", " gpt-b ", "gpt-a", "", 7],
            },
        ],
        "chatModel": {"extId": "assistant", "provider": "openai-2", "model": "gpt-a"},
        "fastModel": {"extId": "model-runtime", "provider": "model-runtime", "model": "gemma"},
    }));
    assert_eq!(
        settings["providers"],
        json!([
            ollama(),
            {
                "id": "openai-2",
                "extId": "assistant",
                "kind": "openai",
                "name": "Work OpenAI",
                "baseUrl": "https://proxy.example/v1",
                "enabled": false,
                "models": ["gpt-a", "gpt-b"],
            },
        ])
    );
    assert_eq!(
        settings["chatModel"],
        json!({"extId": "assistant", "provider": "openai-2", "model": "gpt-a"})
    );
    assert_eq!(
        settings["fastModel"],
        json!({"extId": "model-runtime", "provider": "model-runtime", "model": "gemma"})
    );
}

#[test]
fn drops_providers_without_a_usable_id_kind_or_extension_duplicates_and_anything_past_the_cap() {
    let many: Vec<Value> = (0..ASSIST_PROVIDERS_MAX + 4)
        .map(|n| with(ollama(), json!({"id": format!("p{n}")})))
        .collect();
    let mut providers = vec![
        with(ollama(), json!({"id": "Bad Id"})),
        with(ollama(), json!({"id": "__proto__"})),
        with(ollama(), json!({"kind": "Has Space"})),
        with(ollama(), json!({"extId": ""})),
        with(ollama(), json!({"baseUrl": "x".repeat(5000)})),
        ollama(),
        with(ollama(), json!({"name": "Duplicate id"})),
    ];
    providers.extend(many);
    let settings = settings_value(&json!({"providers": providers}));
    let kept = array(&settings, "/providers");
    assert_eq!(kept.len(), ASSIST_PROVIDERS_MAX);
    assert_eq!(kept[0], ollama());
    assert_eq!(kept[1]["id"], "p0");
}

#[test]
fn never_carries_a_key_whatever_the_file_says() {
    let raw = json!({
        "providers": [with(ollama(), json!({"apiKey": "sk-in-the-wrong-place", "secret": "x"}))],
    });
    let settings = settings_value(&raw);
    assert!(!settings.to_string().contains("sk-in-the-wrong-place"));
    let mut keys: Vec<&String> = settings["providers"][0]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        vec![
            "baseUrl", "enabled", "extId", "id", "kind", "models", "name"
        ]
    );
}

#[test]
fn reads_a_model_reference_to_a_plain_extension_or_to_one_provider_model() {
    assert_eq!(
        model_ref_value(&normalize_model_ref(&json!({"extId": "oracle"}))),
        json!({"extId": "oracle"})
    );
    assert_eq!(
        model_ref_value(&normalize_model_ref(
            &json!({"extId": "a", "provider": "p", "model": "m", "extra": 1})
        )),
        json!({"extId": "a", "provider": "p", "model": "m"})
    );
    assert_eq!(
        model_ref_value(&normalize_model_ref(
            &json!({"extId": "a", "provider": "Bad Id", "model": "m"})
        )),
        json!({"extId": "a"})
    );
    assert_eq!(
        normalize_model_ref(&json!({"provider": "p", "model": "m"})),
        None
    );
    assert_eq!(normalize_model_ref(&json!("a/p/m")), None);

    let plain = AssistModelRef {
        ext_id: "a".to_string(),
        provider: None,
        model: None,
    };
    let full = AssistModelRef {
        ext_id: "a".to_string(),
        provider: Some("p".to_string()),
        model: Some("m".to_string()),
    };
    assert!(same_model_ref(Some(&plain), Some(&plain.clone())));
    assert!(!same_model_ref(Some(&full), Some(&plain)));
    assert!(same_model_ref(None, None));
}

#[test]
fn keeps_valid_provider_states_with_their_models_and_tool_style() {
    assert_eq!(
        normalize_provider_states(&json!([
            {
                "id": "ollama",
                "kind": "ollama",
                "name": "Ollama",
                "setup": "unreachable",
                "lastError": "connect ENOENT",
                "lifecycle": "yes",
                "models": [
                    {"id": "qwen", "tools": "prompted"},
                    {"id": "qwen"},
                    {"id": ""},
                    {"id": "x", "tools": 1},
                ],
            },
            {"id": "ollama", "kind": "ollama"},
            {"id": "Bad", "kind": "ollama"},
            "nope",
        ])),
        json!([{
            "id": "ollama",
            "kind": "ollama",
            "name": "Ollama",
            "setup": "unreachable",
            "lastError": "connect ENOENT",
            "lifecycle": false,
            "models": [{"id": "qwen", "tools": "prompted"}, {"id": "x"}],
        }])
    );
    assert_eq!(normalize_provider_states(&json!("x")), json!([]));
}

#[test]
fn keeps_provider_kinds_with_a_title_a_default_address_and_whether_a_key_is_required() {
    assert_eq!(
        normalize_provider_kinds(&json!([
            {"id": "openai", "title": "OpenAI", "baseUrl": "https://api.openai.com/v1", "key": "required"},
            {"id": "ollama"},
            {"id": "openai", "title": "Again"},
            {"id": "No Good"},
        ])),
        json!([
            {"id": "openai", "title": "OpenAI", "baseUrl": "https://api.openai.com/v1", "key": "required"},
            {"id": "ollama", "title": "ollama", "baseUrl": "", "key": "optional"},
        ])
    );
}

#[test]
fn keeps_an_absolute_file_path_and_a_valid_line_range_and_drops_anything_else() {
    assert_eq!(
        normalize_chat_context_item(&json!({
            "kind": "selection",
            "label": "Selection a.ts:2-4",
            "text": "x",
            "path": "/p/a.ts",
            "startLine": 2,
            "endLine": 4,
        })),
        Some(json!({
            "kind": "selection",
            "label": "Selection a.ts:2-4",
            "text": "x",
            "path": "/p/a.ts",
            "startLine": 2,
            "endLine": 4,
        }))
    );
    assert_eq!(
        normalize_chat_context_item(
            &json!({"kind": "editor", "label": "Open file", "text": "x", "path": "a.ts"})
        ),
        Some(json!({"kind": "editor", "label": "Open file", "text": "x"}))
    );
    assert_eq!(
        normalize_chat_context_item(&json!({
            "kind": "selection",
            "label": "S",
            "text": "x",
            "path": "/p/a.ts",
            "startLine": 5,
            "endLine": 2,
        })),
        Some(json!({"kind": "selection", "label": "S", "text": "x", "path": "/p/a.ts"}))
    );
    assert_eq!(
        normalize_chat_context_item(&json!({"kind": "nope", "label": "S", "text": "x"})),
        None
    );
}
