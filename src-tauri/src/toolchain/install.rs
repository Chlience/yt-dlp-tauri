use super::{
    archive::{extract_requested_members, ArchiveMemberRequest},
    manifest_target, parse_manifest, probe_target, relative_manifest_tool_path, revision_root,
    revisions_root, sha256_bytes, tool_paths_from_manifest, verify_toolchain_combination,
    ManifestTarget, ManifestTool, ManifestToolKind, ToolInstallProgress, ToolPaths,
    ToolchainRevision, REVISION_MANIFEST_FILE,
};
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const TOOL_DOWNLOAD_MAX_ATTEMPTS: usize = 3;
const ARCHIVE_DOWNLOAD_PREFIX: &str =
    "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-";

pub trait ProgressReporter {
    fn emit(&self, progress: ToolInstallProgress);
}

pub struct NoopProgressReporter;

impl ProgressReporter for NoopProgressReporter {
    fn emit(&self, _progress: ToolInstallProgress) {}
}

pub struct InstallTargetRequest<'a> {
    pub target: &'a ManifestTarget,
    pub install_root: &'a Path,
    pub temp_root: &'a Path,
    pub asset_root: Option<&'a Path>,
    pub reporter: &'a dyn ProgressReporter,
}

pub struct StageTargetRevisionRequest<'a> {
    pub target: &'a ManifestTarget,
    pub manifest_json: &'a str,
    pub base_root: &'a Path,
    pub asset_root: Option<&'a Path>,
    pub download_url_prefix: Option<&'a str>,
    pub reporter: &'a dyn ProgressReporter,
    pub force_fresh: bool,
}

pub struct StagedToolchain {
    target: ManifestTarget,
    revision: String,
    manifest_sha256: String,
    final_root: PathBuf,
    staging_root: Option<PathBuf>,
    paths: ToolPaths,
}

impl StagedToolchain {
    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }

    pub fn paths(&self) -> &ToolPaths {
        &self.paths
    }
}

impl Drop for StagedToolchain {
    fn drop(&mut self) {
        if let Some(staging_root) = self.staging_root.take() {
            let _ = fs::remove_dir_all(staging_root);
        }
    }
}

#[must_use = "promoted toolchains must be committed or rolled back"]
pub struct PromotedToolchain {
    pub paths: ToolPaths,
    pub revision: String,
    pub manifest_sha256: String,
    final_root: PathBuf,
    rollback_root: Option<PathBuf>,
    backup_root: Option<PathBuf>,
}

impl PromotedToolchain {
    pub fn commit(self) {}

    pub fn rollback(mut self) -> Result<(), String> {
        let Some(rollback_root) = self.rollback_root.take() else {
            return Ok(());
        };
        fs::rename(&self.final_root, &rollback_root).map_err(|error| {
            format!(
                "Failed to move rejected toolchain revision {} out of {}: {error}",
                self.revision,
                self.final_root.display()
            )
        })?;
        if let Some(backup_root) = self.backup_root.take() {
            if let Err(error) = fs::rename(&backup_root, &self.final_root) {
                let restore_new_result = fs::rename(&rollback_root, &self.final_root);
                return Err(format!(
                    "Failed to restore previous toolchain revision from {}: {error}. Restoring the verified replacement returned {:?}",
                    backup_root.display(),
                    restore_new_result.err()
                ));
            }
        }
        if rollback_root.exists() {
            fs::remove_dir_all(&rollback_root).map_err(|error| {
                format!(
                    "Failed to clean rejected toolchain revision at {}: {error}",
                    rollback_root.display()
                )
            })?;
        }
        Ok(())
    }
}

