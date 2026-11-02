use ostia_contract::dict::Dict;

use super::merge_eligibility::MergeOptionRefusal;

pub fn merge_refusal_text(dict: &Dict, refusal: Option<MergeOptionRefusal>) -> Option<String> {
    let key = match refusal? {
        MergeOptionRefusal::OtherWindow => "otherWindow",
        MergeOptionRefusal::SandboxMixed => "sandbox-mixed",
        MergeOptionRefusal::SandboxDiffers => "sandbox-differs",
    };
    dict.get("merge")?.get(key)?.as_str().map(str::to_owned)
}
