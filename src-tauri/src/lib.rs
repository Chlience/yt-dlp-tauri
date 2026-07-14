use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    env,
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

pub mod toolchain;

use toolchain::{
    activate_revision, active_tool_paths, build_tool_download_client, manifest_target,
    parse_channel_record, parse_local_toolchain_config, parse_manifest, probe_local_toolchain,
    probe_target, promote_staged_toolchain, read_active_state, require_tools,
    resolve_local_toolchain, revision_root, select_revision_manifest_asset, stage_target_revision,
    tool_names_for_target, tool_paths_for_root, tool_target_from, verify_channel_manifest,
    ActiveToolchainState, GitHubRelease, LocalToolchainConfig, ManifestTarget, ProgressReporter,
    StageTargetRevisionRequest, ToolInstallProgress, ToolPaths, ToolStatus, ToolchainSource,
    ToolsManifest, REVISION_MANIFEST_FILE, TOOLS_DIRECTORY,
};

const TOOLS_MANIFEST_FILE: &str = "tools-manifest.json";
const LEGACY_LATEST_RELEASE_API_URL: &str =
    "https://api.github.com/repos/Chlience/yt-dlp-tauri/releases/latest";
const TOOLCHAIN_STABLE_API_URL: &str =
    "https://api.github.com/repos/Chlience/yt-dlp-tauri-toolchain/releases/tags/toolchain-stable";
const TOOLCHAIN_RELEASE_API_PREFIX: &str =
    "https://api.github.com/repos/Chlience/yt-dlp-tauri-toolchain/releases/tags";