pub fn stage_target_revision(
    request: StageTargetRevisionRequest<'_>,
) -> Result<StagedToolchain, String> {
    let manifest = parse_manifest(request.manifest_json)?;
    let revision = manifest
        .revision
        .as_deref()
        .ok_or_else(|| "Toolchain manifest is missing revision".to_string())?;
    let revision = ToolchainRevision::parse(revision)?.to_string();
    let target = manifest_target(&manifest, &request.target.target)?;
    let manifest_sha256 = sha256_bytes(request.manifest_json.as_bytes());
    let final_root = revision_root(request.base_root, &target.target, &revision)?;

    if !request.force_fresh {
        if let Ok(paths) = verify_revision_files(&final_root, &target, &revision, &manifest_sha256)
        {
            return Ok(StagedToolchain {
                target,
                revision,
                manifest_sha256,
                final_root,
                staging_root: None,
                paths,
            });
        }
    }

    let revisions = revisions_root(request.base_root, &target.target);
    fs::create_dir_all(&revisions).map_err(|error| {
        format!(
            "Failed to prepare toolchain revisions directory {}: {error}",
            revisions.display()
        )
    })?;
    let staging_root = revisions.join(format!(
        ".staging-{revision}-{}-{}",
        std::process::id(),
        unique_nonce()
    ));
    fs::create_dir(&staging_root).map_err(|error| {
        format!(
            "Failed to create toolchain staging directory {}: {error}",
            staging_root.display()
        )
    })?;
    let result = (|| {
        let temp_root = staging_root.join(".downloads");
        let mut download_target = target.clone();
        if let Some(prefix) = request.download_url_prefix {
            for tool in &mut download_target.tools {
                if !tool.source_url.starts_with(prefix) {
                    tool.source_url = format!("{prefix}{}", tool.source_url);
                }
            }
        }
        install_target(InstallTargetRequest {
            target: &download_target,
            install_root: &staging_root,
            temp_root: &temp_root,
            asset_root: request.asset_root,
            reporter: request.reporter,
        })?;
        if temp_root.exists() {
            fs::remove_dir_all(&temp_root).map_err(|error| {
                format!(
                    "Failed to clean toolchain staging downloads at {}: {error}",
                    temp_root.display()
                )
            })?;
        }
        write_staged_manifest(&staging_root, request.manifest_json)?;
        verify_revision_files(&staging_root, &target, &revision, &manifest_sha256)
    })();
    match result {
        Ok(paths) => Ok(StagedToolchain {
            target,
            revision,
            manifest_sha256,
            final_root,
            staging_root: Some(staging_root),
            paths,
        }),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging_root);
            Err(error)
        }
    }
}

pub fn verify_staged_toolchain(staged: &StagedToolchain) -> Result<ToolPaths, String> {
    let paths = verify_revision_files(
        staged.paths.root.as_path(),
        &staged.target,
        &staged.revision,
        &staged.manifest_sha256,
    )?;
    let statuses = probe_target(&paths, &staged.target)?;
    if let Some(failed) = statuses
        .iter()
        .find(|tool| tool.availability != "available")
    {
        return Err(format!(
            "Staged toolchain probe failed for {}: {}",
            failed.name,
            failed
                .error
                .as_deref()
                .unwrap_or(failed.availability.as_str())
        ));
    }
    verify_toolchain_combination(&paths)?;
    Ok(paths)
}

