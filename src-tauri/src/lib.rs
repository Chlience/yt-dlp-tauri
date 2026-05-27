use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const TOOLS_DIRECTORY: &str = "Tools";
const TOOLS_MANIFEST_FILE: &str = "tools-manifest.json";
const PROGRESS_PREFIX: &str = "yt-dlp-tauri-progress:";
const OUTPUT_PATH_PREFIX: &str = "yt-dlp-tauri-output:";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
struct AppState {
    download_directory: String,
    tools_root: String,
}

#[derive(Debug, Serialize)]
struct ToolStatus {
    name: String,
    relative_path: String,
    full_path: String,
    availability: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct VideoMetadata {
    title: String,
    id: Option<String>,
    webpage_url: String,
    thumbnail_url: Option<String>,
    thumbnail_urls: Vec<String>,
    duration_seconds: Option<f64>,
    description: Option<String>,
    format_options: Vec<VideoFormatOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VideoFormatOption {
    label: String,
    format_selector: String,
    height: Option<u32>,
    extension: String,
    is_best: bool,
}

#[derive(Debug, Deserialize)]
struct DownloadRequest {
    url: String,
    format_selector: String,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    percent: Option<f64>,
    status: String,
    speed: Option<String>,
    eta: Option<String>,
    raw: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ToolInstallProgress {
    percent: Option<f64>,
    status: String,
    tool: Option<String>,
}

#[derive(Debug, Clone)]
struct ToolPaths {
    root: PathBuf,
    yt_dlp: PathBuf,
    yt_dlp_relative_path: String,
    ffmpeg: PathBuf,
    ffmpeg_relative_path: String,
    ffmpeg_dir: PathBuf,
    ffprobe: PathBuf,
    ffprobe_relative_path: String,
    deno: PathBuf,
    deno_relative_path: String,
}

#[derive(Debug, Clone, Copy)]
struct ToolNames {
    yt_dlp: &'static str,
    ffmpeg: &'static str,
    ffprobe: &'static str,
    deno: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsManifest {
    schema_version: u32,
    targets: Vec<ManifestTarget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTarget {
    target: String,
    tools: Vec<ManifestTool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTool {
    name: String,
    path: String,
    source_url: String,
    #[serde(rename = "version")]
    _version: Option<String>,
    sha256: String,
    kind: ManifestToolKind,
    archive_path_suffix: Option<String>,
    #[serde(rename = "licenseNotes")]
    _license_notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ManifestToolKind {
    File,
    Zip,
}

#[derive(Clone, Default)]
struct DownloadProcessState {
    active_pid: Arc<Mutex<Option<u32>>>,
    cancel_requested: Arc<Mutex<bool>>,
}

#[tauri::command]
async fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = locate_tools(&app)?;
        ensure_writable_directories()?;
        Ok(AppState {
            download_directory: download_directory()?.display().to_string(),
            tools_root: tools.root.display().to_string(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn set_download_directory(directory: String) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = directory.trim();
        if trimmed.is_empty() {
            return Err("Download directory cannot be empty.".to_string());
        }

        let path = PathBuf::from(trimmed);
        fs::create_dir_all(&path).map_err(to_string)?;
        let state_dir = state_directory()?;
        fs::create_dir_all(&state_dir).map_err(to_string)?;
        fs::write(
            state_dir.join("download-directory.txt"),
            path.display().to_string(),
        )
        .map_err(to_string)?;

        Ok(AppState {
            download_directory: path.display().to_string(),
            tools_root: String::new(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn reset_download_directory() -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state_file = state_directory()?.join("download-directory.txt");
        if state_file.exists() {
            fs::remove_file(state_file).map_err(to_string)?;
        }

        let directory = download_directory()?;
        fs::create_dir_all(&directory).map_err(to_string)?;
        Ok(AppState {
            download_directory: directory.display().to_string(),
            tools_root: String::new(),
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn open_download_directory() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = download_directory()?;
        fs::create_dir_all(&directory).map_err(to_string)?;
        open_path(&directory)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn check_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tools = locate_tools(&app)?;
        Ok(vec![
            probe_tool(
                "yt-dlp",
                &tools.yt_dlp_relative_path,
                &tools.yt_dlp,
                &["--version"],
            ),
            probe_tool(
                "ffmpeg",
                &tools.ffmpeg_relative_path,
                &tools.ffmpeg,
                &["-version"],
            ),
            probe_tool(
                "ffprobe",
                &tools.ffprobe_relative_path,
                &tools.ffprobe,
                &["-version"],
            ),
            probe_tool(
                "deno",
                &tools.deno_relative_path,
                &tools.deno,
                &["--version"],
            ),
        ])
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn install_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target_name = current_tool_target()?;
        let target = read_manifest_target(&app, &target_name)?;
        let root = writable_tools_root(&target_name)?;
        fs::create_dir_all(&root).map_err(to_string)?;

        emit_tool_install_progress(
            &app,
            ToolInstallProgress {
                percent: Some(0.0),
                status: format!("Installing toolchain for {target_name}"),
                tool: None,
            },
        );

        install_manifest_target(&app, &target, &root)?;

        emit_tool_install_progress(
            &app,
            ToolInstallProgress {
                percent: Some(100.0),
                status: "Toolchain installed.".to_string(),
                tool: None,
            },
        );

        let tools = locate_tools(&app)?;
        Ok(vec![
            probe_tool(
                "yt-dlp",
                &tools.yt_dlp_relative_path,
                &tools.yt_dlp,
                &["--version"],
            ),
            probe_tool(
                "ffmpeg",
                &tools.ffmpeg_relative_path,
                &tools.ffmpeg,
                &["-version"],
            ),
            probe_tool(
                "ffprobe",
                &tools.ffprobe_relative_path,
                &tools.ffprobe,
                &["-version"],
            ),
            probe_tool(
                "deno",
                &tools.deno_relative_path,
                &tools.deno,
                &["--version"],
            ),
        ])
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn parse_metadata(app: AppHandle, url: String) -> Result<VideoMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_http_url(&url)?;
        let tools = locate_tools(&app)?;
        require_tools(&tools)?;
        append_log("metadata", &format!("Parsing {url}"));

        let mut command = background_command(&tools.yt_dlp);
        let output = command
            .args([
                "--ignore-config",
                "--no-playlist",
                "--dump-single-json",
                "--ffmpeg-location",
            ])
            .arg(&tools.ffmpeg_dir)
            .args(["--js-runtimes"])
            .arg(format!("deno:{}", tools.deno.display()))
            .arg(&url)
            .output()
            .map_err(|error| {
                format!(
                    "Failed to start yt-dlp at {}: {error}",
                    tools.yt_dlp.display()
                )
            })?;

        if !output.status.success() {
            append_log("metadata", "Failed to parse metadata.");
            return Err(process_failure_message(
                "Failed to parse video metadata.",
                output.status.code(),
                &output.stderr,
                &output.stdout,
            ));
        }

        parse_metadata_json(&String::from_utf8_lossy(&output.stdout), &url)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn download_video(
    app: AppHandle,
    process_state: tauri::State<'_, DownloadProcessState>,
    request: DownloadRequest,
) -> Result<Option<String>, String> {
    let process_state = process_state.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        validate_http_url(&request.url)?;
        let tools = locate_tools(&app)?;
        require_tools(&tools)?;
        ensure_writable_directories()?;
        let output_dir = download_directory()?;
        append_log("download", &format!("Starting {} {}", request.label, request.url));

        let mut command = background_command(&tools.yt_dlp);
        let mut child = command
            .args([
                "--ignore-config",
                "--no-playlist",
                "--newline",
                "--paths",
            ])
            .arg(format!("home:{}", output_dir.display()))
            .args(["--output", "%(title).200B [%(id)s].%(ext)s", "--format"])
            .arg(if request.format_selector.trim().is_empty() {
                "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b".to_string()
            } else {
                request.format_selector.clone()
            })
            .args(["--merge-output-format", "mp4", "--ffmpeg-location"])
            .arg(&tools.ffmpeg_dir)
            .args(["--js-runtimes"])
            .arg(format!("deno:{}", tools.deno.display()))
            .args([
                "--progress-template",
                &format!(
                    "{}%(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
                    PROGRESS_PREFIX
                ),
                "--print",
                &format!("after_move:{}%(filepath)s", OUTPUT_PATH_PREFIX),
                "--progress",
            ])
            .arg(&request.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start yt-dlp at {}: {error}", tools.yt_dlp.display()))?;
        let pid = child.id();
        set_active_process(&process_state, pid)?;

        emit_progress(
            &app,
            DownloadProgress {
                percent: None,
                status: format!("Starting {}", request.label),
                speed: None,
                eta: None,
                raw: None,
            },
        );

        let output_path = Arc::new(Mutex::new(None::<String>));
        let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));

        let stdout_handle = child.stdout.take().map(|stdout| {
            let app = app.clone();
            let output_path = Arc::clone(&output_path);
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(progress) = parse_progress_line(&line) {
                        emit_progress(&app, progress);
                    }

                    if let Some(path) = line.strip_prefix(OUTPUT_PATH_PREFIX) {
                        if let Ok(mut guard) = output_path.lock() {
                            *guard = Some(path.trim().to_string());
                        }
                    }
                }
            })
        });

        let stderr_handle = child.stderr.take().map(|stderr| {
            let stderr_lines = Arc::clone(&stderr_lines);
            thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if let Ok(mut guard) = stderr_lines.lock() {
                        guard.push(line);
                    }
                }
            })
        });

        let status = child.wait().map_err(to_string)?;
        if let Some(handle) = stdout_handle {
            let _ = handle.join();
        }
        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }

        if !status.success() {
            let details = stderr_lines.lock().map(|lines| lines.join("\n")).unwrap_or_default();
            let cancelled = was_cancel_requested(&process_state);
            clear_active_process(&process_state, pid);
            if cancelled {
                append_log("download", "Cancelled by user.");
                return Err("Download cancelled.".to_string());
            }
            append_log("download", &format!("Failed. {details}"));
            return Err(process_failure_message(
                "Download failed.",
                status.code(),
                details.as_bytes(),
                &[],
            ));
        }

        clear_active_process(&process_state, pid);

        emit_progress(
            &app,
            DownloadProgress {
                percent: Some(100.0),
                status: "Completed".to_string(),
                speed: None,
                eta: None,
                raw: None,
            },
        );

        let saved_path = output_path.lock().ok().and_then(|guard| guard.clone());
        append_log("download", &format!("Completed. Output={}", saved_path.as_deref().unwrap_or("unknown")));
        Ok(saved_path)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn cancel_download(
    process_state: tauri::State<'_, DownloadProcessState>,
) -> Result<(), String> {
    let pid = {
        let guard = process_state.active_pid.lock().map_err(lock_error)?;
        *guard
    };

    let Some(pid) = pid else {
        return Ok(());
    };

    {
        let mut guard = process_state.cancel_requested.lock().map_err(lock_error)?;
        *guard = true;
    }

    tauri::async_runtime::spawn_blocking(move || kill_process_tree(pid))
        .await
        .map_err(join_error)?
}

fn locate_tools(app: &AppHandle) -> Result<ToolPaths, String> {
    let target = current_tool_target()?;
    let names = tool_names_for_target(&target)
        .ok_or_else(|| format!("Unsupported tool target: {target}."))?;
    let mut roots = Vec::new();
    if let Ok(root) = writable_tools_root(&target) {
        roots.push(root);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join(TOOLS_DIRECTORY).join(&target));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join(TOOLS_DIRECTORY).join(&target));
        }
    }

    roots.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(TOOLS_DIRECTORY)
            .join(&target),
    );

    if let Ok(current_dir) = env::current_dir() {
        roots.push(
            current_dir
                .join("src-tauri")
                .join(TOOLS_DIRECTORY)
                .join(&target),
        );
        roots.push(current_dir.join(TOOLS_DIRECTORY).join(&target));
    }

    let root = roots
        .into_iter()
        .find(|root| root.join("yt-dlp").join(names.yt_dlp).exists())
        .unwrap_or_else(|| {
            writable_tools_root(&target).unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join(TOOLS_DIRECTORY)
                    .join(&target)
            })
        });

    Ok(ToolPaths {
        yt_dlp: root.join("yt-dlp").join(names.yt_dlp),
        yt_dlp_relative_path: tool_relative_path(&target, &["yt-dlp", names.yt_dlp]),
        ffmpeg: root.join("ffmpeg").join("bin").join(names.ffmpeg),
        ffmpeg_relative_path: tool_relative_path(&target, &["ffmpeg", "bin", names.ffmpeg]),
        ffmpeg_dir: root.join("ffmpeg").join("bin"),
        ffprobe: root.join("ffmpeg").join("bin").join(names.ffprobe),
        ffprobe_relative_path: tool_relative_path(&target, &["ffmpeg", "bin", names.ffprobe]),
        deno: root.join("deno").join(names.deno),
        deno_relative_path: tool_relative_path(&target, &["deno", names.deno]),
        root,
    })
}

fn tool_target_from(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        ("windows", "aarch64") => Some("win-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        _ => None,
    }
}

fn tool_names_for_target(target: &str) -> Option<ToolNames> {
    match target {
        "win-x64" | "win-arm64" => Some(ToolNames {
            yt_dlp: "yt-dlp.exe",
            ffmpeg: "ffmpeg.exe",
            ffprobe: "ffprobe.exe",
            deno: "deno.exe",
        }),
        "macos-x64" | "macos-arm64" => Some(ToolNames {
            yt_dlp: "yt-dlp",
            ffmpeg: "ffmpeg",
            ffprobe: "ffprobe",
            deno: "deno",
        }),
        _ => None,
    }
}

fn current_tool_target() -> Result<String, String> {
    env::var("YT_DLP_TOOL_TARGET")
        .or_else(|_| env::var("YT_DLP_WINDOWS_TOOL_TARGET"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(Ok)
        .unwrap_or_else(|| {
            tool_target_from(env::consts::OS, env::consts::ARCH)
                .map(|target| target.to_string())
                .ok_or_else(|| {
                    format!(
                        "Unsupported tool target for {}-{}. Supported targets: win-x64, win-arm64, macos-x64, macos-arm64.",
                        env::consts::OS,
                        env::consts::ARCH
                    )
                })
        })
}

fn tool_relative_path(target: &str, segments: &[&str]) -> String {
    let mut path_segments = vec![TOOLS_DIRECTORY, target];
    path_segments.extend_from_slice(segments);
    path_segments.join("/")
}

fn writable_tools_root(target: &str) -> Result<PathBuf, String> {
    Ok(app_data_root()?.join(TOOLS_DIRECTORY).join(target))
}

fn read_manifest_target(app: &AppHandle, target: &str) -> Result<ManifestTarget, String> {
    let manifest_path = manifest_path(app)?;
    let json = fs::read_to_string(&manifest_path).map_err(to_string)?;
    manifest_target_from_json(&json, target)
}

fn manifest_target_from_json(json: &str, target: &str) -> Result<ManifestTarget, String> {
    let manifest: ToolsManifest = serde_json::from_str(json).map_err(to_string)?;
    if manifest.schema_version < 2 {
        return Err("tools-manifest.json schemaVersion must be 2 or newer.".to_string());
    }

    manifest
        .targets
        .into_iter()
        .find(|item| item.target == target)
        .ok_or_else(|| format!("No tool manifest target found for {target}."))
}

fn manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(TOOLS_MANIFEST_FILE));
    }

    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(TOOLS_MANIFEST_FILE));
        }
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(TOOLS_MANIFEST_FILE));

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("src-tauri").join(TOOLS_MANIFEST_FILE));
        candidates.push(current_dir.join(TOOLS_MANIFEST_FILE));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "Unable to locate tools-manifest.json.".to_string())
}