const GITHUB_API_VERSION: &str = "2026-03-10";
const GITHUB_PROXY_URL_PREFIX: &str = "https://gh-proxy.com/";
const PROGRESS_PREFIX: &str = "yt-dlp-tauri-progress:";
const OUTPUT_PATH_PREFIX: &str = "yt-dlp-tauri-output:";
const COOKIE_HEADER_EXPIRY: &str = "2147483647";
const TOOLCHAIN_SOURCE_FILE: &str = "toolchain-source.txt";
const LOCAL_TOOLCHAIN_CONFIG_FILE: &str = "local-toolchain.json";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
struct AppState {
    download_directory: String,
    tools_root: String,
    toolchain_revision: Option<String>,
    toolchain_source: ToolchainSource,
    local_toolchain: LocalToolchainConfig,
    local_toolchain_paths: LocalToolchainPaths,
    cookies_file: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalToolchainPaths {
    yt_dlp_path: Option<PathBuf>,
    ffmpeg_directory: Option<PathBuf>,
    deno_path: Option<PathBuf>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalToolchainInput {
    yt_dlp_path: Option<String>,
    ffmpeg_directory: Option<String>,
    deno_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    percent: Option<f64>,
    status: String,
    speed: Option<String>,
    eta: Option<String>,
    raw: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatestToolManifestResult {
    status: String,
    manifest_json: Option<String>,
    revision: Option<String>,
    source: Option<String>,
}

#[derive(Clone, Default)]
struct DownloadProcessState {
    active_pid: Arc<Mutex<Option<u32>>>,
    cancel_requested: Arc<Mutex<bool>>,
}

struct PreparedCookiesFile {
    path: PathBuf,
    temporary: bool,
}

impl PreparedCookiesFile {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PreparedCookiesFile {
    fn drop(&mut self) {
        if self.temporary {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[tauri::command]
async fn get_app_state(app: AppHandle) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_writable_directories()?;
        let source = read_toolchain_source()?;
        build_app_state(tools_root_for_source(&app, source)?)
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

        build_app_state(String::new())
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
        build_app_state(String::new())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn set_cookies_file(path: String) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Cookie file cannot be empty.".to_string());
        }

        let path = PathBuf::from(trimmed);
        validate_cookies_file_path(&path)?;
        let state_dir = state_directory()?;
        fs::create_dir_all(&state_dir).map_err(to_string)?;
        fs::write(
            state_dir.join("cookies-file.txt"),
            path.display().to_string(),
        )
        .map_err(to_string)?;

        build_app_state(String::new())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn clear_cookies_file() -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state_file = cookies_file_state_path()?;
        if state_file.exists() {
            fs::remove_file(state_file).map_err(to_string)?;
        }

        build_app_state(String::new())
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
async fn set_toolchain_source(app: AppHandle, source: String) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = ToolchainSource::parse(&source)?;
        ensure_writable_directories()?;
        let tools_root = tools_root_for_source(&app, source)?;
        write_toolchain_source(source)?;
        build_app_state(tools_root)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn set_local_toolchain(
    app: AppHandle,
    config: LocalToolchainInput,
) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = LocalToolchainConfig::from_paths(
            optional_input_path(config.yt_dlp_path),
            optional_input_path(config.ffmpeg_directory),
            optional_input_path(config.deno_path),
        )?;
        ensure_writable_directories()?;
        write_local_toolchain_config(&config)?;
        let source = read_toolchain_source()?;
        build_app_state(tools_root_for_source(&app, source)?)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn auto_detect_local_toolchain(app: AppHandle) -> Result<AppState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_writable_directories()?;
        write_local_toolchain_config(&LocalToolchainConfig::default())?;
        let source = read_toolchain_source()?;
        build_app_state(tools_root_for_source(&app, source)?)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn check_tools(app: AppHandle) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target_name = current_tool_target()?;
        match read_toolchain_source()? {
            ToolchainSource::Managed => {
                let target = read_manifest_target(&app, &target_name)?;
                probe_manifest_tools(&app, &target)
            }
            ToolchainSource::Local => {
                let config = read_local_toolchain_config()?;
                let resolution = resolve_local_toolchain(&config, &target_name)?;
                Ok(probe_local_toolchain(&resolution))
            }
        }
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn check_tools_with_manifest(
    app: AppHandle,
    manifest_json: String,
) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_managed_toolchain_source()?;
        let target_name = current_tool_target()?;
        let target = manifest_target_from_json(&manifest_json, &target_name)?;
        probe_manifest_tools(&app, &target)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn fetch_latest_tool_manifest(
    github_access_mode: String,
) -> Result<LatestToolManifestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_latest_tool_manifest_blocking(&github_access_mode)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn install_tools(
    app: AppHandle,
    github_access_mode: String,
) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_managed_toolchain_source()?;
        let target_name = current_tool_target()?;
        let manifest_json = read_current_manifest_json(&app)?;
        install_and_activate_manifest(
            &app,
            &manifest_json,
            &target_name,
            &github_access_mode,
            false,
        )
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn install_tools_from_manifest(
    app: AppHandle,
    manifest_json: String,
    github_access_mode: String,
) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_managed_toolchain_source()?;
        let target_name = current_tool_target()?;
        install_and_activate_manifest(
            &app,
            &manifest_json,
            &target_name,
            &github_access_mode,
            false,
        )
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
async fn reinstall_tools(
    app: AppHandle,
    manifest_json: Option<String>,
    github_access_mode: String,
) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        require_managed_toolchain_source()?;
        let target_name = current_tool_target()?;
        let manifest_json = match manifest_json {
            Some(json) => json,
            None => read_current_manifest_json(&app)?,
        };
        install_and_activate_manifest(
            &app,
            &manifest_json,
            &target_name,
            &github_access_mode,
            true,
        )
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
        let cookies_file = prepared_cookies_file_for_url(&url)?;
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
            .args(yt_dlp_cookie_args(
                cookies_file.as_ref().map(PreparedCookiesFile::path),
            ))
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
        let cookies_file = prepared_cookies_file_for_url(&request.url)?;
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
            .args(yt_dlp_cookie_args(
                cookies_file.as_ref().map(PreparedCookiesFile::path),
            ))
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
    match read_toolchain_source()? {
        ToolchainSource::Managed => locate_managed_tools(app),
        ToolchainSource::Local => {
            let target = current_tool_target()?;
            let config = read_local_toolchain_config()?;
            resolve_local_toolchain(&config, &target)?.complete_paths()
        }
    }
}

fn tools_root_for_source(app: &AppHandle, source: ToolchainSource) -> Result<String, String> {
    match source {
        ToolchainSource::Managed => {
            locate_managed_tools(app).map(|tools| tools.root.display().to_string())
        }
        ToolchainSource::Local => Ok(String::new()),
    }
}

fn require_managed_toolchain_source() -> Result<(), String> {
    match read_toolchain_source()? {
        ToolchainSource::Managed => Ok(()),
        ToolchainSource::Local => Err(
            "Managed toolchain commands are unavailable while local tools are active".to_string(),
        ),
    }
}

fn locate_managed_tools(app: &AppHandle) -> Result<ToolPaths, String> {
    let target = current_tool_target()?;
    if let Some(paths) = active_tool_paths(&app_data_root()?, &target)? {
        return Ok(paths);
    }
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

    tool_paths_for_root(&root, &target)
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
                        "Unsupported tool target for {}-{}. Supported target: win-x64.",
                        env::consts::OS,
                        env::consts::ARCH
                    )
                })
        })
}

fn writable_tools_root(target: &str) -> Result<PathBuf, String> {
    Ok(app_data_root()?.join(TOOLS_DIRECTORY).join(target))
}

fn read_manifest_target(app: &AppHandle, target: &str) -> Result<ManifestTarget, String> {
    let manifest = read_current_manifest(app)?;
    manifest_target_from_manifest(manifest, target)
}

fn manifest_target_from_json(json: &str, target: &str) -> Result<ManifestTarget, String> {
    let manifest = manifest_from_json(json)?;
    manifest_target_from_manifest(manifest, target)
}

fn manifest_from_json(json: &str) -> Result<ToolsManifest, String> {
    parse_manifest(json)
}