pub fn promote_staged_toolchain(mut staged: StagedToolchain) -> Result<PromotedToolchain, String> {
    let _ = verify_staged_toolchain(&staged)?;
    let promoted_paths = tool_paths_from_manifest(&staged.final_root, &staged.target)?;
    let Some(staging_root) = staged.staging_root.take() else {
        return Ok(PromotedToolchain {
            paths: staged.paths.clone(),
            revision: staged.revision.clone(),
            manifest_sha256: staged.manifest_sha256.clone(),
            final_root: staged.final_root.clone(),
            rollback_root: None,
            backup_root: None,
        });
    };
    let parent = staged
        .final_root
        .parent()
        .ok_or_else(|| "Toolchain revision directory has no parent".to_string())?;
    let rollback_root = parent.join(format!(
        ".rollback-{}-{}-{}",
        staged.revision,
        std::process::id(),
        unique_nonce()
    ));
    let backup_root = if staged.final_root.exists() {
        let backup = parent.join(format!(
            ".previous-{}-{}-{}",
            staged.revision,
            std::process::id(),
            unique_nonce()
        ));
        fs::rename(&staged.final_root, &backup).map_err(|error| {
            format!(
                "Failed to preserve existing toolchain revision at {}: {error}",
                staged.final_root.display()
            )
        })?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(&staging_root, &staged.final_root) {
        staged.staging_root = Some(staging_root);
        if let Some(backup) = backup_root.as_ref() {
            fs::rename(backup, &staged.final_root).map_err(|restore_error| {
                format!(
                    "Failed to promote toolchain revision {}: {error}. Restoring {} also failed: {restore_error}",
                    staged.revision,
                    backup.display()
                )
            })?;
        }
        return Err(format!(
            "Failed to promote toolchain revision {} to {}: {error}",
            staged.revision,
            staged.final_root.display()
        ));
    }

    Ok(PromotedToolchain {
        paths: promoted_paths,
        revision: staged.revision.clone(),
        manifest_sha256: staged.manifest_sha256.clone(),
        final_root: staged.final_root.clone(),
        rollback_root: Some(rollback_root),
        backup_root,
    })
}

fn write_staged_manifest(root: &Path, manifest_json: &str) -> Result<(), String> {
    let path = root.join(REVISION_MANIFEST_FILE);
    let mut file = fs::File::create(&path).map_err(|error| {
        format!(
            "Failed to create staged toolchain manifest {}: {error}",
            path.display()
        )
    })?;
    file.write_all(manifest_json.as_bytes()).map_err(|error| {
        format!(
            "Failed to write staged toolchain manifest {}: {error}",
            path.display()
        )
    })?;
    file.flush().map_err(|error| {
        format!(
            "Failed to flush staged toolchain manifest {}: {error}",
            path.display()
        )
    })?;
    file.sync_all().map_err(|error| {
        format!(
            "Failed to sync staged toolchain manifest {}: {error}",
            path.display()
        )
    })
}

fn verify_revision_files(
    root: &Path,
    target: &ManifestTarget,
    revision: &str,
    manifest_sha256: &str,
) -> Result<ToolPaths, String> {
    let manifest_path = root.join(REVISION_MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Failed to read staged toolchain manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let actual_manifest_sha256 = sha256_bytes(&manifest_bytes);
    if actual_manifest_sha256 != manifest_sha256 {
        return Err(format!(
            "Staged toolchain manifest SHA-256 mismatch: expected {manifest_sha256}, received {actual_manifest_sha256}"
        ));
    }
    let manifest_json = std::str::from_utf8(&manifest_bytes)
        .map_err(|error| format!("Staged toolchain manifest is not valid UTF-8: {error}"))?;
    let manifest = parse_manifest(manifest_json)?;
    if manifest.revision.as_deref() != Some(revision) {
        return Err(format!(
            "Staged toolchain manifest revision does not match {revision}"
        ));
    }
    let stored_target = manifest_target(&manifest, &target.target)?;
    for tool in &stored_target.tools {
        let path = root.join(relative_manifest_tool_path(tool)?);
        if !path.is_file() {
            return Err(format!(
                "Staged toolchain is missing {}/{} at {}",
                stored_target.target,
                tool.name,
                path.display()
            ));
        }
        verify_sha256(&path, &tool.sha256)?;
    }
    tool_paths_from_manifest(root, &stored_target)
}

pub fn install_target(request: InstallTargetRequest<'_>) -> Result<ToolPaths, String> {
    fs::create_dir_all(request.install_root).map_err(|error| {
        format!(
            "Failed to prepare tool directory {}: {error}",
            request.install_root.display()
        )
    })?;
    fs::create_dir_all(request.temp_root).map_err(|error| {
        format!(
            "Failed to prepare tool download directory {}: {error}",
            request.temp_root.display()
        )
    })?;
    request.reporter.emit(ToolInstallProgress {
        percent: Some(0.0),
        status: format!("Installing toolchain for {}", request.target.target),
        tool: None,
    });

    let mut zip_groups = Vec::<Vec<&ManifestTool>>::new();
    for tool in &request.target.tools {
        match tool.kind {
            ManifestToolKind::File => install_file_tool(&request, tool)
                .map_err(|error| format!("Failed to install {}: {error}", tool.name))?,
            ManifestToolKind::Zip => {
                if let Some(group) = zip_groups.iter_mut().find(|group| {
                    group
                        .first()
                        .is_some_and(|first| first.source_url == tool.source_url)
                }) {
                    group.push(tool);
                } else {
                    zip_groups.push(vec![tool]);
                }
            }
        }
    }

    for tools in zip_groups {
        let label = zip_group_label(&tools);
        install_zip_tools(&request, &tools)
            .map_err(|error| format!("Failed to install {label}: {error}"))?;
    }

    for tool in &request.target.tools {
        let path = request
            .install_root
            .join(relative_manifest_tool_path(tool)?);
        if !path.exists() {
            return Err(format!(
                "Installed tool is missing after install: {}",
                path.display()
            ));
        }
        verify_sha256(&path, &tool.sha256)?;
    }

    let paths = tool_paths_from_manifest(request.install_root, request.target)?;
    request.reporter.emit(ToolInstallProgress {
        percent: Some(100.0),
        status: "Toolchain installed".to_string(),
        tool: None,
    });
    Ok(paths)
}

fn install_file_tool(
    request: &InstallTargetRequest<'_>,
    tool: &ManifestTool,
) -> Result<(), String> {
    let destination = request
        .install_root
        .join(relative_manifest_tool_path(tool)?);
    let temporary = temporary_sibling(&destination, "download");
    remove_partial_download(&temporary);
    let result = (|| {
        acquire_source(
            request,
            tool,
            &temporary,
            &format!("Downloading {}", tool.name),
            &tool.name,
        )?;
        request.reporter.emit(ToolInstallProgress {
            percent: None,
            status: format!("Verifying {}", tool.name),
            tool: Some(tool.name.clone()),
        });
        verify_manifest_source(&temporary, tool)?;
        verify_sha256(&temporary, &tool.sha256)?;
        mark_executable(&temporary)?;
        replace_file(&temporary, &destination, &tool.name)
    })();
    if result.is_err() {
        remove_partial_download(&temporary);
    }
    result
}

fn install_zip_tools(
    request: &InstallTargetRequest<'_>,
    tools: &[&ManifestTool],
) -> Result<(), String> {
    let first = tools
        .first()
        .ok_or_else(|| "Zip tool group cannot be empty".to_string())?;
    let nonce = unique_nonce();
    let archive_path = request
        .temp_root
        .join(format!("{}-{nonce}.zip", sanitize_file_name(&first.name)));
    acquire_source(
        request,
        first,
        &archive_path,
        &format!("Downloading {}", zip_group_label(tools)),
        &first.name,
    )?;
    verify_manifest_source(&archive_path, first)?;

    let temporary_paths = tools
        .iter()
        .map(|tool| {
            let destination = request
                .install_root
                .join(relative_manifest_tool_path(tool)?);
            Ok((
                destination.clone(),
                temporary_sibling(&destination, "extract"),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    for (_, temporary) in &temporary_paths {
        remove_partial_download(temporary);
    }

    let result = (|| {
        let members = tools
            .iter()
            .zip(&temporary_paths)
            .map(|(tool, (_, temporary))| {
                let suffix = tool
                    .archive_path_suffix
                    .as_deref()
                    .ok_or_else(|| format!("{} is missing archivePathSuffix", tool.name))?;
                request.reporter.emit(ToolInstallProgress {
                    percent: None,
                    status: format!("Extracting {}", tool.name),
                    tool: Some(tool.name.clone()),
                });
                Ok(ArchiveMemberRequest {
                    label: &tool.name,
                    suffix,
                    destination: temporary,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        extract_requested_members(&archive_path, &members)?;

        for (tool, (destination, temporary)) in tools.iter().zip(&temporary_paths) {
            verify_sha256(temporary, &tool.sha256)?;
            mark_executable(temporary)?;
            replace_file(temporary, destination, &tool.name)?;
        }
        Ok(())
    })();

    let _ = fs::remove_file(&archive_path);
    for (_, temporary) in temporary_paths {
        remove_partial_download(&temporary);
    }
    result
}

fn replace_file(source: &Path, destination: &Path, label: &str) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare directory {} for {label}: {error}",
                parent.display()
            )
        })?;
    }
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| {
            format!(
                "Failed to replace {label} at {}: {error}",
                destination.display()
            )
        })?;
    }
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Failed to move {label} from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn resolve_local_source(
    asset_root: Option<&Path>,
    tool: &ManifestTool,
) -> Result<Option<PathBuf>, String> {
    let Some(asset_root) = asset_root else {
        return Ok(None);
    };
    let sha256 = tool
        .source_sha256
        .as_deref()
        .ok_or_else(|| format!("{} is missing sourceSha256 for local validation", tool.name))?;
    let size = tool
        .source_size
        .ok_or_else(|| format!("{} is missing sourceSize for local validation", tool.name))?;
    let source = asset_root.join("assets").join(sha256);
    match fs::symlink_metadata(&source) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "Candidate source must be a regular file: {}",
                    source.display()
                ));
            }
            verify_source_file(&source, size, sha256)?;
            Ok(Some(source))
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && tool.source_url.starts_with(ARCHIVE_DOWNLOAD_PREFIX) =>
        {
            Ok(None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "{} source {} is missing from candidate bundle {}",
            tool.name,
            sha256,
            asset_root.display()
        )),
        Err(error) => Err(format!(
            "Failed to inspect candidate source {}: {error}",
            source.display()
        )),
    }
}

