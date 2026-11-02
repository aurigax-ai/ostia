use std::collections::HashMap;

use ostia_base::js::js_trim;
use ostia_contract::incident::{
    CallPhase, INCIDENT_BLOCK_TAG, IncidentBlock, IncidentEvent, IncidentSnapshot,
    parse_incident_block, trigger_words,
};
use serde_json::{Map, Value};

use crate::incident_timeline::{IncidentTake, PaneSnapshot, RawEvent};

const SECOND: f64 = 1000.0;
const NEVER_RETURNED: &str = "never returned";

#[derive(Debug, Clone)]
pub struct FactsAgent {
    pub kind: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct IncidentFacts {
    pub app: String,
    pub platform: String,
    pub agent: FactsAgent,
    pub settings: Map<String, Value>,
    pub counts: Map<String, Value>,
    pub since_min: u64,
    pub unseen: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct IncidentWords {
    pub happened: String,
    pub expected: String,
}

#[derive(Debug, thiserror::Error)]
#[error("the incident block does not pass its checks")]
pub struct IncidentBlockError;

fn state_words(state: &str) -> Option<&'static str> {
    match state {
        "working" => Some("working"),
        "waiting" => Some("waiting for you"),
        "done" | "idle" => Some("idle"),
        "error" => Some("failed"),
        "hibernated" => Some("hibernated"),
        "waking" => Some("starting"),
        "exited" => Some("exited"),
        "shell" => Some("at a shell"),
        _ => None,
    }
}

fn unseen_words(item: &str) -> Option<&'static str> {
    match item {
        "agent-internals" => Some("the agent's own screen and reasoning"),
        "terminal-text" => Some("terminal text"),
        "model-output" => Some("model output"),
        "prompt-text" => Some("prompts and messages"),
        _ => None,
    }
}

fn is_at_prompt(state: &str) -> bool {
    matches!(state, "waiting" | "done" | "idle" | "shell")
}

fn snapshot_value(snapshot: &PaneSnapshot) -> Value {
    let mut map = Map::new();
    map.insert("agent".to_owned(), Value::from(snapshot.agent.as_str()));
    map.insert("state".to_owned(), Value::from(snapshot.state.as_str()));
    map.insert("drafting".to_owned(), Value::from(snapshot.drafting));
    map.insert("mail".to_owned(), Value::from(snapshot.mail));
    map.insert("alive".to_owned(), Value::from(snapshot.alive));
    Value::Object(map)
}

fn phase_name(phase: CallPhase) -> &'static str {
    match phase {
        CallPhase::Start => "start",
        CallPhase::End => "end",
        CallPhase::Cancel => "cancel",
        CallPhase::Phase => "phase",
    }
}

fn event_value(event: &RawEvent, first: i64, aliases: &[(String, String)]) -> Value {
    let mut map = Map::new();
    let relative = event.at() - first;
    match event {
        RawEvent::Call {
            method,
            phase,
            from,
            name,
            ms,
            code,
            before,
            after,
            ..
        } => {
            map.insert("k".to_owned(), Value::from("call"));
            map.insert("at".to_owned(), Value::from(relative));
            map.insert("method".to_owned(), Value::from(method.as_str()));
            let alias = from.as_deref().and_then(|from| {
                aliases
                    .iter()
                    .find(|(real, _)| real == from)
                    .map(|(_, alias)| alias.as_str())
            });
            if let Some(alias) = alias.filter(|alias| !alias.is_empty()) {
                map.insert("from".to_owned(), Value::from(alias));
            }
            map.insert("phase".to_owned(), Value::from(phase_name(*phase)));
            if let Some(name) = name {
                map.insert("name".to_owned(), Value::from(name.as_str()));
            }
            if let Some(ms) = ms {
                map.insert("ms".to_owned(), Value::from(*ms));
            }
            if let Some(code) = code {
                map.insert("code".to_owned(), Value::from(code.as_str()));
            }
            if let Some(before) = before {
                map.insert("before".to_owned(), snapshot_value(before));
            }
            if let Some(after) = after {
                map.insert("after".to_owned(), snapshot_value(after));
            }
        }
        RawEvent::State { to, from, .. } => {
            map.insert("k".to_owned(), Value::from("state"));
            map.insert("at".to_owned(), Value::from(relative));
            map.insert("to".to_owned(), Value::from(to.as_str()));
            if let Some(from) = from {
                map.insert("from".to_owned(), Value::from(from.as_str()));
            }
        }
        RawEvent::Hook { ok, code, .. } => {
            map.insert("k".to_owned(), Value::from("hook"));
            map.insert("at".to_owned(), Value::from(relative));
            map.insert("ok".to_owned(), Value::from(*ok));
            if let Some(code) = code {
                map.insert("code".to_owned(), Value::from(code.as_str()));
            }
        }
        RawEvent::Mail { code, age, .. } => {
            map.insert("k".to_owned(), Value::from("mail"));
            map.insert("at".to_owned(), Value::from(relative));
            map.insert("code".to_owned(), Value::from(code.as_str()));
            if let Some(age) = age {
                map.insert("age".to_owned(), Value::from(*age));
            }
        }
        RawEvent::Wake { code, ms, .. } => {
            map.insert("k".to_owned(), Value::from("wake"));
            map.insert("at".to_owned(), Value::from(relative));
            map.insert("code".to_owned(), Value::from(code.as_str()));
            map.insert("ms".to_owned(), Value::from(*ms));
        }
    }
    Value::Object(map)
}

