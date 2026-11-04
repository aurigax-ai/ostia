use chrono::{NaiveDateTime, Timelike};
use ostia_base::js::non_empty;
use ostia_contract::extensions::SidebarTone;
use ostia_contract::prompt_settings::{CoreChipId, PromptSettings, PromptStyle, separator_text};
use ostia_contract::pty_api::{
    OstiaPromptSpawn, PromptContext, PromptContextRequest, PromptSeparator,
};

use crate::terminal::blocks_store::CommandBlock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChipTone {
    Default,
    Ok,
    Warn,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShownChip {
    pub ext_id: String,
    pub id: String,
    pub text: String,
    pub tooltip: Option<String>,
    pub tone: SidebarTone,
    pub command: Option<String>,
}

impl ShownChip {
    pub fn new(ext_id: &str, id: &str, text: &str, tone: SidebarTone) -> Self {
        Self {
            ext_id: ext_id.to_owned(),
            id: id.to_owned(),
            text: text.to_owned(),
            tooltip: None,
            tone,
            command: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ChipValue {
    text: String,
    tooltip: Option<String>,
    tone: ChipTone,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedChip {
    pub id: String,
    pub core: Option<CoreChipId>,
    pub text: String,
    pub tooltip: Option<String>,
    pub tone: ChipTone,
    pub extension: Option<ShownChip>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LastCommand {
    pub exit_code: i64,
    pub started_at: i64,
    pub ended_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreChipInputs {
    pub cwd: Option<String>,
    pub context: Option<PromptContext>,
    pub last_command: Option<LastCommand>,
    pub now: NaiveDateTime,
    pub locale: String,
}

const CLOCK_CHIPS: [&str; 3] = ["date", "time12", "time24"];
const NARROW_NO_BREAK_SPACE: char = '\u{202f}';

pub fn contributed_chip_id(ext_id: &str, id: &str) -> String {
    format!("{ext_id}.{id}")
}

pub fn abbreviate_home(path: &str, home: Option<&str>) -> String {
    let Some(home) = non_empty(home) else {
        return path.to_owned();
    };
    if home == "/" {
        return path.to_owned();
    }
    let trimmed = home.trim_end_matches('/');
    if path == trimmed {
        return "~".to_owned();
    }
    match path
        .strip_prefix(trimmed)
        .filter(|rest| rest.starts_with('/'))
    {
        Some(rest) => format!("~{rest}"),
        None => path.to_owned(),
    }
}

fn to_fixed_one(seconds: f64) -> f64 {
    let quarters = seconds * 4.0;
    let tie = quarters.fract() == 0.0 && quarters.abs() % 2.0 == 1.0;
    let fixed = if tie {
        format!("{:.1}", (seconds * 10.0 + 0.5).floor() / 10.0)
    } else {
        format!("{seconds:.1}")
    };
    fixed.parse().unwrap_or(seconds)
}

pub fn format_duration(ms: i64) -> String {
    let safe = ms.max(0);
    if safe < 1000 {
        return format!("{safe}ms");
    }
    let seconds = safe as f64 / 1000.0;
    if seconds < 60.0 {
        return format!("{}s", to_fixed_one(seconds));
    }
    let whole = seconds.floor() as i64;
    let hours = whole / 3600;
    let minutes = (whole % 3600) / 60;
    let rest = whole % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m {rest}s")
    }
}

pub fn last_command(blocks: Option<&[CommandBlock]>) -> Option<LastCommand> {
    blocks?.iter().rev().find_map(|block| {
        Some(LastCommand {
            exit_code: block.exit_code?,
            started_at: block.started_at,
            ended_at: block.ended_at?,
        })
    })
}

fn plain(text: Option<&str>, tooltip: Option<&str>) -> Option<ChipValue> {
    non_empty(text).map(|text| ChipValue {
        text: text.to_owned(),
        tooltip: non_empty(tooltip).map(str::to_owned),
        tone: ChipTone::Default,
    })
}

fn date_text(now: &NaiveDateTime) -> String {
    now.format("%a, %b %d, %Y").to_string()
}

fn time12_text(now: &NaiveDateTime) -> String {
    let hour = match now.hour() % 12 {
        0 => 12,
        other => other,
    };
    let meridiem = if now.hour() < 12 { "AM" } else { "PM" };
    format!(
        "{hour:02}:{:02}{NARROW_NO_BREAK_SPACE}{meridiem}",
        now.minute()
    )
}

fn time24_text(now: &NaiveDateTime) -> String {
    let hour = if now.hour() == 0 { 24 } else { now.hour() };
    format!("{hour:02}:{:02}", now.minute())
}

fn core_chip_value(id: CoreChipId, inputs: &CoreChipInputs) -> Option<ChipValue> {
    let context = inputs.context.as_ref();
    match id {
        CoreChipId::Cwd => {
            let cwd = non_empty(inputs.cwd.as_deref())?;
            plain(
                Some(&abbreviate_home(cwd, context.map(|c| c.home.as_str()))),
                Some(cwd),
            )
        }
        CoreChipId::User => plain(context.map(|c| c.user.as_str()), None),
        CoreChipId::Host => plain(context.map(|c| c.host.as_str()), None),
        CoreChipId::Virtualenv => plain(context.and_then(|c| c.virtual_env.as_deref()), None),
        CoreChipId::Conda => plain(context.and_then(|c| c.conda_env.as_deref()), None),
        CoreChipId::Node => plain(context.and_then(|c| c.node_version.as_deref()), None),
        CoreChipId::Kube => plain(context.and_then(|c| c.kube_context.as_deref()), None),
        CoreChipId::Date => plain(Some(&date_text(&inputs.now)), None),
        CoreChipId::Time12 => plain(Some(&time12_text(&inputs.now)), None),
        CoreChipId::Time24 => plain(Some(&time24_text(&inputs.now)), None),
        CoreChipId::ExitCode => {
            let last = inputs.last_command?;
            Some(ChipValue {
                text: last.exit_code.to_string(),
                tooltip: None,
                tone: if last.exit_code == 0 {
                    ChipTone::Ok
                } else {
                    ChipTone::Error
                },
            })
        }
        CoreChipId::Duration => {
            let last = inputs.last_command?;
            plain(
                Some(&format_duration(last.ended_at - last.started_at)),
                None,
            )
        }
    }
}

fn pane_chip_tone(tone: SidebarTone) -> ChipTone {
    match tone {
        SidebarTone::Ok => ChipTone::Ok,
        SidebarTone::Warn => ChipTone::Warn,
        SidebarTone::Error => ChipTone::Error,
        SidebarTone::Neutral | SidebarTone::Brand => ChipTone::Default,
    }
}

pub fn resolve_prompt_chips(
    order: &[String],
    inputs: &CoreChipInputs,
    contributed: &[ShownChip],
) -> Vec<ResolvedChip> {
    let mut chips = Vec::new();
    for id in order {
        if let Some(core) = CoreChipId::from_id(id) {
            if let Some(value) = core_chip_value(core, inputs) {
                chips.push(ResolvedChip {
                    id: id.clone(),
                    core: Some(core),
                    text: value.text,
                    tooltip: value.tooltip,
                    tone: value.tone,
                    extension: None,
                });
            }
            continue;
        }
        let Some(extension) = contributed
            .iter()
            .find(|c| contributed_chip_id(&c.ext_id, &c.id) == *id)
            .filter(|c| !c.text.is_empty())
        else {
            continue;
        };
        chips.push(ResolvedChip {
            id: id.clone(),
            core: None,
            text: extension.text.clone(),
            tooltip: non_empty(extension.tooltip.as_deref()).map(str::to_owned),
            tone: pane_chip_tone(extension.tone),
            extension: Some(extension.clone()),
        });
    }
    chips
}

pub fn context_request(order: &[String]) -> PromptContextRequest {
    PromptContextRequest {
        node: order.iter().any(|id| id == "node"),
        kube: order.iter().any(|id| id == "kube"),
    }
}

pub fn needs_clock(order: &[String]) -> bool {
    order.iter().any(|id| CLOCK_CHIPS.contains(&id.as_str()))
}

pub fn prompt_line(chips: &[ResolvedChip], separator: PromptSeparator) -> String {
    let sep = separator_text(separator);
    let mut parts: Vec<&str> = chips.iter().map(|c| c.text.as_str()).collect();
    if !sep.is_empty() {
        parts.push(sep);
    }
    parts.join(" ")
}

pub fn move_chip(order: &[String], from: i64, to: i64) -> Vec<String> {
    let mut next = order.to_vec();
    let Ok(from_index) = usize::try_from(from) else {
        return next;
    };
    if from == to || from_index >= order.len() {
        return next;
    }
    let chip = next.remove(from_index);
    let at = usize::try_from(to.max(0)).map_or(next.len(), |at| at.min(next.len()));
    next.insert(at, chip);
    next
}

pub fn remove_chip(order: &[String], id: &str) -> Vec<String> {
    order.iter().filter(|c| *c != id).cloned().collect()
}

pub fn add_chip(order: &[String], id: &str) -> Vec<String> {
    let mut next = order.to_vec();
    if !order.iter().any(|c| c == id) {
        next.push(id.to_owned());
    }
    next
}

pub fn spawn_prompt_option(input_mode: &str, prompt: &PromptSettings) -> Option<OstiaPromptSpawn> {
    if prompt.style != PromptStyle::Ostia || input_mode != "editor" {
        return None;
    }
    Some(OstiaPromptSpawn {
        separator: prompt.separator,
        same_line: prompt.same_line,
    })
}