fn acquire_source(
    request: &InstallTargetRequest<'_>,
    tool: &ManifestTool,
    destination: &Path,
    status: &str,
    tool_name: &str,
) -> Result<(), String> {
    let Some(source) = resolve_local_source(request.asset_root, tool)? else {
        return download_source_to_file(
            request.reporter,
            &tool.source_url,
            destination,
            status,
            tool_name,
        );
    };
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare candidate copy directory {}: {error}",
                parent.display()
            )
        })?;
    }
    request.reporter.emit(ToolInstallProgress {
        percent: None,
        status: format!("Using verified candidate bytes for {tool_name}"),
        tool: Some(tool_name.to_string()),
    });
    fs::copy(&source, destination).map_err(|error| {
        format!(
            "Failed to copy candidate bytes from {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;
    request.reporter.emit(ToolInstallProgress {
        percent: Some(100.0),
        status: format!("Loaded candidate bytes for {tool_name}"),
        tool: Some(tool_name.to_string()),
    });
    Ok(())
}

fn download_source_to_file(
    reporter: &dyn ProgressReporter,
    source_url: &str,
    destination: &Path,
    status: &str,
    tool_name: &str,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to prepare download directory {}: {error}",
                parent.display()
            )
        })?;
    }
    reporter.emit(ToolInstallProgress {
        percent: None,
        status: status.to_string(),
        tool: Some(tool_name.to_string()),
    });

    let client = build_tool_download_client(tool_name)?;
    for attempt in 1..=TOOL_DOWNLOAD_MAX_ATTEMPTS {
        match download_source_to_file_once(
            reporter,
            &client,
            source_url,
            destination,
            status,
            tool_name,
        ) {
            Ok(()) => {
                reporter.emit(ToolInstallProgress {
                    percent: Some(100.0),
                    status: format!("Downloaded {tool_name}"),
                    tool: Some(tool_name.to_string()),
                });
                return Ok(());
            }
            Err(error) if should_retry_tool_download(&error, attempt) => {
                remove_partial_download(destination);
                reporter.emit(ToolInstallProgress {
                    percent: None,
                    status: format!(
                        "Retrying {tool_name} download ({}/{TOOL_DOWNLOAD_MAX_ATTEMPTS})",
                        attempt + 1
                    ),
                    tool: Some(tool_name.to_string()),
                });
            }
            Err(error) => {
                remove_partial_download(destination);
                return Err(error.message);
            }
        }
    }
    Err(format!("Failed to download {tool_name} from {source_url}"))
}

