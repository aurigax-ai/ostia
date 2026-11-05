#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use ostia_contract::agent_stream::{EditChange, PlanItem, PlanStatus, StreamEvent};
use ostia_contract::turn_hook::TurnStepKind;
use ostia_gateway::stream_frames::{FrameTooLarge, pack_frames, split_event};
use serde_json::{Number, Value, json};

const MAX: usize = 2000;

fn payloads(frames: &[String]) -> Vec<Value> {
    frames
        .iter()
        .map(|frame| {
            let parsed: Value = serde_json::from_str(frame).unwrap();
            parsed["params"]["payload"].clone()
        })
        .collect()
}

fn values(events: &[StreamEvent]) -> Vec<Value> {
    events
        .iter()
        .map(|event| serde_json::to_value(event).unwrap())
        .collect()
}

fn event_values(frames: &[String]) -> Vec<Value> {
    payloads(frames)
        .iter()
        .flat_map(|payload| payload["events"].as_array().unwrap().clone())
        .collect()
}

fn rejoin(events: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for event in events {
        let appends = event.get("append").is_some();
        let joins = appends
            && out
                .last()
                .is_some_and(|prev| prev["type"] == event["type"] && prev["id"] == event["id"]);
        if !joins {
            out.push(event.clone());
            continue;
        }
        let prev = out.last_mut().unwrap().as_object_mut().unwrap();
        for key in ["text", "input", "output", "diff", "target"] {
            if let Some(piece) = event.get(key).and_then(Value::as_str) {
                let head = prev.get(key).and_then(Value::as_str).unwrap_or("");
                prev.insert(key.to_owned(), Value::String(format!("{head}{piece}")));
            }
        }
        if let Some(items) = event.get("items").and_then(Value::as_array) {
            let head = prev
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            prev.insert(
                "items".to_owned(),
                Value::Array([head, items.clone()].concat()),
            );
        }
    }
    out
}

fn text(id: &str, body: String) -> StreamEvent {
    StreamEvent::Text {
        turn: "u1".to_owned(),
        id: id.to_owned(),
        text: body,
        append: false,
    }
}

fn prompt(body: String) -> StreamEvent {
    StreamEvent::Prompt {
        turn: "u1".to_owned(),
        id: "p".to_owned(),
        text: body,
        append: false,
    }
}

fn tool_result(output: String) -> StreamEvent {
    StreamEvent::ToolResult {
        turn: "u1".to_owned(),
        id: "tu1".to_owned(),
        output,
        exit_code: None,
        is_error: false,
        append: false,
    }
}

fn plan(items: Vec<PlanItem>) -> StreamEvent {
    StreamEvent::Plan {
        turn: "u1".to_owned(),
        id: "pl".to_owned(),
        items,
        append: false,
    }
}

fn step(text: String) -> PlanItem {
    PlanItem {
        text,
        status: PlanStatus::Pending,
    }
}

fn tool(target: Option<String>, input: Option<String>) -> StreamEvent {
    StreamEvent::Tool {
        turn: "u1".to_owned(),
        id: "tu".to_owned(),
        kind: TurnStepKind::Other,
        name: "X".to_owned(),
        target,
        input,
        append: false,
    }
}