fn fetch_latest_tool_manifest_blocking(
    github_access_mode: &str,
) -> Result<LatestToolManifestResult, String> {
    validate_github_access_mode(github_access_mode)?;
    let client = build_tool_download_client("tool manifest")?;
    let stable_url = resolve_github_url_for_mode(TOOLCHAIN_STABLE_API_URL, github_access_mode);
    let release_response = client
        .get(&stable_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .map_err(|error| format!("Failed to fetch stable toolchain from {stable_url}: {error}"))?;
    let release_status = release_response.status();

    if should_use_legacy_tool_manifest(release_status) {
        return fetch_legacy_tool_manifest(&client, github_access_mode);
    }

    if !release_status.is_success() {
        let body = release_response.text().unwrap_or_default();
        return Err(github_http_error_message(release_status, &body));
    }

    let release_body = release_response
        .text()
        .map_err(|error| format!("Failed to read stable toolchain response: {error}"))?;
    let stable_release: GitHubRelease = serde_json::from_str(&release_body)
        .map_err(|error| format!("Failed to parse stable toolchain response: {error}"))?;
    let channel = parse_channel_record(stable_release.body.as_deref().unwrap_or(""))?;

    let revision_api_url = format!("{TOOLCHAIN_RELEASE_API_PREFIX}/{}", channel.release_tag);
    let revision_url = resolve_github_url_for_mode(&revision_api_url, github_access_mode);
    let revision_response = client
        .get(&revision_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .map_err(|error| {
            format!(
                "Failed to fetch toolchain revision {} from {revision_url}: {error}",
                channel.revision
            )
        })?;
    let revision_status = revision_response.status();
    if !revision_status.is_success() {
        let body = revision_response.text().unwrap_or_default();
        return Err(github_http_error_message(revision_status, &body));
    }
    let revision_body = revision_response
        .text()
        .map_err(|error| format!("Failed to read toolchain revision response: {error}"))?;
    let revision_release: GitHubRelease = serde_json::from_str(&revision_body)
        .map_err(|error| format!("Failed to parse toolchain revision response: {error}"))?;
    let manifest_asset = select_revision_manifest_asset(&revision_release, &channel)?;

    let manifest_url =
        resolve_github_url_for_mode(&manifest_asset.browser_download_url, github_access_mode);
    let manifest_response = client
        .get(&manifest_url)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| {
            format!(
                "Failed to fetch {} from {manifest_url}: {error}",
                channel.manifest
            )
        })?;
    let manifest_status = manifest_response.status();
    if !manifest_status.is_success() {
        let body = manifest_response.text().unwrap_or_default();
        return Err(github_http_error_message(manifest_status, &body));
    }

    let manifest_bytes = manifest_response
        .bytes()
        .map_err(|error| format!("Failed to read {}: {error}", channel.manifest))?;
    if manifest_bytes.len() as u64 != manifest_asset.size {
        return Err(format!(
            "{} size mismatch: expected {} bytes, received {}",
            channel.manifest,
            manifest_asset.size,
            manifest_bytes.len()
        ));
    }
    verify_channel_manifest(&channel, &manifest_bytes)?;
    let manifest_json = String::from_utf8(manifest_bytes.to_vec())
        .map_err(|error| format!("{} is not valid UTF-8: {error}", channel.manifest))?;

    Ok(LatestToolManifestResult {
        status: "available".to_string(),
        manifest_json: Some(manifest_json),
        revision: Some(channel.revision),
        source: Some("archive".to_string()),
    })
}

fn should_use_legacy_tool_manifest(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::NOT_FOUND
}

fn fetch_legacy_tool_manifest(
    client: &reqwest::blocking::Client,
    github_access_mode: &str,
) -> Result<LatestToolManifestResult, String> {
    let release_url =
        resolve_github_url_for_mode(LEGACY_LATEST_RELEASE_API_URL, github_access_mode);
    let release_response = client
        .get(&release_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .send()
        .map_err(|error| format!("Failed to fetch latest release from {release_url}: {error}"))?;
    let release_status = release_response.status();
    if release_status.as_u16() == 404 {
        return Ok(LatestToolManifestResult {
            status: "no_release".to_string(),
            manifest_json: None,
            revision: None,
            source: None,
        });
    }
    if !release_status.is_success() {
        let body = release_response.text().unwrap_or_default();
        return Err(github_http_error_message(release_status, &body));
    }
    let release_body = release_response
        .text()
        .map_err(|error| format!("Failed to read latest release response: {error}"))?;
    let release_payload: Value = serde_json::from_str(&release_body)
        .map_err(|error| format!("Failed to parse latest release response: {error}"))?;
    let Some(download_url) = find_tool_manifest_download_url(&release_payload) else {
        return Ok(LatestToolManifestResult {
            status: "no_manifest".to_string(),
            manifest_json: None,
            revision: None,
            source: None,
        });
    };

    let manifest_url = resolve_github_url_for_mode(&download_url, github_access_mode);
    let manifest_response = client
        .get(&manifest_url)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| {
            format!("Failed to fetch {TOOLS_MANIFEST_FILE} from {manifest_url}: {error}")
        })?;
    let manifest_status = manifest_response.status();
    if !manifest_status.is_success() {
        let body = manifest_response.text().unwrap_or_default();
        return Err(github_http_error_message(manifest_status, &body));
    }
    let manifest_json = manifest_response
        .text()
        .map_err(|error| format!("Failed to read {TOOLS_MANIFEST_FILE}: {error}"))?;
    let manifest = manifest_from_json(&manifest_json)?;

    Ok(LatestToolManifestResult {
        status: "available".to_string(),
        manifest_json: Some(manifest_json),
        revision: manifest.revision,
        source: Some("legacy".to_string()),
    })
}

fn find_tool_manifest_download_url(payload: &Value) -> Option<String> {
    payload.get("assets")?.as_array()?.iter().find_map(|asset| {
        let name = asset.get("name")?.as_str()?;
        let download_url = asset.get("browser_download_url")?.as_str()?;
        (name == TOOLS_MANIFEST_FILE).then(|| download_url.to_string())
    })
}

fn resolve_github_url_for_mode(url: &str, github_access_mode: &str) -> String {
    if github_access_mode == "gh-proxy" && !url.starts_with(GITHUB_PROXY_URL_PREFIX) {
        format!("{GITHUB_PROXY_URL_PREFIX}{url}")
    } else {
        url.to_string()
    }
}

fn validate_github_access_mode(github_access_mode: &str) -> Result<(), String> {
    match github_access_mode {
        "direct" | "gh-proxy" => Ok(()),
        _ => Err(format!(
            "Unsupported GitHub access mode: {github_access_mode}"
        )),
    }
}

fn github_download_url_prefix(github_access_mode: &str) -> Result<Option<&'static str>, String> {
    validate_github_access_mode(github_access_mode)?;
    Ok((github_access_mode == "gh-proxy").then_some(GITHUB_PROXY_URL_PREFIX))
}

