use super::{
    install::verify_sha256, relative_manifest_tool_path, ManifestTarget, ManifestTool, ToolPaths,
    ToolStatus,
};
use std::{
    ffi::OsStr,
    fs,
    path::Path,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const COMBINATION_PROBE_TIMEOUT: Duration = Duration::from_secs(60);

pub fn probe_target(paths: &ToolPaths, target: &ManifestTarget) -> Result<Vec<ToolStatus>, String> {
    target
        .tools
        .iter()
        .map(|tool| probe_manifest_tool(&paths.root, tool))
        .collect()
}

pub fn require_tools(tools: &ToolPaths) -> Result<(), String> {
    for path in [&tools.yt_dlp, &tools.ffmpeg, &tools.ffprobe, &tools.deno] {
        if !path.exists() {
            return Err(format!("Missing tool: {}", path.display()));
        }
    }
    Ok(())
}

pub fn verify_toolchain_combination(paths: &ToolPaths) -> Result<(), String> {
    require_tools(paths)?;
    let work_root = std::env::temp_dir().join(format!(
        "yt-dlp-tauri-combination-probe-{}-{}",
        std::process::id(),
        unique_nonce()
    ));
    fs::create_dir(&work_root).map_err(|error| {
        format!(
            "Failed to create toolchain combination probe directory {}: {error}",
            work_root.display()
        )
    })?;

    let result = (|| {
        let media_path = work_root.join("probe.mp4");
        let mut ffmpeg = background_command(&paths.ffmpeg);
        ffmpeg.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x64:rate=1",
            "-t",
            "1",
            "-c:v",
            "mpeg4",
            "-pix_fmt",
            "yuv420p",
        ]);
        ffmpeg.arg(&media_path);
        run_bounded_probe(&mut ffmpeg, "FFmpeg local media probe")?;

        let mut ffprobe = background_command(&paths.ffprobe);
        ffprobe.args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
        ]);
        ffprobe.arg(&media_path);
        let ffprobe_output = run_bounded_probe(&mut ffprobe, "FFprobe local media probe")?;
        if !String::from_utf8_lossy(&ffprobe_output.stdout)
            .lines()
            .any(|line| line.trim() == "video")
        {
            return Err("FFprobe did not detect the generated video stream".to_string());
        }

        let media_url = reqwest::Url::from_file_path(&media_path).map_err(|_| {
            format!(
                "Failed to convert toolchain probe path to a file URL: {}",
                media_path.display()
            )
        })?;
        let mut yt_dlp = background_command(&paths.yt_dlp);
        yt_dlp.args([
            "--ignore-config",
            "--no-playlist",
            "--simulate",
            "--no-warnings",
            "--enable-file-urls",
            "--no-js-runtimes",
            "--js-runtimes",
        ]);
        yt_dlp.arg(format!("deno:{}", paths.deno.display()));
        yt_dlp.arg("--ffmpeg-location");
        yt_dlp.arg(&paths.ffmpeg_dir);
        yt_dlp.arg(media_url.as_str());
        run_bounded_probe(&mut yt_dlp, "yt-dlp local toolchain probe")?;
        Ok(())
    })();

    let cleanup_result = fs::remove_dir_all(&work_root).map_err(|error| {
        format!(
            "Failed to clean toolchain combination probe directory {}: {error}",
            work_root.display()
        )
    });
    match (result, cleanup_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn run_bounded_probe(command: &mut Command, label: &str) -> Result<Output, String> {
    run_bounded_probe_with_timeout(command, label, COMBINATION_PROBE_TIMEOUT)
}

fn run_bounded_probe_with_timeout(
    command: &mut Command,
    label: &str,
    timeout: Duration,
) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {label}: {error}"))?;
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Failed to poll {label}: {error}"))?
        {
            Some(_) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| format!("Failed to collect {label} output: {error}"))?;
                if output.status.success() {
                    return Ok(output);
                }
                return Err(process_failure_message(
                    label,
                    output.status.code(),
                    &output.stderr,
                    &output.stdout,
                ));
            }
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{label} timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn unique_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn probe_manifest_tool(root: &Path, tool: &ManifestTool) -> Result<ToolStatus, String> {
    let relative_path = relative_manifest_tool_path(tool)?;
    let full_path = root.join(relative_path);
    let mut status = probe_tool(
        &tool.name,
        &tool.path,
        &full_path,
        tool_version_args(&tool.name),
    );
    status.expected_version = tool.version.clone();

    if status.availability == "available" {
        let hash_matches = verify_sha256(&full_path, &tool.sha256).is_ok();
        status.availability = availability_for_manifest_probe(&status.availability, hash_matches);
        if !hash_matches {
            status.error = Some("Installed tool does not match the pinned manifest".to_string());
        }
    }
    Ok(status)
}

fn tool_version_args(name: &str) -> &'static [&'static str] {
    match name {
        "ffmpeg" | "ffprobe" => &["-version"],
        _ => &["--version"],
    }
}

pub(crate) fn probe_executable(name: &str, full_path: &Path) -> ToolStatus {
    probe_tool(
        name,
        &full_path.display().to_string(),
        full_path,
        tool_version_args(name),
    )
}

fn availability_for_manifest_probe(availability: &str, sha_matches: bool) -> String {
    if availability == "available" && !sha_matches {
        "outdated".to_string()
    } else {
        availability.to_string()
    }
}

fn probe_tool(
    name: &str,
    relative_path: &str,
    full_path: &Path,
    version_args: &[&str],
) -> ToolStatus {
    if !full_path.exists() {
        return ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "missing".to_string(),
            version: None,
            expected_version: None,
            error: Some("Tool file is missing".to_string()),
        };
    }

    let mut command = background_command(full_path);
    command.args(version_args);
    let label = format!("{name} version probe at {}", full_path.display());
    match run_bounded_probe_with_timeout(&mut command, &label, VERSION_PROBE_TIMEOUT) {
        Ok(output) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "available".to_string(),
            version: first_line(&output.stdout),
            expected_version: None,
            error: None,
        },
        Err(error) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            expected_version: None,
            error: Some(error),
        },
    }
}

fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn process_failure_message(
    context: &str,
    exit_code: Option<i32>,
    stderr: &[u8],
    stdout: &[u8],
) -> String {
    let detail = first_line(stderr).or_else(|| first_line(stdout));
    match detail {
        Some(detail) => format!("{context} Exit code {}: {detail}", exit_code.unwrap_or(-1)),
        None => format!("{context} Exit code {}", exit_code.unwrap_or(-1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_available_tool_outdated_when_manifest_hash_mismatches() {
        assert_eq!(
            availability_for_manifest_probe("available", true),
            "available"
        );
        assert_eq!(
            availability_for_manifest_probe("available", false),
            "outdated"
        );
        assert_eq!(availability_for_manifest_probe("missing", false), "missing");
        assert_eq!(
            availability_for_manifest_probe("cannot_execute", false),
            "cannot_execute"
        );
    }
}
