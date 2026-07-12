use serde::Serialize;
use std::{env, fs, path::PathBuf, process::ExitCode};
use yt_dlp_tauri_lib::toolchain::{
    install_target, manifest_target, parse_manifest, probe_target, verify_toolchain_combination,
    InstallTargetRequest, NoopProgressReporter, ToolStatus,
};

#[derive(Debug)]
struct SmokeArguments {
    manifest: PathBuf,
    target: String,
    root: PathBuf,
    report: PathBuf,
    asset_root: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    target: String,
    tools: Vec<ToolStatus>,
    js_runtime_detected: bool,
    ffmpeg_detected: bool,
    deno_binary: String,
    ffmpeg_directory: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = parse_arguments(env::args().skip(1))?;
    let manifest_json = fs::read_to_string(&arguments.manifest).map_err(|error| {
        format!(
            "Failed to read manifest {}: {error}",
            arguments.manifest.display()
        )
    })?;
    let manifest = parse_manifest(&manifest_json)?;
    let target = manifest_target(&manifest, &arguments.target)?;
    let temp_root = arguments.root.join(".toolchain-downloads");
    let paths = install_target(InstallTargetRequest {
        target: &target,
        install_root: &arguments.root,
        temp_root: &temp_root,
        asset_root: arguments.asset_root.as_deref(),
        reporter: &NoopProgressReporter,
    })?;
    let tools = probe_target(&paths, &target)?;
    verify_toolchain_combination(&paths)?;
    let js_runtime_detected = tool_is_available(&tools, "deno");
    let ffmpeg_detected =
        tool_is_available(&tools, "ffmpeg") && tool_is_available(&tools, "ffprobe");
    let all_tools_available = tools.iter().all(|tool| tool.availability == "available");

    let report = SmokeReport {
        target: target.target,
        tools,
        js_runtime_detected,
        ffmpeg_detected,
        deno_binary: absolute_path(&paths.deno)?.display().to_string(),
        ffmpeg_directory: absolute_path(&paths.ffmpeg_dir)?.display().to_string(),
    };
    write_report(&arguments.report, &report)?;

    if !all_tools_available {
        return Err("One or more installed tools failed their native version probe".to_string());
    }
    Ok(())
}

fn parse_arguments(arguments: impl IntoIterator<Item = String>) -> Result<SmokeArguments, String> {
    let mut manifest = None;
    let mut target = None;
    let mut root = None;
    let mut report = None;
    let mut asset_root = None;
    let mut arguments = arguments.into_iter();

    while let Some(flag) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        let slot = match flag.as_str() {
            "--manifest" => &mut manifest,
            "--target" => &mut target,
            "--root" => &mut root,
            "--report" => &mut report,
            "--asset-root" => &mut asset_root,
            _ => return Err(format!("Unknown argument: {flag}")),
        };
        if slot.replace(value).is_some() {
            return Err(format!("{flag} may only be provided once"));
        }
    }

    Ok(SmokeArguments {
        manifest: PathBuf::from(manifest.ok_or("--manifest is required")?),
        target: target.ok_or("--target is required")?,
        root: PathBuf::from(root.ok_or("--root is required")?),
        report: PathBuf::from(report.ok_or("--report is required")?),
        asset_root: asset_root.map(PathBuf::from),
    })
}

fn tool_is_available(tools: &[ToolStatus], name: &str) -> bool {
    tools
        .iter()
        .any(|tool| tool.name == name && tool.availability == "available")
}

fn absolute_path(path: &std::path::Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve absolute path {}: {error}",
            path.display()
        )
    })
}

fn write_report(path: &std::path::Path, report: &SmokeReport) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare report directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let mut json = serde_json::to_string_pretty(report)
        .map_err(|error| format!("Failed to serialize smoke report: {error}"))?;
    json.push('\n');
    fs::write(path, json)
        .map_err(|error| format!("Failed to write smoke report {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_arguments() {
        let error = parse_arguments(["--unknown".to_string(), "value".to_string()]).unwrap_err();
        assert_eq!(error, "Unknown argument: --unknown");
    }

    #[test]
    fn parses_required_paths_and_target() {
        let arguments = parse_arguments([
            "--manifest".to_string(),
            "manifest.json".to_string(),
            "--target".to_string(),
            "win-x64".to_string(),
            "--root".to_string(),
            "tools".to_string(),
            "--report".to_string(),
            "report.json".to_string(),
            "--asset-root".to_string(),
            "candidate".to_string(),
        ])
        .unwrap();

        assert_eq!(arguments.manifest, PathBuf::from("manifest.json"));
        assert_eq!(arguments.target, "win-x64");
        assert_eq!(arguments.root, PathBuf::from("tools"));
        assert_eq!(arguments.report, PathBuf::from("report.json"));
        assert_eq!(arguments.asset_root, Some(PathBuf::from("candidate")));
    }
}