fn install_manifest_target(
    app: &AppHandle,
    target: &ManifestTarget,
    root: &Path,
) -> Result<(), String> {
    let total_steps = target.tools.len().max(1) as f64;
    let mut zip_groups = BTreeMap::<String, Vec<ManifestTool>>::new();

    for tool in &target.tools {
        match tool.kind {
            ManifestToolKind::File => {
                let step = installed_tool_count(root, &target.tools) as f64;
                install_file_tool(
                    app,
                    root,
                    tool,
                    step / total_steps * 100.0,
                    100.0 / total_steps,
                )
                .map_err(|error| format!("Failed to install {}. {error}", tool.name))?;
            }
            ManifestToolKind::Zip => {
                zip_groups
                    .entry(tool.source_url.clone())
                    .or_default()
                    .push(tool.clone());
            }
        }
    }

    for tools in zip_groups.values() {
        let step = installed_tool_count(root, &target.tools) as f64;
        let group_label = zip_group_label(tools);
        install_zip_tools(
            app,
            root,
            tools,
            step / total_steps * 100.0,
            tools.len() as f64 / total_steps * 100.0,
        )
        .map_err(|error| format!("Failed to install {group_label}. {error}"))?;
    }

    for tool in &target.tools {
        let path = root.join(relative_manifest_tool_path(tool)?);
        if !path.exists() {
            return Err(format!(
                "Installed tool is missing after install: {}",
                path.display()
            ));
        }
        verify_sha256(&path, &tool.sha256)?;
    }

    Ok(())
}