fn github_http_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let api_message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|payload| payload.get("message")?.as_str().map(str::to_string));

    match api_message {
        Some(message) if !message.is_empty() => format!("{status}: {message}"),
        _ => status.to_string(),
    }
}

fn manifest_target_from_manifest(
    manifest: ToolsManifest,
    target: &str,
) -> Result<ManifestTarget, String> {
    manifest_target(&manifest, target)
}

fn read_current_manifest(app: &AppHandle) -> Result<ToolsManifest, String> {
    manifest_from_json(&read_current_manifest_json(app)?)
}

fn read_current_manifest_json(app: &AppHandle) -> Result<String, String> {
    let target = current_tool_target()?;
    let base = app_data_root()?;
    if let Some(state) = read_active_state(&base, &target)? {
        let _ = active_tool_paths(&base, &target)?;
        let path = revision_root(&base, &target, &state.revision)?.join(REVISION_MANIFEST_FILE);
        return fs::read_to_string(&path).map_err(|error| {
            format!(
                "Failed to read active toolchain manifest at {}: {error}",
                path.display()
            )
        });
    }

    let bundled_path = bundled_manifest_path(app)?;
    let bundled_json = fs::read_to_string(&bundled_path).map_err(to_string)?;
    let bundled_manifest = manifest_from_json(&bundled_json)?;
    let active_manifest = active_tools_manifest_path()
        .ok()
        .filter(|path| path.exists())
        .map(|path| {
            let json = fs::read_to_string(&path).map_err(to_string)?;
            let manifest = manifest_from_json(&json)?;
            Ok::<_, String>((json, manifest))
        })
        .transpose()?;

    match active_manifest {
        Some((json, manifest))
            if manifest_freshness_key(&manifest) > manifest_freshness_key(&bundled_manifest) =>
        {
            Ok(json)
        }
        _ => Ok(bundled_json),
    }
}

#[cfg(test)]
fn select_preferred_manifest<'a>(
    bundled: &'a ToolsManifest,
    active: Option<&'a ToolsManifest>,
) -> &'a ToolsManifest {
    match active {
        Some(active) if manifest_freshness_key(active) > manifest_freshness_key(bundled) => active,
        _ => bundled,
    }
}

fn manifest_freshness_key(manifest: &ToolsManifest) -> &str {
    manifest.retrieved_at_utc.as_deref().unwrap_or("")
}

fn active_tools_manifest_path() -> Result<PathBuf, String> {
    Ok(active_tools_manifest_path_for(&app_data_root()?))
}

fn active_tools_manifest_path_for(root: &Path) -> PathBuf {
    root.join(TOOLS_MANIFEST_FILE)
}

fn bundled_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
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