pub(crate) fn build_tool_download_client(tool_name: &str) -> Result<Client, String> {
    install_rustls_crypto_provider();
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(30 * 60))
        .user_agent(format!("yt-dlp-tauri/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Failed to prepare HTTP client for {tool_name}: {error}"))
}

fn download_source_to_file_once(
    reporter: &dyn ProgressReporter,
    client: &Client,
    source_url: &str,
    destination: &Path,
    status: &str,
    tool_name: &str,
) -> Result<(), ToolDownloadError> {
    let mut response = client.get(source_url).send().map_err(|error| {
        ToolDownloadError::retryable(format!(
            "Failed to download {tool_name} from {source_url}: {error}"
        ))
    })?;
    let status_code = response.status();
    if !status_code.is_success() {
        let message = format!("Failed to download {tool_name} from {source_url}: {status_code}");
        return if is_retryable_http_status(status_code.as_u16()) {
            Err(ToolDownloadError::retryable(message))
        } else {
            Err(ToolDownloadError::fatal(message))
        };
    }

    let total_bytes = response.content_length();
    let mut file = fs::File::create(destination).map_err(|error| {
        ToolDownloadError::fatal(format!(
            "Failed to create download file for {tool_name} at {}: {error}",
            destination.display()
        ))
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded_bytes = 0_u64;
    let mut last_display_percent = None;
    if let Some(percent) = download_progress_percent(0, total_bytes) {
        reporter.emit(ToolInstallProgress {
            percent: Some(percent),
            status: status.to_string(),
            tool: Some(tool_name.to_string()),
        });
        last_display_percent = Some(display_percent_bucket(percent));
    }

    loop {
        let byte_count = response.read(&mut buffer).map_err(|error| {
            ToolDownloadError::retryable(format!(
                "Failed to read HTTP response for {tool_name}: {error}"
            ))
        })?;
        if byte_count == 0 {
            break;
        }
        file.write_all(&buffer[..byte_count]).map_err(|error| {
            ToolDownloadError::fatal(format!(
                "Failed to write downloaded {tool_name} to {}: {error}",
                destination.display()
            ))
        })?;
        downloaded_bytes += byte_count as u64;
        if let Some(percent) = download_progress_percent(downloaded_bytes, total_bytes) {
            let bucket = display_percent_bucket(percent);
            if Some(bucket) != last_display_percent {
                reporter.emit(ToolInstallProgress {
                    percent: Some(percent),
                    status: status.to_string(),
                    tool: Some(tool_name.to_string()),
                });
                last_display_percent = Some(bucket);
            }
        }
    }
    file.flush().map_err(|error| {
        ToolDownloadError::fatal(format!(
            "Failed to flush downloaded {tool_name} to {}: {error}",
            destination.display()
        ))
    })?;
    if total_bytes.is_some_and(|expected| expected != downloaded_bytes) {
        return Err(ToolDownloadError::retryable(format!(
            "Downloaded {downloaded_bytes} bytes for {tool_name}, expected {}",
            total_bytes.unwrap_or_default()
        )));
    }
    Ok(())
}

#[derive(Debug)]
struct ToolDownloadError {
    message: String,
    retryable: bool,
}

impl ToolDownloadError {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }

    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
}

fn should_retry_tool_download(error: &ToolDownloadError, attempt: usize) -> bool {
    error.retryable && attempt < TOOL_DOWNLOAD_MAX_ATTEMPTS
}

fn is_retryable_http_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn download_progress_percent(downloaded: u64, total: Option<u64>) -> Option<f64> {
    let total = total?;
    if total == 0 {
        return None;
    }
    Some((downloaded as f64 / total as f64).clamp(0.0, 1.0) * 100.0)
}

fn display_percent_bucket(percent: f64) -> i64 {
    percent.round() as i64
}

fn remove_partial_download(path: &Path) {
    let _ = fs::remove_file(path);
}

pub(super) fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "SHA-256 mismatch for {}. Expected {}, got {}",
            path.display(),
            expected,
            actual
        ))
    }
}