fn installed_tool_count(root: &Path, tools: &[ManifestTool]) -> usize {
    tools
        .iter()
        .filter(|tool| {
            relative_manifest_tool_path(tool)
                .map(|path| root.join(path).exists())
                .unwrap_or(false)
        })
        .count()
}

fn install_file_tool(
    app: &AppHandle,
    root: &Path,
    tool: &ManifestTool,
    base_percent: f64,
    span_percent: f64,
) -> Result<(), String> {
    let destination = root.join(relative_manifest_tool_path(tool)?);
    download_to_destination(app, tool, &destination, base_percent, span_percent * 0.82)?;
    emit_tool_install_progress(
        app,
        ToolInstallProgress {
            percent: Some((base_percent + span_percent * 0.9).min(99.0)),
            status: format!("Verifying {}", tool.name),
            tool: Some(tool.name.clone()),
        },
    );
    verify_sha256(&destination, &tool.sha256)?;
    mark_executable(&destination)?;
    Ok(())
}

fn install_zip_tools(
    app: &AppHandle,
    root: &Path,
    tools: &[ManifestTool],
    base_percent: f64,
    span_percent: f64,
) -> Result<(), String> {
    let first = tools
        .first()
        .ok_or_else(|| "Zip tool group cannot be empty.".to_string())?;
    let temp_root = app_data_root()?.join("tool-downloads");
    fs::create_dir_all(&temp_root).map_err(to_string)?;
    let zip_path = temp_root.join(format!(
        "{}-{}.zip",
        sanitize_file_name(&first.name),
        unix_timestamp()
    ));

    download_source_to_file(
        app,
        &first.source_url,
        &zip_path,
        &format!("Downloading {}", zip_group_label(tools)),
        first.name.as_str(),
        base_percent,
        span_percent * 0.55,
    )?;

    let extract_root = temp_root.join(format!(
        "extract-{}-{}",
        sanitize_file_name(&first.name),
        unix_timestamp()
    ));
    fs::create_dir_all(&extract_root).map_err(to_string)?;
    extract_zip_archive(&zip_path, &extract_root)?;

    for (index, tool) in tools.iter().enumerate() {
        let offset = index as f64 / tools.len() as f64;
        emit_tool_install_progress(
            app,
            ToolInstallProgress {
                percent: Some((base_percent + span_percent * (0.58 + offset * 0.34)).min(99.0)),
                status: format!("Extracting {}", tool.name),
                tool: Some(tool.name.clone()),
            },
        );
        extract_tool_from_directory(&extract_root, root, tool)?;
        let destination = root.join(relative_manifest_tool_path(tool)?);
        verify_sha256(&destination, &tool.sha256)?;
        mark_executable(&destination)?;
    }

    let _ = fs::remove_file(zip_path);
    let _ = fs::remove_dir_all(extract_root);
    Ok(())
}