fn install_and_activate_manifest(
    app: &AppHandle,
    manifest_json: &str,
    target_name: &str,
    github_access_mode: &str,
    force_fresh: bool,
) -> Result<Vec<ToolStatus>, String> {
    let manifest = manifest_from_json(manifest_json)?;
    let target = manifest_target_from_manifest(manifest, target_name)?;
    let base = app_data_root()?;
    let previous_revision = read_active_state(&base, target_name)?.map(|state| state.revision);
    let reporter = TauriProgressReporter { app };
    let staged = stage_target_revision(StageTargetRevisionRequest {
        target: &target,
        manifest_json,
        base_root: &base,
        asset_root: None,
        download_url_prefix: github_download_url_prefix(github_access_mode)?,
        reporter: &reporter,
        force_fresh,
    })?;
    let state = ActiveToolchainState::new(
        target_name,
        staged.revision(),
        staged.manifest_sha256(),
        previous_revision,
    )?;
    let promoted = promote_staged_toolchain(staged)?;
    if let Err(activation_error) = activate_revision(&base, &state) {
        return match promoted.rollback() {
            Ok(()) => Err(activation_error),
            Err(rollback_error) => Err(format!(
                "{activation_error}. Toolchain file rollback also failed: {rollback_error}"
            )),
        };
    }
    let paths = promoted.paths.clone();
    promoted.commit();
    probe_target(&paths, &target)
}

struct TauriProgressReporter<'a> {
    app: &'a AppHandle,
}

impl ProgressReporter for TauriProgressReporter<'_> {
    fn emit(&self, progress: ToolInstallProgress) {
        emit_tool_install_progress(self.app, progress);
    }
}

fn probe_manifest_tools(
    app: &AppHandle,
    target: &ManifestTarget,
) -> Result<Vec<ToolStatus>, String> {
    let tools = locate_managed_tools(app)?;
    probe_target(&tools, target)
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

fn build_app_state(tools_root: String) -> Result<AppState, String> {
    let target = current_tool_target()?;
    let toolchain_source = read_toolchain_source()?;
    let local_toolchain = read_local_toolchain_config()?;
    let local_resolution = resolve_local_toolchain(&local_toolchain, &target)?;
    let ffmpeg_directory = local_resolution.ffmpeg_directory().map(Path::to_path_buf);
    let local_toolchain_paths = LocalToolchainPaths {
        yt_dlp_path: local_resolution.yt_dlp,
        ffmpeg_directory,
        deno_path: local_resolution.deno,
    };
    Ok(AppState {
        download_directory: download_directory()?.display().to_string(),
        tools_root,
        toolchain_revision: read_active_state(&app_data_root()?, &target)?
            .map(|state| state.revision),
        toolchain_source,
        local_toolchain,
        local_toolchain_paths,
        cookies_file: cookies_file()?.map(|path| path.display().to_string()),
    })
}

fn optional_input_path(value: Option<String>) -> Option<PathBuf> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
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

fn cookies_file() -> Result<Option<PathBuf>, String> {
    let configured = cookies_file_state_path()?;
    if configured.exists() {
        let value = fs::read_to_string(configured).map_err(to_string)?;
        let value = value.trim();
        if !value.is_empty() {
            return Ok(Some(PathBuf::from(value)));
        }
    }

    Ok(None)
}

fn prepared_cookies_file_for_url(url: &str) -> Result<Option<PreparedCookiesFile>, String> {
    let Some(path) = cookies_file()? else {
        return Ok(None);
    };

    prepare_cookies_file_path_for_url(&path, url).map(Some)
}

fn validate_cookies_file_path(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("Cookie file does not exist: {}", path.display()));
    }

    fs::File::open(path)
        .map(|_| ())
        .map_err(|error| format!("Cookie file cannot be opened: {}: {error}", path.display()))
}

fn prepare_cookies_file_path_for_url(
    path: &Path,
    url: &str,
) -> Result<PreparedCookiesFile, String> {
    validate_cookies_file_path(path)?;
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Cookie file cannot be read as text: {}: {error}",
            path.display()
        )
    })?;

    if is_netscape_cookie_content(&content) {
        return Ok(PreparedCookiesFile {
            path: path.to_path_buf(),
            temporary: false,
        });
    }

    if !looks_like_cookie_header_content(&content) {
        return Err(
            "Cookie file must be Netscape cookies.txt or a one-line Cookie header such as `a=b; c=d`."
                .to_string(),
        );
    }

    let converted = cookie_header_to_netscape_content(url, &content)?;
    let converted_path = temp_cookies_file_path();
    fs::write(&converted_path, converted).map_err(|error| {
        format!(
            "Failed to prepare temporary Cookie header file at {}: {error}",
            converted_path.display()
        )
    })?;

    Ok(PreparedCookiesFile {
        path: converted_path,
        temporary: true,
    })
}

fn cookies_file_state_path() -> Result<PathBuf, String> {
    Ok(state_directory()?.join("cookies-file.txt"))
}

