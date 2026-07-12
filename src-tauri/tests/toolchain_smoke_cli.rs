use std::process::Command;

#[test]
fn smoke_cli_requires_all_paths() {
    let output = Command::new(env!("CARGO_BIN_EXE_toolchain-smoke"))
        .output()
        .expect("smoke binary should start");
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--manifest is required"));
}