fn download_to_destination(
    app: &AppHandle,
    tool: &ManifestTool,
    destination: &Path,
    base_percent: f64,
    span_percent: f64,
) -> Result<(), String> {
    let temp = destination.with_extension("download");
    download_source_to_file(
        app,
        &tool.source_url,
        &temp,
        &format!("Downloading {}", tool.name),
        tool.name.as_str(),
        base_percent,
        span_percent,
    )?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare directory for {} at {}: {error}",
                tool.name,
                parent.display()
            )
        })?;
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| {
            format!(
                "Failed to replace existing {} at {}: {error}",
                tool.name,
                destination.display()
            )
        })?;
    }
    fs::rename(&temp, destination).map_err(|error| {
        format!(
            "Failed to move downloaded {} from {} to {}: {error}",
            tool.name,
            temp.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn download_source_to_file(
    app: &AppHandle,
    source_url: &str,
    destination: &Path,
    status: &str,
    tool_name: &str,
    base_percent: f64,
    span_percent: f64,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare download directory {}: {error}",
                parent.display()
            )
        })?;
    }
    emit_tool_install_progress(
        app,
        ToolInstallProgress {
            percent: Some(base_percent.min(99.0)),
            status: status.to_string(),
            tool: Some(tool_name.to_string()),
        },
    );

    let output = background_command("curl")
        .args([
            "-L",
            "--fail",
            "--show-error",
            "--silent",
            "--retry",
            "2",
            "--output",
        ])
        .arg(destination)
        .arg(source_url)
        .output()
        .map_err(|error| format!("Failed to start curl for {tool_name}: {error}"))?;

    if !output.status.success() {
        return Err(process_failure_message(
            &format!(
                "Failed to download {tool_name} from {source_url} to {}.",
                destination.display()
            ),
            output.status.code(),
            &output.stderr,
            &output.stdout,
        ));
    }

    emit_tool_install_progress(
        app,
        ToolInstallProgress {
            percent: Some((base_percent + span_percent).min(99.0)),
            status: format!("Downloaded {tool_name}"),
            tool: Some(tool_name.to_string()),
        },
    );
    Ok(())
}