fn yt_dlp_cookie_args(cookies_file: Option<&Path>) -> Vec<String> {
    cookies_file
        .map(|path| vec!["--cookies".to_string(), path.display().to_string()])
        .unwrap_or_default()
}

fn is_netscape_cookie_content(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return false;
        }

        line.split('\t').count() == 7
    })
}

fn looks_like_cookie_header_content(content: &str) -> bool {
    parse_cookie_header_pairs(content)
        .map(|pairs| !pairs.is_empty())
        .unwrap_or(false)
}

fn cookie_header_to_netscape_content(url: &str, content: &str) -> Result<String, String> {
    let (domain, include_subdomains) = cookie_domain_for_url(url)?;
    let include_subdomains = if include_subdomains { "TRUE" } else { "FALSE" };
    let secure = if url.starts_with("https://") {
        "TRUE"
    } else {
        "FALSE"
    };
    let pairs = parse_cookie_header_pairs(content)?;
    if pairs.is_empty() {
        return Err("Cookie header file does not contain any cookie pairs.".to_string());
    }

    let mut lines = vec![
        "# Netscape HTTP Cookie File".to_string(),
        "# Generated by yt-dlp-tauri from a Cookie header file.".to_string(),
    ];

    for (name, value) in pairs {
        lines.push(format!(
            "{domain}\t{include_subdomains}\t/\t{secure}\t{COOKIE_HEADER_EXPIRY}\t{name}\t{value}"
        ));
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

fn parse_cookie_header_pairs(content: &str) -> Result<Vec<(String, String)>, String> {
    let joined = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let header = strip_cookie_header_prefix(&joined).trim();
    if !header.contains('=') {
        return Err("Cookie header file does not contain `name=value` pairs.".to_string());
    }

    let mut pairs = Vec::new();
    for part in header.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }

        let Some((name, value)) = part.split_once('=') else {
            return Err(format!("Cookie header entry is missing `=`: {part}"));
        };
        let name = name.trim();
        if name.is_empty() || !is_safe_cookie_field(name) {
            return Err(format!(
                "Cookie header contains an invalid cookie name: {name}"
            ));
        }
        if !is_safe_cookie_field(value) {
            return Err(format!(
                "Cookie header contains an invalid value for {name}."
            ));
        }

        pairs.push((name.to_string(), value.trim().to_string()));
    }

    Ok(pairs)
}

fn strip_cookie_header_prefix(content: &str) -> &str {
    let trimmed = content.trim_start();
    if trimmed
        .get(..7)
        .map(|prefix| prefix.eq_ignore_ascii_case("cookie:"))
        .unwrap_or(false)
    {
        &trimmed[7..]
    } else {
        trimmed
    }
}

fn is_safe_cookie_field(value: &str) -> bool {
    !value
        .chars()
        .any(|character| character == '\t' || character == '\r' || character == '\n')
}

fn cookie_domain_for_url(url: &str) -> Result<(String, bool), String> {
    let host = http_url_host(url)
        .ok_or_else(|| "Unable to determine host for Cookie header conversion.".to_string())?;
    if host == "localhost" || host.parse::<std::net::IpAddr>().is_ok() {
        return Ok((host, false));
    }

    let labels = host
        .split('.')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if labels.len() < 2 {
        return Ok((host, false));
    }

    let base = if labels.len() > 2 && labels.first().is_some_and(|label| *label == "www") {
        labels[1..].join(".")
    } else if labels.len() > 2 {
        labels[labels.len() - 2..].join(".")
    } else {
        host
    };

    Ok((format!(".{base}"), true))
}

fn http_url_host(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    if authority.starts_with('[') {
        return authority
            .split_once(']')
            .map(|(host, _)| host.trim_start_matches('[').to_ascii_lowercase());
    }

    authority
        .split(':')
        .next()
        .filter(|host| !host.trim().is_empty())
        .map(|host| host.trim().to_ascii_lowercase())
}

fn temp_cookies_file_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    env::temp_dir().join(format!(
        "yt-dlp-tauri-cookies-{}-{stamp}.txt",
        std::process::id()
    ))
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

fn read_toolchain_source() -> Result<ToolchainSource, String> {
    let path = state_directory()?.join(TOOLCHAIN_SOURCE_FILE);
    if !path.exists() {
        return parse_toolchain_source_state(None);
    }
    let value = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read toolchain source at {}: {error}",
            path.display()
        )
    })?;
    parse_toolchain_source_state(Some(&value))
}

fn parse_toolchain_source_state(value: Option<&str>) -> Result<ToolchainSource, String> {
    match value {
        None => Ok(ToolchainSource::Managed),
        Some(value) => ToolchainSource::parse(value),
    }
}

fn write_toolchain_source(source: ToolchainSource) -> Result<(), String> {
    let directory = state_directory()?;
    fs::create_dir_all(&directory).map_err(to_string)?;
    let path = directory.join(TOOLCHAIN_SOURCE_FILE);
    fs::write(&path, format!("{}\n", source.as_str())).map_err(|error| {
        format!(
            "Failed to save toolchain source at {}: {error}",
            path.display()
        )
    })
}

