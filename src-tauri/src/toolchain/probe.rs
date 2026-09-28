use super::{
    install::verify_sha256, relative_manifest_tool_path, ManifestTarget, ManifestTool, ToolPaths,
    ToolStatus,
};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
    sync::atomic::AtomicBool,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
        if !path.is_file() {
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
        let mut ffmpeg = Command::new(&paths.ffmpeg);
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

        let mut ffprobe = Command::new(&paths.ffprobe);
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
        let mut yt_dlp = Command::new(&paths.yt_dlp);
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
    let mut stdout = Vec::new();
    let output = crate::process::run(
        command,
        label,
        Some(timeout),
        &AtomicBool::new(false),
        |line| {
            stdout.extend_from_slice(line.as_bytes());
            stdout.push(b'\n');
        },
    )?;
    if !output.status.success() {
        return Err(process_failure_message(
            label,
            output.status.code(),
            &output.stderr,
            &stdout,
        ));
    }
    Ok(Output {
        status: output.status,
        stdout,
        stderr: output.stderr,
    })
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
        Some(&tool.sha256),
    );
    status.expected_version = tool.version.clone();
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
        None,
    )
}

fn probe_tool(
    name: &str,
    relative_path: &str,
    full_path: &Path,
    version_args: &[&str],
    expected_sha256: Option<&str>,
) -> ToolStatus {
    let mut status = ToolStatus {
        name: name.to_string(),
        relative_path: relative_path.to_string(),
        full_path: full_path.display().to_string(),
        availability: "missing".to_string(),
        version: None,
        expected_version: None,
        error: None,
    };
    if !full_path.is_file() {
        status.error = Some("Tool file is missing".to_string());
        return status;
    }
    if let Some(expected) = expected_sha256 {
        if let Err(error) = verify_sha256(full_path, expected) {
            status.availability = "outdated".to_string();
            status.error = Some(error);
            return status;
        }
    }

    let mut command = Command::new(full_path);
    command.args(version_args);
    let label = format!("{name} version probe at {}", full_path.display());
    match run_bounded_probe_with_timeout(&mut command, &label, VERSION_PROBE_TIMEOUT) {
        Ok(output) => {
            status.availability = "available".to_string();
            status.version = first_line(&output.stdout);
        },
        Err(error) => {
            status.availability = "cannot_execute".to_string();
            status.error = Some(error);
        },
    }
    status
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
    fn managed_probe_checks_hash_before_execution_and_local_probe_does_not_pin_hash() {
        let root = std::env::temp_dir().join(format!("yt-dlp-probe-{}-{}", std::process::id(), unique_nonce()));
        fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        let (filename, script) = ("probe", "#!/bin/sh\nprintf executed > \"$0.executed\"\nprintf 'fixture-version\\n'\n");
        #[cfg(windows)]
        let (filename, script) = ("probe.cmd", "@echo off\r\necho executed > \"%~f0.executed\"\r\necho fixture-version\r\n");
        let path = root.join(filename);
        let marker = root.join(format!("{filename}.executed"));
        fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut tool = ManifestTool {
            name: "yt-dlp".to_string(), path: format!("Tools/win-x64/{filename}"),
            source_url: "https://example.test/tool".to_string(), source_size: None, source_sha256: None,
            version: Some("fixture-version".to_string()), sha256: "0".repeat(64),
            kind: super::super::ManifestToolKind::File, archive_path_suffix: None, license_notes: None,
        };
        let rejected = probe_manifest_tool(&root, &tool).unwrap();
        assert_eq!(rejected.availability, "outdated");
        assert!(rejected.error.unwrap().contains("SHA-256 mismatch"));
        assert!(!marker.exists(), "an unverified executable must not run");

        tool.sha256 = super::super::sha256_bytes(script.as_bytes());
        let accepted = probe_manifest_tool(&root, &tool).unwrap();
        assert_eq!(accepted.availability, "available");
        assert_eq!(accepted.version.as_deref(), Some("fixture-version"));
        assert!(marker.is_file());

        fs::remove_file(&marker).unwrap();
        assert_eq!(probe_executable("yt-dlp", &path).availability, "available");
        assert!(marker.is_file());
        fs::remove_file(&path).unwrap();
        assert_eq!(probe_manifest_tool(&root, &tool).unwrap().availability, "missing");
        fs::remove_dir_all(root).unwrap();
    }
}
