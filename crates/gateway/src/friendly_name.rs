use std::sync::LazyLock;

use ostia_base::js::static_regex;
use ostia_base::random::random_bytes;
use regex::Regex;

const ADJECTIVES: [&str; 32] = [
    "amber", "brave", "bright", "calm", "clever", "cosmic", "crisp", "eager", "fancy", "gentle",
    "glad", "golden", "happy", "jolly", "keen", "kind", "lively", "lucky", "merry", "mighty",
    "noble", "plucky", "proud", "quick", "quiet", "rapid", "rosy", "shiny", "silver", "sunny",
    "swift", "witty",
];

const NOUNS: [&str; 32] = [
    "apple", "badger", "beacon", "birch", "breeze", "canyon", "cedar", "comet", "coral", "falcon",
    "fern", "harbor", "heron", "island", "juniper", "lantern", "maple", "meadow", "otter",
    "pebble", "pine", "raven", "river", "sparrow", "summit", "thistle", "tulip", "valley",
    "willow", "wren", "yarrow", "zephyr",
];

static FRIENDLY_NAME: LazyLock<Regex> = LazyLock::new(|| static_regex(r"^[a-z]+-[a-z]+$"));

pub fn is_friendly_name(text: &str) -> bool {
    FRIENDLY_NAME.is_match(text)
}

pub fn friendly_name_from(mut pick: impl FnMut(usize) -> usize) -> String {
    let adjective = ADJECTIVES[pick(ADJECTIVES.len()) % ADJECTIVES.len()];
    let noun = NOUNS[pick(NOUNS.len()) % NOUNS.len()];
    format!("{adjective}-{noun}")
}

pub fn random_friendly_name() -> String {
    friendly_name_from(|count| usize::from(random_bytes::<1>()[0]) % count)
}