fn extract_zip_archive(zip_path: &Path, destination: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = background_command("powershell");
        command
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"])
            .arg(format!(
                "Expand-Archive -Force -LiteralPath '{}' -DestinationPath '{}'",
                powershell_escape(zip_path),
                powershell_escape(destination)
            ));
        command
    } else {
        let mut command = background_command("unzip");
        command
            .args(["-q", "-o"])
            .arg(zip_path)
            .arg("-d")
            .arg(destination);
        command
    };
    let output = command.output().map_err(|error| {
        format!(
            "Failed to start archive extractor for {}: {error}",
            zip_path.display()
        )
    })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(process_failure_message(
            &format!(
                "Failed to extract {} to {}.",
                zip_path.display(),
                destination.display()
            ),
            output.status.code(),
            &output.stderr,
            &output.stdout,
        ))
    }
}

fn extract_tool_from_directory(
    extract_root: &Path,
    tools_root: &Path,
    tool: &ManifestTool,
) -> Result<(), String> {
    let suffix = tool
        .archive_path_suffix
        .as_deref()
        .ok_or_else(|| format!("{} is missing archivePathSuffix.", tool.name))?
        .replace('\\', "/");
    let source = find_file_by_normalized_suffix(extract_root, &suffix)?.ok_or_else(|| {
        format!(
            "Unable to find {} at {} in extracted archive {}.",
            tool.name,
            suffix,
            extract_root.display()
        )
    })?;
    let destination = tools_root.join(relative_manifest_tool_path(tool)?);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare directory for {} at {}: {error}",
                tool.name,
                parent.display()
            )
        })?;
    }
    fs::copy(&source, &destination).map_err(|error| {
        format!(
            "Failed to copy {} from {} to {}: {error}",
            tool.name,
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn find_file_by_normalized_suffix(root: &Path, suffix: &str) -> Result<Option<PathBuf>, String> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(path) = stack.pop() {
        for entry in fs::read_dir(path).map_err(to_string)? {
            let entry = entry.map_err(to_string)?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let normalized = path.to_string_lossy().replace('\\', "/");
                if normalized.ends_with(suffix) {
                    return Ok(Some(path));
                }
            }
        }
    }
    Ok(None)
}

fn relative_manifest_tool_path(tool: &ManifestTool) -> Result<PathBuf, String> {
    let normalized = tool.path.replace('\\', "/");
    let prefix = format!("{TOOLS_DIRECTORY}/");
    let relative = normalized
        .strip_prefix(&prefix)
        .and_then(|value| value.split_once('/').map(|(_, rest)| rest))
        .ok_or_else(|| format!("Invalid tool path in manifest: {}", tool.path))?;
    Ok(PathBuf::from(relative))
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "SHA-256 mismatch for {}. Expected {}, got {}.",
            path.display(),
            expected,
            actual
        ))
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(to_string)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 64];
    loop {
        let count = file.read(&mut buffer).map_err(to_string)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn zip_group_label(tools: &[ManifestTool]) -> String {
    tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>()
        .join(" / ")
}

fn powershell_escape(path: &Path) -> String {
    path.display().to_string().replace('\'', "''")
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path).map_err(to_string)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(to_string)
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn require_tools(tools: &ToolPaths) -> Result<(), String> {
    for path in [&tools.yt_dlp, &tools.ffmpeg, &tools.ffprobe, &tools.deno] {
        if !path.exists() {
            return Err(format!("Missing bundled tool: {}", path.display()));
        }
    }
    Ok(())
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
            error: Some("Bundled tool file is missing.".to_string()),
        };
    }

    let mut command = background_command(full_path);
    match command.args(version_args).output() {
        Ok(output) if output.status.success() => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "available".to_string(),
            version: first_line(&output.stdout),
            error: None,
        },
        Ok(output) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            error: Some(process_failure_message(
                &format!(
                    "{name} at {} failed to report a version.",
                    full_path.display()
                ),
                output.status.code(),
                &output.stderr,
                &output.stdout,
            )),
        },
        Err(error) => ToolStatus {
            name: name.to_string(),
            relative_path: relative_path.to_string(),
            full_path: full_path.display().to_string(),
            availability: "cannot_execute".to_string(),
            version: None,
            error: Some(format!(
                "Failed to run {name} at {}: {error}",
                full_path.display()
            )),
        },
    }
}