fn read_local_toolchain_config() -> Result<LocalToolchainConfig, String> {
    let path = state_directory()?.join(LOCAL_TOOLCHAIN_CONFIG_FILE);
    if !path.exists() {
        return Ok(LocalToolchainConfig::default());
    }
    let json = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read local toolchain configuration at {}: {error}",
            path.display()
        )
    })?;
    parse_local_toolchain_config(&json)
}

fn write_local_toolchain_config(config: &LocalToolchainConfig) -> Result<(), String> {
    let directory = state_directory()?;
    fs::create_dir_all(&directory).map_err(to_string)?;
    let path = directory.join(LOCAL_TOOLCHAIN_CONFIG_FILE);
    let mut json = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to serialize local toolchain configuration: {error}"))?;
    json.push(b'\n');
    fs::write(&path, json).map_err(|error| {
        format!(
            "Failed to save local toolchain configuration at {}: {error}",
            path.display()
        )
    })
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

fn first_matching_line(bytes: &[u8], predicate: impl Fn(&str) -> bool) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && predicate(line))
        .map(ToOwned::to_owned)
}

fn process_detail_line(stderr: &[u8], stdout: &[u8]) -> Option<String> {
    first_matching_line(stderr, |line| line.starts_with("ERROR:"))
        .or_else(|| first_matching_line(stdout, |line| line.starts_with("ERROR:")))
        .or_else(|| first_matching_line(stderr, |line| !line.starts_with("WARNING:")))
        .or_else(|| first_matching_line(stdout, |line| !line.starts_with("WARNING:")))
        .or_else(|| first_line(stderr))
        .or_else(|| first_line(stdout))
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
    let details = process_detail_line(stderr, stdout);

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
    use std::collections::BTreeMap;

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

        for target_name in ["win-x64"] {
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
                    tool.path
                        .starts_with(&format!("{TOOLS_DIRECTORY}/{target_name}/")),
                    "{} for {} has path outside its target: {}",
                    tool.name,
                    target_name,
                    tool.path
                );
            }
        }
    }

    #[test]
    fn prefers_newer_active_manifest_over_bundled_manifest() {
        let bundled = ToolsManifest {
            schema_version: 2,
            revision: None,
            retrieved_at_utc: Some("2026-06-01T00:00:00Z".to_string()),
            targets: Vec::new(),
        };
        let active = ToolsManifest {
            schema_version: 2,
            revision: None,
            retrieved_at_utc: Some("2026-06-23T00:00:00Z".to_string()),
            targets: Vec::new(),
        };

        let selected = select_preferred_manifest(&bundled, Some(&active));

        assert_eq!(
            selected.retrieved_at_utc.as_deref(),
            Some("2026-06-23T00:00:00Z")
        );
    }

    #[test]
    fn keeps_newer_bundled_manifest_over_stale_active_manifest() {
        let bundled = ToolsManifest {
            schema_version: 2,
            revision: None,
            retrieved_at_utc: Some("2026-06-23T00:00:00Z".to_string()),
            targets: Vec::new(),
        };
        let active = ToolsManifest {
            schema_version: 2,
            revision: None,
            retrieved_at_utc: Some("2026-06-01T00:00:00Z".to_string()),
            targets: Vec::new(),
        };

        let selected = select_preferred_manifest(&bundled, Some(&active));

        assert_eq!(
            selected.retrieved_at_utc.as_deref(),
            Some("2026-06-23T00:00:00Z")
        );
    }

    #[test]
    fn resolves_github_urls_through_proxy_when_requested() {
        assert_eq!(
            resolve_github_url_for_mode("https://github.com/Chlience/yt-dlp-tauri", "direct"),
            "https://github.com/Chlience/yt-dlp-tauri"
        );
        assert_eq!(
            resolve_github_url_for_mode("https://github.com/Chlience/yt-dlp-tauri", "gh-proxy"),
            "https://gh-proxy.com/https://github.com/Chlience/yt-dlp-tauri"
        );
        assert_eq!(
            resolve_github_url_for_mode(
                "https://gh-proxy.com/https://github.com/Chlience/yt-dlp-tauri",
                "gh-proxy"
            ),
            "https://gh-proxy.com/https://github.com/Chlience/yt-dlp-tauri"
        );
    }

    #[test]
    fn finds_tool_manifest_download_url_in_release_payload() {
        let payload = serde_json::json!({
            "assets": [
                {
                    "name": "yt-dlp-tauri_0.1.10_windows_x64-setup.exe",
                    "browser_download_url": "https://example.test/setup.exe"
                },
                {
                    "name": "tools-manifest.json",
                    "browser_download_url": "https://github.com/Chlience/yt-dlp-tauri/releases/download/v0.1.10/tools-manifest.json"
                }
            ]
        });

        assert_eq!(
            find_tool_manifest_download_url(&payload).as_deref(),
            Some("https://github.com/Chlience/yt-dlp-tauri/releases/download/v0.1.10/tools-manifest.json")
        );
    }

    #[test]
    fn github_http_error_message_prefers_api_message_body() {
        assert_eq!(
            github_http_error_message(
                reqwest::StatusCode::FORBIDDEN,
                r#"{"message":"API rate limit exceeded"}"#
            ),
            "403 Forbidden: API rate limit exceeded"
        );
        assert_eq!(
            github_http_error_message(reqwest::StatusCode::NOT_FOUND, ""),
            "404 Not Found"
        );
    }

    #[test]
    fn legacy_tool_manifest_is_used_only_when_stable_channel_is_absent() {
        assert!(should_use_legacy_tool_manifest(
            reqwest::StatusCode::NOT_FOUND
        ));
        assert!(!should_use_legacy_tool_manifest(
            reqwest::StatusCode::FORBIDDEN
        ));
        assert!(!should_use_legacy_tool_manifest(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ));
    }

    #[test]
    fn install_update_and_reinstall_share_one_activation_path() {
        let source = include_str!("lib.rs");
        let production = source.split("#[cfg(test)]\nmod tests").next().unwrap();

        assert!(production.matches("install_and_activate_manifest(").count() >= 4);
        assert!(!production.contains("remove_managed_toolchain(&root)?"));
    }

    #[test]
    fn omits_cookie_args_without_configured_file() {
        assert!(yt_dlp_cookie_args(None).is_empty());
    }

    #[test]
    fn passes_configured_cookie_file_to_yt_dlp() {
        let args = yt_dlp_cookie_args(Some(Path::new("account-cookies.txt")));

        assert_eq!(
            args,
            vec!["--cookies".to_string(), "account-cookies.txt".to_string()]
        );
    }

    #[test]
    fn converts_cookie_header_file_content_to_netscape_cookie_content() {
        let content = cookie_header_to_netscape_content(
            "https://www.bilibili.com/video/BV1test",
            "Cookie: buvid3=abc; bili_jct=token_value; CURRENT_FNVAL=2000",
        )
        .expect("cookie header should convert");

        assert_eq!(
            content,
            [
                "# Netscape HTTP Cookie File",
                "# Generated by yt-dlp-tauri from a Cookie header file.",
                ".bilibili.com\tTRUE\t/\tTRUE\t2147483647\tbuvid3\tabc",
                ".bilibili.com\tTRUE\t/\tTRUE\t2147483647\tbili_jct\ttoken_value",
                ".bilibili.com\tTRUE\t/\tTRUE\t2147483647\tCURRENT_FNVAL\t2000",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn converts_bare_cookie_header_file_content_to_netscape_cookie_content() {
        let content = cookie_header_to_netscape_content(
            "https://www.bilibili.com/video/BV1test",
            "buvid3=abc; bili_jct=token_value",
        )
        .expect("bare cookie header should convert");

        assert!(content.contains(".bilibili.com\tTRUE\t/\tTRUE\t2147483647\tbuvid3\tabc"));
        assert!(content.contains(".bilibili.com\tTRUE\t/\tTRUE\t2147483647\tbili_jct\ttoken_value"));
    }

    #[test]
    fn detects_netscape_cookie_content() {
        assert!(is_netscape_cookie_content(
            "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tbuvid3\tabc\n"
        ));
        assert!(!is_netscape_cookie_content(
            "buvid3=abc; bili_jct=token_value"
        ));
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
    fn process_failure_message_prefers_error_lines_over_warnings() {
        let message = process_failure_message(
            "Failed to parse video metadata.",
            Some(1),
            b"WARNING: Your yt-dlp version (2026.03.17) is older than 90 days!\nERROR: [youtube] abc123: Sign in to confirm you are not a bot\n",
            b"",
        );

        assert_eq!(
            message,
            "Failed to parse video metadata. Exit code 1. ERROR: [youtube] abc123: Sign in to confirm you are not a bot"
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
    fn toolchain_source_state_defaults_to_managed() {
        assert_eq!(
            parse_toolchain_source_state(None).expect("missing state should use the default"),
            ToolchainSource::Managed
        );
        assert_eq!(
            parse_toolchain_source_state(Some("local\n"))
                .expect("stored local source should parse"),
            ToolchainSource::Local
        );
    }

    #[test]
    fn toolchain_source_state_rejects_unknown_values() {
        assert!(parse_toolchain_source_state(Some("automatic")).is_err());
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
            set_cookies_file,
            clear_cookies_file,
            open_download_directory,
            set_toolchain_source,
            set_local_toolchain,
            auto_detect_local_toolchain,
            check_tools,
            check_tools_with_manifest,
            fetch_latest_tool_manifest,
            install_tools,
            install_tools_from_manifest,
            reinstall_tools,
            parse_metadata,
            download_video,
            cancel_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
