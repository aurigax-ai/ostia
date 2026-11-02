use std::collections::HashSet;

const ADJECTIVES: [&str; 32] = [
    "amber", "brisk", "calm", "cobalt", "coral", "crisp", "dusky", "eager", "fuzzy", "gentle",
    "golden", "hazel", "indigo", "jolly", "keen", "lively", "lucky", "mellow", "misty", "nimble",
    "opal", "plucky", "quiet", "rustic", "silver", "snug", "sunny", "swift", "tidal", "velvet",
    "witty", "zesty",
];

const NOUNS: [&str; 32] = [
    "acorn", "badger", "birch", "comet", "cricket", "dune", "ember", "falcon", "fern", "finch",
    "glacier", "harbor", "heron", "juniper", "kestrel", "lagoon", "lantern", "maple", "meadow",
    "otter", "pebble", "quartz", "raven", "reef", "sparrow", "spruce", "thistle", "tundra",
    "walnut", "willow", "wren", "yarrow",
];

fn pick<R: FnMut() -> f64>(list: &[&'static str], random: &mut R) -> &'static str {
    let index = (random() * list.len() as f64).floor() as usize;
    list[index.min(list.len() - 1)]
}

pub fn code_name(taken: &HashSet<String>, mut random: impl FnMut() -> f64) -> String {
    for _ in 0..ADJECTIVES.len() * NOUNS.len() {
        let adjective = pick(&ADJECTIVES, &mut random);
        let noun = pick(&NOUNS, &mut random);
        let name = format!("{adjective}-{noun}");
        if !taken.contains(&name) {
            return name;
        }
    }
    let base = format!("{}-{}", ADJECTIVES[0], NOUNS[0]);
    let mut n = 2;
    while taken.contains(&format!("{base}-{n}")) {
        n += 1;
    }
    format!("{base}-{n}")
}