fn parse_metadata_json(json: &str, fallback_url: &str) -> Result<VideoMetadata, String> {
    if json.trim().is_empty() {
        return Err("yt-dlp returned empty metadata.".to_string());
    }

    let root: Value = serde_json::from_str(json).map_err(to_string)?;
    let title = root
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Untitled video")
        .to_string();
    let id = root.get("id").and_then(Value::as_str).map(str::to_string);
    let webpage_url = root
        .get("webpage_url")
        .or_else(|| root.get("original_url"))
        .and_then(Value::as_str)
        .unwrap_or(fallback_url)
        .to_string();
    let thumbnail_urls = read_thumbnail_urls(&root);
    let thumbnail_url = thumbnail_urls.first().cloned();
    let duration_seconds = root.get("duration").and_then(Value::as_f64);
    let description = root
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let format_options = build_format_options(&root);

    Ok(VideoMetadata {
        title,
        id,
        webpage_url,
        thumbnail_url,
        thumbnail_urls,
        duration_seconds,
        description,
        format_options,
    })
}

fn build_format_options(root: &Value) -> Vec<VideoFormatOption> {
    let mut options = vec![VideoFormatOption {
        label: "Best MP4".to_string(),
        format_selector: "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b".to_string(),
        height: None,
        extension: "mp4".to_string(),
        is_best: true,
    }];

    for height in read_available_heights(root).into_iter().rev() {
        options.push(VideoFormatOption {
            label: format!("{height}p MP4"),
            format_selector: format!(
                "bv*[height<={height}][ext=mp4]+ba[ext=m4a]/b[height<={height}][ext=mp4]/bv*[height<={height}]+ba/b[height<={height}]"
            ),
            height: Some(height),
            extension: "mp4".to_string(),
            is_best: false,
        });
    }

    options
}

fn read_available_heights(root: &Value) -> Vec<u32> {
    let mut heights = BTreeSet::new();
    if let Some(formats) = root.get("formats").and_then(Value::as_array) {
        for format in formats {
            let height = format.get("height").and_then(Value::as_u64);
            let video_codec = format.get("vcodec").and_then(Value::as_str);
            if let Some(height) = height {
                if height > 0 && video_codec.map(|codec| codec != "none").unwrap_or(true) {
                    heights.insert(height as u32);
                }
            }
        }
    }
    heights.into_iter().collect()
}

fn read_thumbnail_urls(root: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = BTreeSet::new();

    if let Some(url) = root.get("thumbnail").and_then(Value::as_str) {
        push_thumbnail_url(&mut urls, &mut seen, url);
    }

    if let Some(items) = root.get("thumbnails").and_then(Value::as_array) {
        for url in items
            .iter()
            .rev()
            .filter_map(|item| item.get("url").and_then(Value::as_str))
        {
            push_thumbnail_url(&mut urls, &mut seen, url);
        }
    }

    urls
}

fn push_thumbnail_url(urls: &mut Vec<String>, seen: &mut BTreeSet<String>, raw_url: &str) {
    let trimmed = raw_url.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("null")
        || trimmed.eq_ignore_ascii_case("none")
    {
        return;
    }

    let normalized = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    };

    if let Some(rest) = normalized.strip_prefix("http://") {
        push_unique_thumbnail_url(urls, seen, format!("https://{rest}"));
    }
    push_unique_thumbnail_url(urls, seen, normalized);
}

fn push_unique_thumbnail_url(urls: &mut Vec<String>, seen: &mut BTreeSet<String>, url: String) {
    if seen.insert(url.clone()) {
        urls.push(url);
    }
}

fn parse_progress_line(line: &str) -> Option<DownloadProgress> {
    let payload = line.strip_prefix(PROGRESS_PREFIX)?;
    let parts = payload.split('|').collect::<Vec<_>>();
    Some(DownloadProgress {
        status: normalize_status(parts.first().copied().unwrap_or_default()),
        percent: parse_percent(parts.get(1).copied().unwrap_or_default()),
        speed: normalize_optional(parts.get(2).copied()),
        eta: normalize_optional(parts.get(3).copied()),
        raw: Some(line.to_string()),
    })
}

fn parse_percent(value: &str) -> Option<f64> {
    let number = value
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    number
        .parse::<f64>()
        .ok()
        .map(|percent| percent.clamp(0.0, 100.0))
}

fn normalize_status(value: &str) -> String {
    match value.trim() {
        "downloading" => "Downloading".to_string(),
        "finished" => "Merging".to_string(),
        "error" => "Failed".to_string(),
        "" => "Processing".to_string(),
        other => other.to_string(),
    }
}