fn assert_under_cap(frames: &[String], cap: usize) {
    for frame in frames {
        assert!(frame.len() <= cap, "{} > {cap}", frame.len());
    }
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/rust/gateway-stream-frames.json");
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn puts_small_events_into_one_frame_with_the_pane_seq_and_backfill_flag() {
    let events = vec![
        StreamEvent::TurnStarted {
            turn: "u1".to_owned(),
        },
        prompt("hi".to_owned()),
    ];
    let frames = pack_frames("pane-1", 7, true, &events, MAX).unwrap();
    assert_eq!(
        payloads(&frames),
        vec![json!({"paneId": "pane-1", "seq": 7, "backfill": true, "events": values(&events)})]
    );
}

#[test]
fn numbers_frames_in_order_and_keeps_each_under_the_cap() {
    let events: Vec<StreamEvent> = (0..60)
        .map(|i| text(&format!("t{i}"), "x".repeat(100)))
        .collect();
    let frames = pack_frames("pane-1", 1, false, &events, MAX).unwrap();
    assert!(frames.len() > 1);
    assert_under_cap(&frames, MAX);
    let seqs: Vec<Value> = payloads(&frames).iter().map(|p| p["seq"].clone()).collect();
    let expected: Vec<Value> = (1..=frames.len()).map(|n| json!(n)).collect();
    assert_eq!(seqs, expected);
    assert_eq!(event_values(&frames), values(&events));
}

#[test]
fn splits_one_huge_output_across_frames_and_loses_none_of_it() {
    let output = format!("{}\n\"quoted\"\t{}", "é€𝄞".repeat(2000), "\\".repeat(500));
    let big = StreamEvent::ToolResult {
        turn: "u1".to_owned(),
        id: "tu1".to_owned(),
        output,
        exit_code: Some(Number::from(3)),
        is_error: true,
        append: false,
    };
    let frames = pack_frames("pane-1", 1, true, std::slice::from_ref(&big), MAX).unwrap();
    assert!(frames.len() > 3);
    assert_under_cap(&frames, MAX);
    let events = event_values(&frames);
    assert_eq!(events[0]["exitCode"], json!(3));
    assert_eq!(events[0]["isError"], json!(true));
    assert!(
        events[1..].iter().all(|e| {
            e.get("append").is_some() && e["type"] == "tool.result" && e["id"] == "tu1"
        })
    );
    assert_eq!(rejoin(&events), values(&[big]));
}

#[test]
fn splits_a_diff_and_a_prompt_the_same_way() {
    let edit = StreamEvent::Edit {
        turn: "u1".to_owned(),
        id: "e1".to_owned(),
        path: "a.ts".to_owned(),
        change: EditChange::Update,
        diff: "+line\n".repeat(3000),
        append: false,
    };
    let long_prompt = prompt("word ".repeat(2000));
    let expected = values(&[edit.clone(), long_prompt.clone()]);
    let frames = pack_frames("pane-1", 1, false, &[edit, long_prompt], MAX).unwrap();
    assert_eq!(rejoin(&event_values(&frames)), expected);
}

#[test]
fn splits_a_long_plan_between_items() {
    let long_plan = plan(
        (0..200)
            .map(|i| step(format!("step {i} {}", "y".repeat(30))))
            .collect(),
    );
    let frames = pack_frames("pane-1", 1, false, std::slice::from_ref(&long_plan), MAX).unwrap();
    assert_under_cap(&frames, MAX);
    assert_eq!(rejoin(&event_values(&frames)), values(&[long_plan]));
}

#[test]
fn split_event_leaves_an_event_that_fits_whole() {
    assert_eq!(
        split_event(&StreamEvent::Live, 100).unwrap(),
        vec![StreamEvent::Live]
    );
}

#[test]
fn splits_a_tool_call_whose_target_is_huge_and_has_no_other_body() {
    let call = tool(Some("p".repeat(5000)), None);
    let frames = pack_frames("pane-1", 1, false, std::slice::from_ref(&call), MAX).unwrap();
    assert_under_cap(&frames, MAX);
    assert_eq!(rejoin(&event_values(&frames)), values(&[call]));
}

#[test]
fn splits_a_tool_call_with_both_a_huge_target_and_a_huge_input() {
    let call = tool(Some("p".repeat(5000)), Some("i".repeat(7000)));
    let frames = pack_frames("pane-1", 1, false, std::slice::from_ref(&call), MAX).unwrap();
    assert_under_cap(&frames, MAX);
    assert_eq!(rejoin(&event_values(&frames)), values(&[call]));
}

#[test]
fn refuses_an_event_it_cannot_split_rather_than_send_it_over_the_cap() {
    let long_plan = plan(vec![step("x".repeat(5000))]);
    let error = pack_frames("pane-1", 1, false, &[long_plan], MAX).unwrap_err();
    assert_eq!(error, FrameTooLarge::new("plan item too large"));
}

#[test]
fn refuses_a_tool_call_whose_name_alone_is_over_the_budget() {
    let event = StreamEvent::Tool {
        turn: "u1".to_owned(),
        id: "tu".to_owned(),
        kind: TurnStepKind::Other,
        name: "n".repeat(5000),
        target: None,
        input: Some("x".to_owned()),
        append: false,
    };
    let error = split_event(&event, 1000).unwrap_err();
    assert_eq!(error, FrameTooLarge::new("event does not fit a frame"));
}

#[test]
fn splits_a_multi_megabyte_output_in_linear_time() {
    let output = "a line of build output\n".repeat(250_000);
    let started = Instant::now();
    let frames = pack_frames("pane-1", 1, true, &[tool_result(output)], 1024 * 1024).unwrap();
    assert!(started.elapsed().as_millis() < 3000);
    assert!(frames.len() > 4);
    assert_under_cap(&frames, 1024 * 1024);
}

#[test]
fn refuses_an_oversize_event_that_has_no_body_field_to_split() {
    let event = StreamEvent::Session {
        session: "s".repeat(5000),
    };
    let error = split_event(&event, 1000).unwrap_err();
    assert_eq!(error, FrameTooLarge::new("event has nothing to split"));
    assert!(pack_frames("pane-1", 1, false, &[event], MAX).is_err());
}

#[test]
fn packs_no_frame_for_no_events() {
    assert_eq!(
        pack_frames("pane-1", 1, false, &[], MAX).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn leaves_the_backfill_flag_out_of_a_live_frame() {
    let frames = pack_frames("pane-1", 3, false, &[StreamEvent::Live], MAX).unwrap();
    let payload = &payloads(&frames)[0];
    assert!(payload.get("backfill").is_none());
    assert_eq!(payload["seq"], json!(3));
}

#[test]
fn writes_the_envelope_keys_in_the_order_the_phone_reads_them() {
    let frames = pack_frames("pane-1", 7, true, &[StreamEvent::Live], MAX).unwrap();
    assert_eq!(
        frames[0],
        r#"{"jsonrpc":"2.0","method":"event","params":{"type":"agent.stream","payload":{"paneId":"pane-1","seq":7,"backfill":true,"events":[{"type":"live"}]}}}"#
    );
}

#[test]
fn splits_a_tool_call_by_its_longest_body_field_and_keeps_the_short_one_in_the_head() {
    let call = tool(Some("t".repeat(10)), Some("i".repeat(4000)));
    let frames = pack_frames("pane-1", 1, false, std::slice::from_ref(&call), 700).unwrap();
    assert_under_cap(&frames, 700);
    assert_eq!(rejoin(&event_values(&frames)), values(&[call]));
}

#[test]
fn packs_the_same_frames_as_the_ts_packer() {
    let fixture = fixture();
    let events: Vec<StreamEvent> = serde_json::from_value(fixture["events"].clone()).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let frames = pack_frames(
            case["paneId"].as_str().unwrap(),
            case["firstSeq"].as_u64().unwrap(),
            case["backfill"].as_bool().unwrap(),
            &events,
            usize::try_from(case["maxBytes"].as_u64().unwrap()).unwrap(),
        )
        .unwrap();
        let expected: Vec<String> = case["frames"]
            .as_array()
            .unwrap()
            .iter()
            .map(|frame| frame.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(frames, expected, "{}", case["maxBytes"]);
    }
}
