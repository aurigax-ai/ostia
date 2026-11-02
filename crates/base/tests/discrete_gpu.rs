#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;

use ostia_base::discrete_gpu::{
    GPU_RESTORE_ENV, GpuStartPlan, SwitcherooGpu, default_gpu_render_node, discrete_gpu,
    gpu_relaunch_env, gpu_start_plan, parse_gpu_environment, parse_switcheroo_gpus,
    query_switcheroo_gpus, read_switcheroo_gpus, render_node_of, restore_gpu_launch_env,
    several_render_nodes, without_gpu_launch_env,
};
use serde_json::{Value, json};

type Env = BTreeMap<String, String>;

fn env(items: &[(&str, &str)]) -> Env {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn reply() -> Value {
    json!({
        "type": "aa{sv}",
        "data": [
            {
                "Name": {"type": "s", "data": "Intel Corporation DG2 [Arc A370M]"},
                "Environment": {"type": "as", "data": ["DRI_PRIME", "pci-0000_03_00_0", "VK_LOADER_DRIVERS_SELECT", "*intel*"]},
                "Default": {"type": "b", "data": false},
                "Discrete": {"type": "b", "data": true}
            },
            {
                "Name": {"type": "s", "data": "Intel Corporation Raptor Lake-P [UHD Graphics]"},
                "Environment": {"type": "as", "data": ["DRI_PRIME", "pci-0000_00_02_0", "VK_LOADER_DRIVERS_SELECT", "*intel*"]},
                "Default": {"type": "b", "data": true},
                "Discrete": {"type": "b", "data": false}
            }
        ]
    })
}

fn arc() -> SwitcherooGpu {
    SwitcherooGpu {
        name: "Intel Corporation DG2 [Arc A370M]".to_owned(),
        is_default: false,
        discrete: true,
        environment: env(&[
            ("DRI_PRIME", "pci-0000_03_00_0"),
            ("VK_LOADER_DRIVERS_SELECT", "*intel*"),
        ]),
    }
}

fn merged(base: &Env, patch: &Env) -> Env {
    let mut out = base.clone();
    out.extend(patch.clone());
    out
}

#[test]
fn reads_every_gpu_from_busctls_json_reply() {
    let gpus = parse_switcheroo_gpus(&reply().to_string()).unwrap();
    assert_eq!(gpus.len(), 2);
    assert_eq!(gpus[0], arc());
    assert!(gpus[1].is_default);
    assert_eq!(discrete_gpu(Some(gpus.as_slice())), Some(&arc()));
}

#[test]
fn returns_null_for_a_reply_that_is_not_json_or_not_the_gpus_property() {
    assert_eq!(parse_switcheroo_gpus("not json"), None);
    assert_eq!(
        parse_switcheroo_gpus(&json!({"type": "s", "data": "x"}).to_string()),
        None
    );
}

#[test]
fn skips_a_gpu_whose_environment_has_a_variable_outside_the_allowlist() {
    let mut reply = reply();
    reply["data"][0]["Environment"]["data"]
        .as_array_mut()
        .unwrap()
        .extend([json!("LD_PRELOAD"), json!("/tmp/evil.so")]);
    let gpus = parse_switcheroo_gpus(&reply.to_string()).unwrap();
    let names: Vec<&str> = gpus.iter().map(|gpu| gpu.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Intel Corporation Raptor Lake-P [UHD Graphics]"]
    );
    assert_eq!(discrete_gpu(Some(gpus.as_slice())), None);
}

#[test]
fn finds_no_discrete_gpu_when_the_only_discrete_one_is_the_default() {
    let only = SwitcherooGpu {
        is_default: true,
        ..arc()
    };
    assert_eq!(discrete_gpu(Some([only].as_slice())), None);
    assert_eq!(discrete_gpu(None), None);
}

#[test]
fn skips_an_entry_without_a_name_and_reads_missing_flags_as_false() {
    let reply = json!({
        "type": "aa{sv}",
        "data": [
            {"Environment": {"type": "as", "data": ["DRI_PRIME", "pci-0000_03_00_0"]}},
            {"Name": {"type": "s", "data": "Bare"}, "Environment": {"type": "as", "data": ["DRI_PRIME", "pci-0000_04_00_0"]}},
            {"Name": {"type": "x", "data": "WrongVariant"}, "Environment": {"type": "as", "data": ["DRI_PRIME", "pci-0000_05_00_0"]}},
            "text",
            null
        ]
    });
    let gpus = parse_switcheroo_gpus(&reply.to_string()).unwrap();
    assert_eq!(gpus.len(), 1);
    assert_eq!(gpus[0].name, "Bare");
    assert!(!gpus[0].is_default);
    assert!(!gpus[0].discrete);
}

#[test]
fn accepts_the_nvidia_offload_variables() {
    assert_eq!(
        parse_gpu_environment(&json!([
            "__NV_PRIME_RENDER_OFFLOAD",
            "1",
            "__GLX_VENDOR_LIBRARY_NAME",
            "nvidia",
            "__VK_LAYER_NV_optimus",
            "NVIDIA_only"
        ])),
        Some(env(&[
            ("__NV_PRIME_RENDER_OFFLOAD", "1"),
            ("__GLX_VENDOR_LIBRARY_NAME", "nvidia"),
            ("__VK_LAYER_NV_optimus", "NVIDIA_only"),
        ]))
    );
}

#[test]
fn rejects_other_keys_odd_lists_non_strings_and_nul_bytes() {
    assert_eq!(parse_gpu_environment(&json!(["PATH", "/tmp"])), None);
    assert_eq!(parse_gpu_environment(&json!(["DRI_PRIME"])), None);
    assert_eq!(parse_gpu_environment(&json!([])), None);
    assert_eq!(parse_gpu_environment(&json!(["DRI_PRIME", 1])), None);
    assert_eq!(
        parse_gpu_environment(&json!(["DRI_PRIME", "a\u{0}b"])),
        None
    );
    assert_eq!(parse_gpu_environment(&json!("DRI_PRIME=1")), None);
}

#[test]
fn rejects_a_value_longer_than_256_units_and_accepts_one_of_exactly_256() {
    let exact = "a".repeat(256);
    assert!(parse_gpu_environment(&json!(["DRI_PRIME", exact])).is_some());
    let over = "a".repeat(257);
    assert_eq!(parse_gpu_environment(&json!(["DRI_PRIME", over])), None);
    let emoji = "😀".repeat(129);
    assert_eq!(parse_gpu_environment(&json!(["DRI_PRIME", emoji])), None);
}

#[test]
fn adds_the_gpus_environment_and_remembers_the_values_it_replaced() {
    let patch = gpu_relaunch_env(&env(&[("VK_LOADER_DRIVERS_SELECT", "*amd*")]), &arc()).unwrap();
    for (key, value) in &arc().environment {
        assert_eq!(patch.get(key), Some(value));
    }
    let restore: Value = serde_json::from_str(&patch[GPU_RESTORE_ENV]).unwrap();
    assert_eq!(
        restore,
        json!({"DRI_PRIME": null, "VK_LOADER_DRIVERS_SELECT": "*amd*"})
    );
}

#[test]
fn never_relaunches_a_process_that_was_already_relaunched() {
    assert_eq!(
        gpu_relaunch_env(&env(&[(GPU_RESTORE_ENV, "{}")]), &arc()),
        None
    );
}

#[test]
fn does_not_relaunch_a_process_started_with_the_gpus_environment() {
    assert_eq!(gpu_relaunch_env(&arc().environment, &arc()), None);
}

#[test]
fn relaunches_once_then_stays() {
    assert!(matches!(
        gpu_start_plan(&env(&[]), &arc(), |_| true),
        GpuStartPlan::Relaunch { .. }
    ));
    let relaunched = merged(
        &arc().environment,
        &gpu_relaunch_env(&env(&[]), &arc()).unwrap(),
    );
    assert!(matches!(
        gpu_start_plan(&relaunched, &arc(), |_| true),
        GpuStartPlan::Stay { .. }
    ));
}

#[test]
fn stays_on_the_render_node_of_the_gpu_when_it_exists() {
    let relaunched = merged(
        &arc().environment,
        &gpu_relaunch_env(&env(&[]), &arc()).unwrap(),
    );
    assert_eq!(
        gpu_start_plan(&relaunched, &arc(), |_| true),
        GpuStartPlan::Stay {
            render_node: Some("/dev/dri/by-path/pci-0000:03:00.0-render".to_owned())
        }
    );
    assert_eq!(
        gpu_start_plan(&relaunched, &arc(), |_| false),
        GpuStartPlan::Stay { render_node: None }
    );
}

#[test]
fn maps_a_dri_prime_pci_tag_to_its_render_node() {
    assert_eq!(
        render_node_of(Some("pci-0000_03_00_0"), |_| true).as_deref(),
        Some("/dev/dri/by-path/pci-0000:03:00.0-render")
    );
}

#[test]
fn ignores_other_dri_prime_forms_and_missing_devices() {
    assert_eq!(render_node_of(Some("1"), |_| true), None);
    assert_eq!(
        render_node_of(Some("pci-0000_03_00_0/../../x"), |_| true),
        None
    );
    assert_eq!(render_node_of(None, |_| true), None);
    assert_eq!(render_node_of(Some("pci-0000_03_00_0"), |_| false), None);
    assert_eq!(render_node_of(Some("pci-0000_03_00_8"), |_| true), None);
    assert_eq!(render_node_of(Some("pci-0000_03_00_٠"), |_| true), None);
    assert_eq!(render_node_of(Some("pci-0000_03_00_0\n"), |_| true), None);
}

fn gpu(name: &str, is_default: bool, discrete: bool, bus_device: &str) -> SwitcherooGpu {
    SwitcherooGpu {
        name: name.to_owned(),
        is_default,
        discrete,
        environment: env(&[("DRI_PRIME", &format!("pci-0000_{bus_device}_0"))]),
    }
}

fn several() -> Vec<SwitcherooGpu> {
    vec![
        gpu("Arc", false, true, "03_00"),
        gpu("UHD", true, false, "00_02"),
    ]
}

#[test]
fn gpu_u2_pins_the_default_gpu_wherever_the_kernel_numbered_the_discrete_one() {
    assert_eq!(
        default_gpu_render_node(&env(&[]), Some(several().as_slice()), |_| true).as_deref(),
        Some("/dev/dri/by-path/pci-0000:00:02.0-render")
    );
}

#[test]
fn gpu_u3_leaves_a_human_who_set_dri_prime_alone() {
    assert_eq!(
        default_gpu_render_node(
            &env(&[("DRI_PRIME", "1")]),
            Some(several().as_slice()),
            |_| true
        ),
        None
    );
}

#[test]
fn gpu_u3_leaves_a_human_who_set_dri_prime_to_an_empty_value_alone() {
    assert_eq!(
        default_gpu_render_node(
            &env(&[("DRI_PRIME", "")]),
            Some(several().as_slice()),
            |_| true
        ),
        None
    );
}

#[test]
fn gpu_u4_pins_nothing_without_switcheroo_a_default_gpu_or_its_node() {
    assert_eq!(default_gpu_render_node(&env(&[]), None, |_| true), None);
    assert_eq!(
        default_gpu_render_node(&env(&[]), Some(&several()[..1]), |_| true),
        None
    );
    assert_eq!(
        default_gpu_render_node(&env(&[]), Some(several().as_slice()), |_| false),
        None
    );
}

#[test]
fn gpu_u5_asks_switcheroo_only_when_more_than_one_render_node_exists() {
    let names = |list: &[&str]| -> std::io::Result<Vec<String>> {
        Ok(list.iter().map(|name| (*name).to_owned()).collect())
    };
    assert!(!several_render_nodes(|_| names(&["card0", "renderD128"])));
    assert!(several_render_nodes(|_| names(&[
        "card0",
        "card1",
        "renderD128",
        "renderD129"
    ])));
    assert!(!several_render_nodes(|_| Err(std::io::Error::from(
        std::io::ErrorKind::NotFound
    ))));
}

#[test]
fn gives_panes_back_the_environment_from_before_the_relaunch() {
    let patch = gpu_relaunch_env(&env(&[("VK_LOADER_DRIVERS_SELECT", "*amd*")]), &arc()).unwrap();
    let launched = merged(
        &merged(&env(&[("PATH", "/bin")]), &arc().environment),
        &patch,
    );
    assert_eq!(
        without_gpu_launch_env(&launched),
        env(&[("PATH", "/bin"), ("VK_LOADER_DRIVERS_SELECT", "*amd*")])
    );
}

#[test]
fn leaves_an_environment_the_human_set_themselves_alone() {
    let own = env(&[("PATH", "/bin"), ("DRI_PRIME", "1")]);
    assert_eq!(without_gpu_launch_env(&own), own);
}

#[test]
fn restores_nothing_outside_the_allowlist_from_a_tampered_marker() {
    let tampered = env(&[
        ("PATH", "/bin"),
        (GPU_RESTORE_ENV, &json!({"PATH": "/tmp"}).to_string()),
    ]);
    assert_eq!(without_gpu_launch_env(&tampered), env(&[("PATH", "/bin")]));
}

#[test]
fn drops_the_marker_and_restores_nothing_from_a_marker_that_is_not_json() {
    let broken = env(&[
        ("PATH", "/bin"),
        ("DRI_PRIME", "9"),
        (GPU_RESTORE_ENV, "{nope"),
    ]);
    assert_eq!(
        without_gpu_launch_env(&broken),
        env(&[("PATH", "/bin"), ("DRI_PRIME", "9")])
    );
}

#[test]
fn puts_the_process_environment_back_before_a_restart() {
    let mut launched = merged(
        &merged(&env(&[("PATH", "/bin")]), &arc().environment),
        &gpu_relaunch_env(&env(&[]), &arc()).unwrap(),
    );
    restore_gpu_launch_env(&mut launched);
    assert_eq!(launched, env(&[("PATH", "/bin")]));
}

fn fake_busctl_env() -> (ostia_testscript::ScriptsGuard, tempfile::TempDir, Env) {
    let scripts = ostia_testscript::lock();
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("busctl");
    ostia_testscript::write_script(
        &script,
        "#!/bin/sh\nif [ -n \"${HOME+x}\" ] || [ -n \"${DRI_PRIME+x}\" ] || [ \"$MARKER\" != yes ]; then exit 1; fi\necho '{\"type\":\"aa{sv}\",\"data\":[]}'\n",
        0o755,
    )
    .unwrap();
    let env = Env::from([
        ("PATH".to_owned(), dir.path().to_string_lossy().into_owned()),
        ("MARKER".to_owned(), "yes".to_owned()),
    ]);
    (scripts, dir, env)
}

#[test]
fn reads_the_gpus_with_a_child_that_sees_only_the_passed_environment() {
    let (_scripts, _dir, env) = fake_busctl_env();
    assert_eq!(read_switcheroo_gpus(&env), Some(Vec::new()));
}

#[tokio::test]
async fn queries_the_gpus_with_a_child_that_sees_only_the_passed_environment() {
    let (_scripts, _dir, env) = fake_busctl_env();
    assert_eq!(query_switcheroo_gpus(&env).await, Some(Vec::new()));
}