fn normalize_optional(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value == "N/A" {
        None
    } else {
        Some(value.to_string())
    }
}

fn emit_progress(app: &AppHandle, progress: DownloadProgress) {
    let _ = app.emit("download-progress", progress);
}

fn emit_tool_install_progress(app: &AppHandle, progress: ToolInstallProgress) {
    let _ = app.emit("tool-install-progress", progress);
}

fn set_active_process(state: &DownloadProcessState, pid: u32) -> Result<(), String> {
    {
        let mut guard = state.active_pid.lock().map_err(lock_error)?;
        *guard = Some(pid);
    }
    {
        let mut guard = state.cancel_requested.lock().map_err(lock_error)?;
        *guard = false;
    }
    Ok(())
}

fn clear_active_process(state: &DownloadProcessState, pid: u32) {
    if let Ok(mut guard) = state.active_pid.lock() {
        if guard.is_some_and(|active_pid| active_pid == pid) {
            *guard = None;
        }
    }
    if let Ok(mut guard) = state.cancel_requested.lock() {
        *guard = false;
    }
}

fn was_cancel_requested(state: &DownloadProcessState) -> bool {
    state
        .cancel_requested
        .lock()
        .map(|guard| *guard)
        .unwrap_or(false)
}

fn kill_process_tree(pid: u32) -> Result<(), String> {
    let pid_text = pid.to_string();
    let mut command = if cfg!(target_os = "windows") {
        let mut command = background_command("taskkill");
        command.args(["/PID", &pid_text, "/T", "/F"]);
        command
    } else {
        let mut command = background_command("kill");
        command.args(["-TERM", &pid_text]);
        command
    };
    let output = command
        .output()
        .map_err(|error| format!("Failed to start cancel command for process {pid}: {error}"))?;

    if output.status.success() {
        append_log("download", &format!("Cancel requested for process {pid}."));
        Ok(())
    } else {
        Err(process_failure_message(
            &format!("Failed to cancel process {pid}."),
            output.status.code(),
            &output.stderr,
            &output.stdout,
        ))
    }
}

fn download_directory() -> Result<PathBuf, String> {
    let configured = state_directory()?.join("download-directory.txt");
    if configured.exists() {
        let value = fs::read_to_string(configured).map_err(to_string)?;
        let value = value.trim();
        if !value.is_empty() {
            return Ok(PathBuf::from(value));
        }
    }

    Ok(default_download_directory())
}

fn default_download_directory() -> PathBuf {
    home_directory()
        .map(|home| home.join("Downloads").join("yt-dlp-tauri"))
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("downloads")
        })
}

fn app_data_root() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
            return Ok(PathBuf::from(local_app_data).join("yt-dlp-tauri"));
        }
    }

    if let Ok(xdg_data_home) = env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(xdg_data_home).join("yt-dlp-tauri"));
    }

    home_directory()
        .map(|home| home.join(".local").join("share").join("yt-dlp-tauri"))
        .ok_or_else(|| "Unable to determine app data directory.".to_string())
}

fn state_directory() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("state"))
}

fn log_directory() -> Result<PathBuf, String> {
    Ok(app_data_root()?.join("logs"))
}

fn ensure_writable_directories() -> Result<(), String> {
    fs::create_dir_all(app_data_root()?).map_err(to_string)?;
    fs::create_dir_all(state_directory()?).map_err(to_string)?;
    fs::create_dir_all(log_directory()?).map_err(to_string)?;
    fs::create_dir_all(download_directory()?).map_err(to_string)?;
    Ok(())
}

fn append_log(phase: &str, message: &str) {
    let Ok(directory) = log_directory() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("app.log"))
    else {
        return;
    };
    let sanitized = message.replace('\r', " ").replace('\n', " ");
    let _ = writeln!(file, "{} [{phase}] {sanitized}", unix_timestamp());
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn home_directory() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
}

fn background_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn validate_http_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Ok(())
    } else {
        Err("Enter a valid http or https video URL.".to_string())
    }
}

fn first_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
}

fn process_failure_message(
    action: &str,
    code: Option<i32>,
    stderr: &[u8],
    stdout: &[u8],
) -> String {
    let status = match code {
        Some(code) => format!("Exit code {code}."),
        None => "Process terminated without an exit code.".to_string(),
    };
    let details = first_line(stderr).or_else(|| first_line(stdout));

    match details {
        Some(details) => format!("{action} {status} {details}"),
        None => format!("{action} {status}"),
    }
}