pub fn incident_block(
    take: &IncidentTake,
    facts: &IncidentFacts,
) -> Result<IncidentBlock, IncidentBlockError> {
    let mut aliases: Vec<(String, String)> = Vec::new();
    for caller in &take.callers {
        if *caller != take.pane_id && !aliases.iter().any(|(real, _)| real == caller) {
            let alias = format!("P{}", aliases.len() + 1);
            aliases.push((caller.clone(), alias));
        }
    }
    let target_alias = format!("P{}", aliases.len() + 1);
    aliases.push((take.pane_id.clone(), target_alias.clone()));
    let first = take.events.first().map_or(0, RawEvent::at);
    let events: Vec<Value> = take
        .events
        .iter()
        .map(|event| event_value(event, first, &aliases))
        .collect();
    let mut agent = Map::new();
    agent.insert("kind".to_owned(), Value::from(facts.agent.kind.as_str()));
    if let Some(version) = &facts.agent.version {
        agent.insert("version".to_owned(), Value::from(version.as_str()));
    }
    let mut block = Map::new();
    block.insert("version".to_owned(), Value::from(1));
    block.insert("app".to_owned(), Value::from(facts.app.as_str()));
    block.insert("platform".to_owned(), Value::from(facts.platform.as_str()));
    block.insert("agent".to_owned(), Value::Object(agent));
    block.insert("settings".to_owned(), Value::Object(facts.settings.clone()));
    block.insert("pane".to_owned(), Value::from(target_alias));
    block.insert("trigger".to_owned(), Value::from(take.trigger.as_str()));
    block.insert("events".to_owned(), Value::Array(events));
    block.insert(
        "unseen".to_owned(),
        Value::Array(
            facts
                .unseen
                .iter()
                .map(|item| Value::from(item.as_str()))
                .collect(),
        ),
    );
    block.insert("counts".to_owned(), Value::Object(facts.counts.clone()));
    block.insert("sinceMin".to_owned(), Value::from(facts.since_min));
    parse_incident_block(&Value::Object(block)).ok_or(IncidentBlockError)
}

fn to_fixed_one(value: f64) -> String {
    if value < 0.0 {
        return format!("-{}", to_fixed_one(-value));
    }
    let value = value + 0.0;
    let quarters = value * 4.0;
    let is_tie = quarters.fract() == 0.0 && (quarters as u64) % 2 == 1;
    if is_tie {
        let tenths = (value * 10.0 + 0.5).floor() as u64;
        return format!("{}.{}", tenths / 10, tenths % 10);
    }
    format!("{value:.1}")
}

fn seconds(ms: u64) -> String {
    format!("{} s", to_fixed_one(ms as f64 / SECOND))
}

