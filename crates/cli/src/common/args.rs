use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::LazyLock;

use ostia_base::js::{js_number, static_regex};
use regex::Regex;

static NEGATIVE_NUMBER: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"^-([0-9]+|[0-9]*\.[0-9]+)(e[+-]?[0-9]+)?$"));

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UnknownFlags {
    #[default]
    Refuse,
    Keep,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FlagSpec {
    pub values: &'static [(&'static str, &'static str)],
    pub lists: &'static [(&'static str, &'static str)],
    pub booleans: &'static [(&'static str, &'static str)],
    pub unknown: UnknownFlags,
}

#[derive(Debug, Default)]
pub struct ParsedArgs {
    pub positional: Vec<String>,
    pub values: BTreeMap<String, String>,
    pub lists: BTreeMap<String, Vec<String>>,
    pub booleans: BTreeMap<String, bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlagProblem {
    Unknown,
    MissingValue,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FlagError {
    pub problem: FlagProblem,
    pub flag: String,
}

impl fmt::Display for FlagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.problem {
            FlagProblem::Unknown => write!(f, "unknown flag {}", self.flag),
            FlagProblem::MissingValue => write!(f, "{} needs a value", self.flag),
        }
    }
}

impl std::error::Error for FlagError {}

#[derive(Debug)]
pub struct TimeoutError {
    raw: String,
}

impl fmt::Display for TimeoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "--timeout expects seconds, got '{}'", self.raw)
    }
}

impl std::error::Error for TimeoutError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Value,
    List,
    Boolean,
}

struct Flag {
    kind: Kind,
    key: &'static str,
    short: Option<&'static str>,
    long: Option<&'static str>,
}

impl Flag {
    fn new(kind: Kind, key: &'static str, text: &'static str) -> Self {
        let mut short = None;
        let mut long = None;
        for name in text.split(", ") {
            if name.starts_with("--") {
                long = Some(name);
            } else {
                short = Some(name);
            }
        }
        Self {
            kind,
            key,
            short,
            long,
        }
    }

    fn matches(&self, arg: &str) -> bool {
        self.short == Some(arg) || self.long == Some(arg)
    }

    fn written(&self) -> &'static str {
        self.long.or(self.short).unwrap_or_default()
    }
}

fn flags_of(spec: &FlagSpec) -> Vec<Flag> {
    spec.values
        .iter()
        .map(|&(key, text)| Flag::new(Kind::Value, key, text))
        .chain(
            spec.lists
                .iter()
                .map(|&(key, text)| Flag::new(Kind::List, key, text)),
        )
        .chain(
            spec.booleans
                .iter()
                .map(|&(key, text)| Flag::new(Kind::Boolean, key, text)),
        )
        .collect()
}

fn find<'a>(flags: &'a [Flag], arg: &str) -> Option<&'a Flag> {
    flags.iter().find(|flag| flag.matches(arg))
}

fn is_option(arg: &str) -> bool {
    arg.len() > 1 && arg.starts_with('-')
}

fn is_digit_short(flag: &Flag) -> bool {
    flag.short.is_some_and(|short| {
        short.len() == 2 && short[1..].bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn is_negative_number(arg: &str, flags: &[Flag]) -> bool {
    NEGATIVE_NUMBER.is_match(arg) && !flags.iter().any(is_digit_short)
}

fn combo_head(arg: &str) -> Option<(String, &str)> {
    let rest = arg.strip_prefix('-')?;
    let mut chars = rest.chars();
    let first = chars.next()?;
    let tail = chars.as_str();
    (first != '-' && !tail.is_empty()).then(|| (format!("-{first}"), tail))
}

fn take_value(
    flag: &Flag,
    inline: Option<String>,
    queue: &mut VecDeque<String>,
) -> Result<String, FlagError> {
    inline
        .or_else(|| queue.pop_front())
        .ok_or_else(|| FlagError {
            problem: FlagProblem::MissingValue,
            flag: flag.written().to_owned(),
        })
}

fn store(
    flag: &Flag,
    inline: Option<String>,
    queue: &mut VecDeque<String>,
    parsed: &mut ParsedArgs,
) -> Result<(), FlagError> {
    match flag.kind {
        Kind::Boolean => {
            parsed.booleans.insert(flag.key.to_owned(), true);
        }
        Kind::Value => {
            let value = take_value(flag, inline, queue)?;
            parsed.values.insert(flag.key.to_owned(), value);
        }
        Kind::List => {
            let value = take_value(flag, inline, queue)?;
            parsed
                .lists
                .entry(flag.key.to_owned())
                .or_default()
                .push(value);
        }
    }
    Ok(())
}

pub fn parse_args(argv: &[&str], spec: &FlagSpec) -> Result<ParsedArgs, FlagError> {
    let flags = flags_of(spec);
    let mut queue: VecDeque<String> = argv.iter().map(|arg| (*arg).to_owned()).collect();
    let mut parsed = ParsedArgs {
        positional: Vec::new(),
        values: BTreeMap::new(),
        lists: flags
            .iter()
            .filter(|flag| flag.kind == Kind::List)
            .map(|flag| (flag.key.to_owned(), Vec::new()))
            .collect(),
        booleans: flags
            .iter()
            .filter(|flag| flag.kind == Kind::Boolean)
            .map(|flag| (flag.key.to_owned(), false))
            .collect(),
    };
    let mut operands = Vec::new();
    let mut unknown = Vec::new();
    let mut in_unknown = false;

    while let Some(arg) = queue.pop_front() {
        if arg == "--" {
            let dest = if in_unknown {
                &mut unknown
            } else {
                &mut operands
            };
            dest.extend(queue.drain(..));
            break;
        }

        if is_option(&arg)
            && let Some(flag) = find(&flags, &arg)
        {
            store(flag, None, &mut queue, &mut parsed)?;
            continue;
        }

        if let Some((head, tail)) = combo_head(&arg)
            && let Some(flag) = find(&flags, &head)
        {
            if flag.kind == Kind::Boolean {
                store(flag, None, &mut queue, &mut parsed)?;
                queue.push_front(format!("-{tail}"));
            } else {
                store(flag, Some(tail.to_owned()), &mut queue, &mut parsed)?;
            }
            continue;
        }

        if let Some(rest) = arg.strip_prefix("--")
            && let Some(eq) = rest.find('=')
            && eq > 0
            && let Some(flag) = find(&flags, &arg[..eq + 2])
            && flag.kind != Kind::Boolean
        {
            store(
                flag,
                Some(rest[eq + 1..].to_owned()),
                &mut queue,
                &mut parsed,
            )?;
            continue;
        }

        if !in_unknown && is_option(&arg) && !is_negative_number(&arg, &flags) {
            in_unknown = true;
        }
        if in_unknown {
            unknown.push(arg);
        } else {
            operands.push(arg);
        }
    }

    if !unknown.is_empty() && spec.unknown == UnknownFlags::Refuse {
        return Err(FlagError {
            problem: FlagProblem::Unknown,
            flag: unknown[0].clone(),
        });
    }

    operands.extend(unknown);
    parsed.positional = operands;
    Ok(parsed)
}

pub fn parse_timeout_seconds(raw: Option<&str>) -> Result<Option<f64>, TimeoutError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let seconds = js_number(raw);
    if !seconds.is_finite() || seconds <= 0.0 {
        return Err(TimeoutError {
            raw: raw.to_owned(),
        });
    }
    Ok(Some(seconds))
}