fn open_path(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer");
        command.arg(path);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command.spawn().map_err(to_string)?;
    Ok(())
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn lock_error(error: impl std::fmt::Display) -> String {
    format!("State lock failed: {error}")
}

fn join_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_platform_arch_pairs_to_tool_targets() {
        assert_eq!(tool_target_from("windows", "x86_64"), Some("win-x64"));
        assert_eq!(tool_target_from("windows", "aarch64"), Some("win-arm64"));
        assert_eq!(tool_target_from("macos", "x86_64"), Some("macos-x64"));
        assert_eq!(tool_target_from("macos", "aarch64"), Some("macos-arm64"));
        assert_eq!(tool_target_from("linux", "x86_64"), None);
    }

    #[test]
    fn uses_platform_specific_tool_names() {
        let windows_tools = tool_names_for_target("win-x64").expect("windows tool names");
        assert_eq!(windows_tools.yt_dlp, "yt-dlp.exe");
        assert_eq!(windows_tools.ffmpeg, "ffmpeg.exe");
        assert_eq!(windows_tools.ffprobe, "ffprobe.exe");
        assert_eq!(windows_tools.deno, "deno.exe");

        let macos_tools = tool_names_for_target("macos-arm64").expect("macos tool names");
        assert_eq!(macos_tools.yt_dlp, "yt-dlp");
        assert_eq!(macos_tools.ffmpeg, "ffmpeg");
        assert_eq!(macos_tools.ffprobe, "ffprobe");
        assert_eq!(macos_tools.deno, "deno");

        assert!(tool_names_for_target("linux-x64").is_none());
    }

    #[test]
    fn selects_tools_for_current_manifest_target() {
        let manifest = r#"
        {
          "schemaVersion": 2,
          "targets": [
            {
              "target": "win-x64",
              "tools": [
                {
                  "name": "yt-dlp",
                  "path": "Tools/win-x64/yt-dlp/yt-dlp.exe",
                  "sourceUrl": "https://example.test/yt-dlp.exe",
                  "sha256": "abc",
                  "kind": "file"
                }
              ]
            },
            {
              "target": "win-arm64",
              "tools": []
            }
          ]
        }
        "#;

        let target = manifest_target_from_json(manifest, "win-x64").expect("target should parse");
        assert_eq!(target.target, "win-x64");
        assert_eq!(target.tools.len(), 1);
        assert_eq!(target.tools[0].name, "yt-dlp");
    }

    #[test]
    fn production_manifest_uses_fixed_release_urls() {
        let manifest = include_str!("../tools-manifest.json");
        let manifest: ToolsManifest =
            serde_json::from_str(manifest).expect("manifest should parse");

        for target in manifest.targets {
            for tool in target.tools {
                let source_url = tool.source_url.to_ascii_lowercase();
                assert!(
                    !source_url.contains("/latest/") && !source_url.contains("/latest/download/"),
                    "{} for {} uses a floating latest URL: {}",
                    tool.name,
                    target.target,
                    tool.source_url
                );
                assert!(
                    !source_url.contains("master-latest"),
                    "{} for {} uses a floating latest asset name: {}",
                    tool.name,
                    target.target,
                    tool.source_url
                );
            }
        }
    }

    #[test]
    fn production_manifest_contains_expected_tool_targets() {
        let manifest = include_str!("../tools-manifest.json");
        let manifest: ToolsManifest =
            serde_json::from_str(manifest).expect("manifest should parse");
        let targets: BTreeMap<_, _> = manifest
            .targets
            .iter()
            .map(|target| (target.target.as_str(), target))
            .collect();
        let expected_tools = BTreeSet::from(["deno", "ffmpeg", "ffprobe", "yt-dlp"]);

        for target_name in ["win-x64", "macos-x64", "macos-arm64"] {
            let target = targets
                .get(target_name)
                .unwrap_or_else(|| panic!("missing manifest target {target_name}"));
            let tools = target
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<BTreeSet<_>>();
            assert_eq!(tools, expected_tools, "unexpected tools for {target_name}");

            for tool in &target.tools {
                assert!(
                    tool.path.starts_with(&format!("{TOOLS_DIRECTORY}/{target_name}/")),
                    "{} for {} has path outside its target: {}",
                    tool.name,
                    target_name,
                    tool.path
                );
            }
        }
    }

    #[test]
    fn process_failure_message_prefers_stderr() {
        let message = process_failure_message(
            "Failed to download yt-dlp.",
            Some(22),
            b"curl: (22) The requested URL returned error: 404\n",
            b"ignored stdout\n",
        );

        assert_eq!(
            message,
            "Failed to download yt-dlp. Exit code 22. curl: (22) The requested URL returned error: 404"
        );
    }

    #[test]
    fn process_failure_message_falls_back_to_stdout() {
        let message = process_failure_message(
            "Failed to extract archive.",
            None,
            b"",
            b"Archive is invalid\n",
        );

        assert_eq!(
            message,
            "Failed to extract archive. Process terminated without an exit code. Archive is invalid"
        );
    }

    #[test]
    fn parse_metadata_upgrades_http_thumbnail_candidates() {
        let metadata = parse_metadata_json(
            r#"
            {
              "title": "Bilibili test",
              "webpage_url": "https://www.bilibili.com/video/BV1test",
              "thumbnail": "http://i0.hdslb.com/bfs/archive/cover.jpg",
              "formats": []
            }
            "#,
            "https://www.bilibili.com/video/BV1test",
        )
        .expect("metadata should parse");

        assert_eq!(
            metadata.thumbnail_url.as_deref(),
            Some("https://i0.hdslb.com/bfs/archive/cover.jpg")
        );
        assert_eq!(
            metadata.thumbnail_urls,
            vec![
                "https://i0.hdslb.com/bfs/archive/cover.jpg".to_string(),
                "http://i0.hdslb.com/bfs/archive/cover.jpg".to_string()
            ]
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadProcessState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            set_download_directory,
            reset_download_directory,
            open_download_directory,
            check_tools,
            install_tools,
            parse_metadata,
            download_video,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