fn spaced(code: &str) -> String {
    code.replace('-', " ")
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn state_text(state: &str) -> String {
    state_words(state).map_or_else(|| spaced(state), str::to_owned)
}

fn snapshot_words(snapshot: &IncidentSnapshot) -> String {
    let mut parts = vec![
        state_text(&snapshot.state),
        if is_at_prompt(&snapshot.state) {
            "at prompt".to_owned()
        } else {
            "no prompt".to_owned()
        },
        if snapshot.drafting {
            "draft present".to_owned()
        } else {
            "draft empty".to_owned()
        },
    ];
    if snapshot.mail > 0 {
        parts.push(format!("mail {} queued", snapshot.mail));
    }
    parts.join(" · ")
}

fn headline(block: &IncidentBlock) -> String {
    let mut causes: Vec<String> = Vec::new();
    for event in &block.events {
        let cause: Option<String> = match event {
            IncidentEvent::Mail { code, .. } | IncidentEvent::Wake { code, .. } => {
                Some(code.clone())
            }
            IncidentEvent::Call {
                phase: CallPhase::End,
                code,
                ..
            } => code.clone(),
            IncidentEvent::Hook {
                ok: false, code, ..
            } => Some(code.clone().unwrap_or_else(|| "hook-failed".to_owned())),
            _ => None,
        };
        if let Some(cause) = cause.filter(|cause| !cause.is_empty())
            && !causes.contains(&cause)
        {
            causes.push(cause);
        }
    }
    let chosen = if causes.is_empty() {
        vec![block.trigger.clone()]
    } else {
        causes
    };
    chosen
        .iter()
        .take(2)
        .map(|cause| trigger_words(cause))
        .enumerate()
        .map(|(index, text)| if index == 0 { text } else { lower_first(&text) })
        .collect::<Vec<_>>()
        .join(", then ")
}

struct Row {
    at: u64,
    who: String,
    verb: String,
    what: String,
    details: Vec<String>,
}

fn rows(block: &IncidentBlock) -> Vec<Row> {
    let target = &block.pane;
    let mut out: Vec<Row> = Vec::new();
    let mut pending: HashMap<String, usize> = HashMap::new();
    for event in &block.events {
        match event {
            IncidentEvent::Call {
                at,
                method,
                from,
                phase,
                name,
                ms,
                code,
                before,
                after,
            } => {
                let key = format!("{method}|{}", from.as_deref().unwrap_or(""));
                let who = match from {
                    Some(from) if !from.is_empty() => format!("{from}→{target}"),
                    _ => target.clone(),
                };
                match phase {
                    CallPhase::Start => {
                        let mut row = Row {
                            at: *at,
                            who,
                            verb: method.clone(),
                            what: NEVER_RETURNED.to_owned(),
                            details: Vec::new(),
                        };
                        if let Some(before) = before {
                            row.details
                                .push(format!("before: {}", snapshot_words(before)));
                        }
                        pending.insert(key, out.len());
                        out.push(row);
                    }
                    CallPhase::Phase => {
                        if let Some(index) = pending.get(&key).copied() {
                            let part = format!(
                                "{} {}",
                                spaced(name.as_deref().unwrap_or("phase")),
                                seconds(ms.unwrap_or(0))
                            );
                            let row = &mut out[index];
                            row.what = if row.what == NEVER_RETURNED {
                                part
                            } else {
                                format!("{}  {part}", row.what)
                            };
                        }
                    }
                    CallPhase::End | CallPhase::Cancel => {
                        let open = pending.remove(&key);
                        let outcome = if matches!(phase, CallPhase::Cancel) {
                            "cancelled".to_owned()
                        } else {
                            match code {
                                Some(code) if !code.is_empty() => spaced(code),
                                _ => "ok".to_owned(),
                            }
                        };
                        let timing = ms.map_or_else(String::new, |ms| format!(" {}", seconds(ms)));
                        match open {
                            Some(index) => {
                                let row = &mut out[index];
                                let phases = if row.what == NEVER_RETURNED {
                                    String::new()
                                } else {
                                    format!("  {}", row.what)
                                };
                                row.what = format!("{outcome}{timing}{phases}");
                                if let Some(after) = after {
                                    row.details
                                        .push(format!("after:  {}", snapshot_words(after)));
                                }
                            }
                            None => out.push(Row {
                                at: *at,
                                who,
                                verb: method.clone(),
                                what: format!("{outcome}{timing}"),
                                details: Vec::new(),
                            }),
                        }
                    }
                }
            }
            IncidentEvent::State { at, to, from } => {
                let from = from
                    .as_deref()
                    .filter(|from| !from.is_empty())
                    .map_or_else(String::new, |from| format!("{} → ", state_text(from)));
                out.push(Row {
                    at: *at,
                    who: target.clone(),
                    verb: "state".to_owned(),
                    what: format!("{from}{}", state_text(to)),
                    details: Vec::new(),
                });
            }
            IncidentEvent::Hook { at, ok, code } => {
                let what = if *ok {
                    spaced(
                        code.as_deref()
                            .filter(|code| !code.is_empty())
                            .unwrap_or("received"),
                    )
                } else {
                    format!("failed {}", spaced(code.as_deref().unwrap_or("")))
                        .trim()
                        .to_owned()
                };
                out.push(Row {
                    at: *at,
                    who: target.clone(),
                    verb: "hook".to_owned(),
                    what,
                    details: Vec::new(),
                });
            }
            IncidentEvent::Mail { at, code, age } => {
                let old = match age {
                    Some(age) if *age > 0 => format!(" ({} old)", seconds(*age)),
                    _ => String::new(),
                };
                out.push(Row {
                    at: *at,
                    who: target.clone(),
                    verb: "mail".to_owned(),
                    what: format!("{}{old}", spaced(code)),
                    details: Vec::new(),
                });
            }
            IncidentEvent::Wake { at, code, ms } => out.push(Row {
                at: *at,
                who: target.clone(),
                verb: "wake".to_owned(),
                what: format!("{} {}", spaced(code), seconds(*ms)),
                details: Vec::new(),
            }),
        }
    }
    out
}

fn event_at(event: &IncidentEvent) -> u64 {
    match event {
        IncidentEvent::Call { at, .. }
        | IncidentEvent::State { at, .. }
        | IncidentEvent::Hook { at, .. }
        | IncidentEvent::Mail { at, .. }
        | IncidentEvent::Wake { at, .. } => *at,
    }
}

fn pad_start(text: &str, width: usize) -> String {
    let length = text.chars().count();
    format!("{}{text}", " ".repeat(width.saturating_sub(length)))
}

fn pad_end(text: &str, width: usize) -> String {
    let length = text.chars().count();
    format!("{text}{}", " ".repeat(width.saturating_sub(length)))
}

fn timeline(block: &IncidentBlock) -> Vec<String> {
    let end = block.events.last().map_or(0, event_at);
    let list = rows(block);
    let stamps: Vec<String> = list
        .iter()
        .map(|row| {
            let behind = end as f64 - row.at as f64;
            format!("-{}", to_fixed_one(behind / SECOND))
        })
        .collect();
    let widest = |values: Vec<&str>| values.iter().map(|v| v.chars().count()).max().unwrap_or(0);
    let time_width = widest(stamps.iter().map(String::as_str).collect());
    let who_width = widest(list.iter().map(|row| row.who.as_str()).collect());
    let verb_width = widest(list.iter().map(|row| row.verb.as_str()).collect());
    let mut lines = Vec::new();
    for (index, row) in list.iter().enumerate() {
        lines.push(format!(
            "{}  {}  {}  {}",
            pad_start(&stamps[index], time_width),
            pad_end(&row.who, who_width),
            pad_end(&row.verb, verb_width),
            row.what
        ));
        for detail in &row.details {
            lines.push(format!(
                "{}{detail}",
                " ".repeat(time_width + who_width + verb_width + 6)
            ));
        }
    }
    lines
}

fn target_line(block: &IncidentBlock) -> String {
    let end = block.events.last().map_or(0, event_at);
    let mut last: Option<&IncidentSnapshot> = None;
    let mut hook: Option<(Option<&str>, u64)> = None;
    for event in &block.events {
        match event {
            IncidentEvent::Call { before, after, .. } => {
                last = after.as_ref().or(before.as_ref()).or(last);
            }
            IncidentEvent::Hook { ok: true, code, at } => hook = Some((code.as_deref(), *at)),
            _ => {}
        }
    }
    let hooks_on = block
        .settings
        .get("hooks")
        .is_some_and(|value| value == &Value::Bool(true));
    let hooks = if hooks_on {
        "hooks installed"
    } else {
        "hooks off"
    };
    let last_hook = match hook {
        Some((code, at)) => format!(
            "last hook {} {} before",
            spaced(code.filter(|code| !code.is_empty()).unwrap_or("received")),
            seconds(end.saturating_sub(at))
        ),
        None => "no hook received in the window".to_owned(),
    };
    let body = match last {
        Some(snapshot) => format!(
            "{} · foreground {}",
            if snapshot.alive {
                "pty alive"
            } else {
                "pty gone"
            },
            if snapshot.agent == "none" {
                "shell"
            } else {
                snapshot.agent.as_str()
            }
        ),
        None => "state not recorded".to_owned(),
    };
    format!(
        "{} at the failure: {hooks} · {last_hook} · {body}",
        block.pane
    )
}

fn background(block: &IncidentBlock) -> String {
    let mut by_method: Vec<(String, Vec<(String, u64)>)> = Vec::new();
    for (key, value) in &block.counts {
        let count = value.as_u64().unwrap_or(0);
        let (method, result) = match key.rfind('.') {
            Some(dot) => (&key[..dot], &key[dot + 1..]),
            None => (&key[..key.len().saturating_sub(1)], key.as_str()),
        };
        let slot = match by_method.iter().position(|(name, _)| name == method) {
            Some(index) => index,
            None => {
                by_method.push((method.to_owned(), Vec::new()));
                by_method.len() - 1
            }
        };
        let results = &mut by_method[slot].1;
        match results.iter_mut().find(|(name, _)| name == result) {
            Some(entry) => entry.1 = count,
            None => results.push((result.to_owned(), count)),
        }
    }
    let total = |results: &[(String, u64)]| results.iter().map(|(_, n)| *n).sum::<u64>();
    by_method.sort_by_key(|(_, results)| std::cmp::Reverse(total(results)));
    let parts: Vec<String> = by_method
        .iter()
        .take(6)
        .map(|(method, results)| {
            let ok = results
                .iter()
                .find(|(name, _)| name == "ok")
                .map_or(0, |(_, n)| *n);
            let mut shown = vec![format!("{ok} ok")];
            shown.extend(
                results
                    .iter()
                    .filter(|(name, _)| name != "ok")
                    .map(|(name, n)| format!("{n} {}", spaced(name))),
            );
            format!("{method} {}", shown.join(" / "))
        })
        .collect();
    let listed = if parts.is_empty() {
        "no calls".to_owned()
    } else {
        parts.join(" · ")
    };
    format!("Background ({} min): {listed}", block.since_min)
}

fn fenceless(text: &str) -> String {
    let trimmed = js_trim(text);
    let mut out = String::new();
    let mut ticks = 0;
    for ch in trimmed.chars() {
        if ch == '`' {
            ticks += 1;
            continue;
        }
        flush_ticks(&mut out, ticks);
        ticks = 0;
        out.push(ch);
    }
    flush_ticks(&mut out, ticks);
    out
}

fn flush_ticks(out: &mut String, ticks: usize) {
    if ticks >= 3 {
        out.push_str("'''");
    } else {
        out.push_str(&"`".repeat(ticks));
    }
}

pub fn incident_text(block: &IncidentBlock, words: &IncidentWords) -> String {
    let settings = block
        .settings
        .iter()
        .map(|(key, on)| {
            format!(
                "{key}={}",
                if on == &Value::Bool(true) {
                    "on"
                } else {
                    "off"
                }
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    let has_callers = block.events.iter().any(
        |event| matches!(event, IncidentEvent::Call { from: Some(from), .. } if !from.is_empty()),
    );
    let unseen = block
        .unseen
        .iter()
        .map(|item| unseen_words(item).map_or_else(|| spaced(item), str::to_owned))
        .collect::<Vec<_>>()
        .join(", ");
    let version = block
        .agent
        .version
        .as_deref()
        .filter(|version| !version.is_empty())
        .map_or_else(String::new, |version| format!(" {version}"));
    let happened = fenceless(&words.happened);
    let expected = fenceless(&words.expected);
    let mut lines = vec![
        format!("**{}**", headline(block)),
        format!(
            "Ostia {} · {} · agent {}{version}",
            block.app, block.platform, block.agent.kind
        ),
        format!(
            "Settings: {}",
            if settings.is_empty() {
                "none"
            } else {
                settings.as_str()
            }
        ),
        format!(
            "Panes: {}{} = target",
            if has_callers { "P1 = caller · " } else { "" },
            block.pane
        ),
        String::new(),
        format!(
            "What happened (their words): {}",
            if happened.is_empty() {
                "(not written)"
            } else {
                happened.as_str()
            }
        ),
        format!(
            "What they expected: {}",
            if expected.is_empty() {
                "(not written)"
            } else {
                expected.as_str()
            }
        ),
        String::new(),
        "Timeline (seconds before the report)".to_owned(),
    ];
    lines.extend(timeline(block));
    lines.push(String::new());
    lines.push(target_line(block));
    lines.push(format!(
        "Ostia could not see: {}",
        if unseen.is_empty() {
            "nothing recorded"
        } else {
            unseen.as_str()
        }
    ));
    lines.push(background(block));
    lines.push(String::new());
    lines.push(format!("```{INCIDENT_BLOCK_TAG} json"));
    lines.push(serde_json::to_string_pretty(block).unwrap_or_default());
    lines.push("```".to_owned());
    lines.join("\n")
}