fn verify_manifest_source(path: &Path, tool: &ManifestTool) -> Result<(), String> {
    match (tool.source_size, tool.source_sha256.as_deref()) {
        (Some(size), Some(sha256)) => verify_source_file(path, size, sha256),
        (None, None) => Ok(()),
        _ => Err(format!(
            "{} has incomplete source integrity metadata",
            tool.name
        )),
    }
}

fn verify_source_file(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    let actual_size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if actual_size != expected_size {
        return Err(format!(
            "Downloaded source {} has {actual_size} bytes, expected {expected_size}",
            path.display()
        ));
    }
    verify_sha256(path, expected_sha256)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn temporary_sibling(destination: &Path, purpose: &str) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("tool");
    destination.with_file_name(format!(".{file_name}.{purpose}.{}", unique_nonce()))
}

fn unique_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
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

fn zip_group_label<T: std::borrow::Borrow<ManifestTool>>(tools: &[T]) -> String {
    tools
        .iter()
        .map(|tool| tool.borrow().name.as_str())
        .collect::<Vec<_>>()
        .join(" / ")
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| error.to_string())?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_source_tool(source_url: &str, size: u64, sha256: &str) -> ManifestTool {
        ManifestTool {
            name: "yt-dlp".to_string(),
            path: "Tools/win-x64/yt-dlp/yt-dlp.exe".to_string(),
            source_url: source_url.to_string(),
            source_size: Some(size),
            source_sha256: Some(sha256.to_string()),
            version: Some("2026.07.04".to_string()),
            sha256: sha256.to_string(),
            kind: ManifestToolKind::File,
            archive_path_suffix: None,
            license_notes: None,
        }
    }

    #[test]
    fn maps_downloaded_bytes_to_current_file_percent() {
        assert_eq!(download_progress_percent(25, Some(100)), Some(25.0));
        assert_eq!(download_progress_percent(100, Some(100)), Some(100.0));
        assert_eq!(download_progress_percent(150, Some(100)), Some(100.0));
        assert_eq!(download_progress_percent(25, None), None);
        assert_eq!(download_progress_percent(25, Some(0)), None);
    }

    #[test]
    fn retries_retryable_tool_download_errors_until_max_attempts() {
        let retryable = ToolDownloadError::retryable("network timeout");
        let fatal = ToolDownloadError::fatal("HTTP 404 Not Found");
        assert!(should_retry_tool_download(&retryable, 1));
        assert!(should_retry_tool_download(
            &retryable,
            TOOL_DOWNLOAD_MAX_ATTEMPTS - 1
        ));
        assert!(!should_retry_tool_download(
            &retryable,
            TOOL_DOWNLOAD_MAX_ATTEMPTS
        ));
        assert!(!should_retry_tool_download(&fatal, 1));
    }

    #[test]
    fn source_file_requires_exact_size_and_sha256() {
        let path =
            std::env::temp_dir().join(format!("yt-dlp-tauri-source-integrity-{}", unique_nonce()));
        fs::write(&path, b"archive").unwrap();
        let digest = sha256_file(&path).unwrap();

        assert!(verify_source_file(&path, 7, &digest).is_ok());
        assert!(verify_source_file(&path, 8, &digest)
            .unwrap_err()
            .contains("expected 8"));
        assert!(verify_source_file(&path, 7, &"a".repeat(64))
            .unwrap_err()
            .contains("SHA-256 mismatch"));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn local_asset_root_resolves_content_addressed_source() {
        let root =
            std::env::temp_dir().join(format!("yt-dlp-tauri-local-source-{}", unique_nonce()));
        let assets = root.join("assets");
        fs::create_dir_all(&assets).unwrap();
        let digest = format!("{:x}", Sha256::digest(b"tool"));
        let source = assets.join(&digest);
        fs::write(&source, b"tool").unwrap();
        let tool = local_source_tool(
            "https://github.com/upstream/tool/releases/download/v1/tool.exe",
            4,
            &digest,
        );

        assert_eq!(
            resolve_local_source(Some(&root), &tool).unwrap(),
            Some(source)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_local_candidate_never_falls_back_to_upstream() {
        let root =
            std::env::temp_dir().join(format!("yt-dlp-tauri-missing-source-{}", unique_nonce()));
        fs::create_dir_all(root.join("assets")).unwrap();
        let digest = "a".repeat(64);
        let upstream = local_source_tool(
            "https://github.com/upstream/tool/releases/download/v1/tool.exe",
            4,
            &digest,
        );
        let archived = local_source_tool(
            "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-20260711.2/tool.exe",
            4,
            &digest,
        );

        assert!(resolve_local_source(Some(&root), &upstream)
            .unwrap_err()
            .contains("missing from candidate bundle"));
        assert_eq!(resolve_local_source(Some(&root), &archived).unwrap(), None);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_staging_preserves_active_revision_and_tools() {
        let base = std::env::temp_dir().join(format!(
            "yt-dlp-tauri-staging-preserves-active-{}",
            unique_nonce()
        ));
        let active_state = base.join("Tools/win-x64/active.json");
        let active_tool = base.join("Tools/win-x64/revisions/20260711.2/yt-dlp/yt-dlp.exe");
        let asset_root = base.join("candidate");
        fs::create_dir_all(active_state.parent().unwrap()).unwrap();
        fs::create_dir_all(active_tool.parent().unwrap()).unwrap();
        fs::create_dir_all(asset_root.join("assets")).unwrap();
        fs::write(&active_state, b"working-state").unwrap();
        fs::write(&active_tool, b"working-tool").unwrap();
        let target = ManifestTarget {
            target: "win-x64".to_string(),
            tools: vec![local_source_tool(
                "https://github.com/upstream/tool/releases/download/v1/tool.exe",
                4,
                &"a".repeat(64),
            )],
        };
        let manifest_json = r#"{
          "schemaVersion": 2,
          "revision": "20260712.1",
          "targets": [{"target":"win-x64","tools":[]}]
        }"#;

        let result = stage_target_revision(StageTargetRevisionRequest {
            target: &target,
            manifest_json,
            base_root: &base,
            asset_root: Some(&asset_root),
            download_url_prefix: None,
            reporter: &NoopProgressReporter,
            force_fresh: true,
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&active_state).unwrap(), b"working-state");
        assert_eq!(fs::read(&active_tool).unwrap(), b"working-tool");
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    fn script_tool(asset_root: &Path, name: &str, path: &str, script: &str) -> ManifestTool {
        let digest = format!("{:x}", Sha256::digest(script.as_bytes()));
        fs::create_dir_all(asset_root.join("assets")).unwrap();
        fs::write(asset_root.join("assets").join(&digest), script).unwrap();
        ManifestTool {
            name: name.to_string(),
            path: path.to_string(),
            source_url: format!("https://example.test/{name}"),
            source_size: Some(script.len() as u64),
            source_sha256: Some(digest.clone()),
            version: Some("fixture".to_string()),
            sha256: digest,
            kind: ManifestToolKind::File,
            archive_path_suffix: None,
            license_notes: None,
        }
    }

    #[cfg(unix)]
    fn staged_script_toolchain(
        base: &Path,
        revision: &str,
        marker: &str,
        force_fresh: bool,
    ) -> StagedToolchain {
        let asset_root = base.join(format!("candidate-{marker}"));
        let target = ManifestTarget {
            target: "win-x64".to_string(),
            tools: vec![
                script_tool(
                    &asset_root,
                    "yt-dlp",
                    "Tools/win-x64/yt-dlp/yt-dlp.exe",
                    &format!(
                        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo yt-dlp-{marker}; fi\nexit 0\n"
                    ),
                ),
                script_tool(
                    &asset_root,
                    "ffmpeg",
                    "Tools/win-x64/ffmpeg/bin/ffmpeg.exe",
                    "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo ffmpeg-fixture; exit 0; fi\nfor output; do :; done\nprintf media > \"$output\"\n",
                ),
                script_tool(
                    &asset_root,
                    "ffprobe",
                    "Tools/win-x64/ffmpeg/bin/ffprobe.exe",
                    "#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then echo ffprobe-fixture; else echo video; fi\n",
                ),
                script_tool(
                    &asset_root,
                    "deno",
                    "Tools/win-x64/deno/deno.exe",
                    "#!/bin/sh\necho deno-fixture\n",
                ),
            ],
        };
        let manifest_json = serde_json::json!({
            "schemaVersion": 2,
            "revision": revision,
            "targets": [target.clone()],
        })
        .to_string();

        stage_target_revision(StageTargetRevisionRequest {
            target: &target,
            manifest_json: &manifest_json,
            base_root: base,
            asset_root: Some(&asset_root),
            download_url_prefix: None,
            reporter: &NoopProgressReporter,
            force_fresh,
        })
        .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn promoted_revision_rollback_restores_previous_tool_bytes() {
        let base = std::env::temp_dir().join(format!(
            "yt-dlp-tauri-promotion-rollback-{}",
            unique_nonce()
        ));
        fs::create_dir_all(&base).unwrap();
        let first =
            promote_staged_toolchain(staged_script_toolchain(&base, "20260712.1", "old", false))
                .unwrap();
        let yt_dlp = first.paths.yt_dlp.clone();
        first.commit();
        assert!(fs::read_to_string(&yt_dlp).unwrap().contains("yt-dlp-old"));

        let replacement =
            promote_staged_toolchain(staged_script_toolchain(&base, "20260712.1", "new", true))
                .unwrap();
        assert!(fs::read_to_string(&yt_dlp).unwrap().contains("yt-dlp-new"));

        replacement.rollback().unwrap();
        assert!(fs::read_to_string(&yt_dlp).unwrap().contains("yt-dlp-old"));
        fs::remove_dir_all(base).unwrap();
    }
}
