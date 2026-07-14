mod activation;
mod archive;
mod channel;
mod install;
mod local;
mod probe;

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    path::{Path, PathBuf},
};

pub use activation::{
    activate_revision, active_state_path, active_tool_paths, read_active_state, revision_root,
    revisions_root, ActiveToolchainState, REVISION_MANIFEST_FILE,
};
pub(crate) use channel::{
    parse_channel_record, select_revision_manifest_asset, sha256_bytes, verify_channel_manifest,
    GitHubRelease,
};
pub(crate) use install::build_tool_download_client;
pub use install::{
    install_target, promote_staged_toolchain, stage_target_revision, verify_staged_toolchain,
    InstallTargetRequest, NoopProgressReporter, ProgressReporter, PromotedToolchain,
    StageTargetRevisionRequest, StagedToolchain,
};
pub use local::{
    parse_local_toolchain_config, probe_local_toolchain, resolve_local_toolchain,
    LocalToolchainConfig, LocalToolchainResolution, ToolchainSource,
};
pub use probe::{probe_target, require_tools, verify_toolchain_combination};

pub const TOOLS_DIRECTORY: &str = "Tools";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ToolchainRevision {
    date: u32,
    sequence: u32,
}

impl ToolchainRevision {
    pub fn parse(value: &str) -> Result<Self, String> {
        let (date_text, sequence_text) = value
            .split_once('.')
            .ok_or_else(|| format!("Invalid toolchain revision: {value}"))?;
        validate_yyyymmdd(date_text)?;
        if sequence_text.is_empty()
            || sequence_text.starts_with('0')
            || !sequence_text.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(format!("Invalid toolchain revision sequence: {value}"));
        }
        let sequence = sequence_text
            .parse::<u32>()
            .map_err(|_| format!("Invalid toolchain revision sequence: {value}"))?;
        if sequence == 0 {
            return Err(format!("Invalid toolchain revision sequence: {value}"));
        }

        Ok(Self {
            date: date_text
                .parse()
                .map_err(|_| format!("Invalid toolchain revision date: {value}"))?,
            sequence,
        })
    }
}

impl fmt::Display for ToolchainRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:08}.{}", self.date, self.sequence)
    }
}

fn validate_yyyymmdd(value: &str) -> Result<(), String> {
    if value.len() != 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("Invalid toolchain revision date: {value}"));
    }

    let year = value[0..4]
        .parse::<u32>()
        .map_err(|_| format!("Invalid toolchain revision date: {value}"))?;
    let month = value[4..6]
        .parse::<u32>()
        .map_err(|_| format!("Invalid toolchain revision date: {value}"))?;
    let day = value[6..8]
        .parse::<u32>()
        .map_err(|_| format!("Invalid toolchain revision date: {value}"))?;
    if year == 0 || !(1..=12).contains(&month) {
        return Err(format!("Invalid toolchain revision date: {value}"));
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if day == 0 || day > days_in_month {
        return Err(format!("Invalid toolchain revision date: {value}"));
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolStatus {
    pub name: String,
    pub relative_path: String,
    pub full_path: String,
    pub availability: String,
    pub version: Option<String>,
    pub expected_version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolInstallProgress {
    pub percent: Option<f64>,
    pub status: String,
    pub tool: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolPaths {
    pub root: PathBuf,
    pub yt_dlp: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffmpeg_dir: PathBuf,
    pub ffprobe: PathBuf,
    pub deno: PathBuf,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ToolNames {
    pub yt_dlp: &'static str,
    pub ffmpeg: &'static str,
    pub ffprobe: &'static str,
    pub deno: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsManifest {
    pub schema_version: u32,
    pub revision: Option<String>,
    pub retrieved_at_utc: Option<String>,
    pub targets: Vec<ManifestTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTarget {
    pub target: String,
    pub tools: Vec<ManifestTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestTool {
    pub name: String,
    pub path: String,
    pub source_url: String,
    pub source_size: Option<u64>,
    pub source_sha256: Option<String>,
    #[serde(rename = "version")]
    pub version: Option<String>,
    pub sha256: String,
    pub kind: ManifestToolKind,
    pub archive_path_suffix: Option<String>,
    #[serde(rename = "licenseNotes")]
    pub license_notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManifestToolKind {
    File,
    Zip,
}

pub fn parse_manifest(json: &str) -> Result<ToolsManifest, String> {
    let manifest: ToolsManifest = serde_json::from_str(json).map_err(|error| error.to_string())?;
    if manifest.schema_version < 2 {
        return Err("tools-manifest.json schemaVersion must be 2 or newer".to_string());
    }
    if manifest.schema_version >= 4 {
        let mut sources = BTreeMap::<String, (u64, String, ManifestToolKind)>::new();
        for target in &manifest.targets {
            for tool in &target.tools {
                let size = tool.source_size.filter(|value| *value > 0).ok_or_else(|| {
                    format!(
                        "tools-manifest.json schemaVersion 4 requires sourceSize for {}/{}",
                        target.target, tool.name
                    )
                })?;
                let sha256 = tool
                    .source_sha256
                    .as_deref()
                    .filter(|value| {
                        value.len() == 64
                            && value
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                    .ok_or_else(|| {
                        format!(
                            "tools-manifest.json schemaVersion 4 requires sourceSha256 for {}/{}",
                            target.target, tool.name
                        )
                    })?;
                let identity = (size, sha256.to_string(), tool.kind);
                if let Some(existing) = sources.get(&tool.source_url) {
                    if existing != &identity {
                        return Err(format!(
                            "tools-manifest.json has inconsistent source integrity for {}",
                            tool.source_url
                        ));
                    }
                } else {
                    sources.insert(tool.source_url.clone(), identity);
                }
            }
        }
    }
    Ok(manifest)
}

pub fn manifest_target(manifest: &ToolsManifest, target: &str) -> Result<ManifestTarget, String> {
    manifest
        .targets
        .iter()
        .find(|item| item.target == target)
        .cloned()
        .ok_or_else(|| format!("No tool manifest target found for {target}"))
}

pub fn tool_target_from(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        _ => None,
    }
}

pub(crate) fn tool_names_for_target(target: &str) -> Option<ToolNames> {
    match target {
        "win-x64" => Some(ToolNames {
            yt_dlp: "yt-dlp.exe",
            ffmpeg: "ffmpeg.exe",
            ffprobe: "ffprobe.exe",
            deno: "deno.exe",
        }),
        _ => None,
    }
}

pub(crate) fn tool_paths_for_root(root: &Path, target: &str) -> Result<ToolPaths, String> {
    let names = tool_names_for_target(target)
        .ok_or_else(|| format!("Unsupported tool target: {target}"))?;
    Ok(ToolPaths {
        yt_dlp: root.join("yt-dlp").join(names.yt_dlp),
        ffmpeg: root.join("ffmpeg").join("bin").join(names.ffmpeg),
        ffmpeg_dir: root.join("ffmpeg").join("bin"),
        ffprobe: root.join("ffmpeg").join("bin").join(names.ffprobe),
        deno: root.join("deno").join(names.deno),
        root: root.to_path_buf(),
    })
}

pub fn relative_manifest_tool_path(tool: &ManifestTool) -> Result<PathBuf, String> {
    let normalized = tool.path.replace('\\', "/");
    let prefix = format!("{TOOLS_DIRECTORY}/");
    let relative = normalized
        .strip_prefix(&prefix)
        .and_then(|value| value.split_once('/').map(|(_, rest)| rest))
        .ok_or_else(|| format!("Invalid tool path in manifest: {}", tool.path))?;
    archive::safe_archive_member(relative)
        .map_err(|error| format!("Invalid tool path in manifest {}: {error}", tool.path))
}

fn tool_paths_from_manifest(root: &Path, target: &ManifestTarget) -> Result<ToolPaths, String> {
    let path_for = |name: &str| -> Result<PathBuf, String> {
        let tool = target
            .tools
            .iter()
            .find(|tool| tool.name == name)
            .ok_or_else(|| format!("Tool manifest target {} is missing {name}", target.target))?;
        Ok(root.join(relative_manifest_tool_path(tool)?))
    };
    let ffmpeg = path_for("ffmpeg")?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "FFmpeg manifest path has no parent directory".to_string())?
        .to_path_buf();

    Ok(ToolPaths {
        root: root.to_path_buf(),
        yt_dlp: path_for("yt-dlp")?,
        ffmpeg,
        ffmpeg_dir,
        ffprobe: path_for("ffprobe")?,
        deno: path_for("deno")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_orders_toolchain_revisions() {
        let older = ToolchainRevision::parse("20260711.2").unwrap();
        let newer = ToolchainRevision::parse("20260712.1").unwrap();

        assert!(older < newer);
        assert_eq!(newer.to_string(), "20260712.1");
        assert!(ToolchainRevision::parse("20260712.0").is_err());
        assert!(ToolchainRevision::parse("20260712.01").is_err());
        assert!(ToolchainRevision::parse("v20260712.1").is_err());
        assert!(ToolchainRevision::parse("20261301.1").is_err());
        assert!(ToolchainRevision::parse("20260229.1").is_err());
        assert!(ToolchainRevision::parse("20240229.1").is_ok());
        assert!(ToolchainRevision::parse("20260712.1.extra").is_err());
    }

    #[test]
    fn maps_supported_platform_arch_pairs_to_tool_targets() {
        assert_eq!(tool_target_from("windows", "x86_64"), Some("win-x64"));
        assert_eq!(tool_target_from("windows", "aarch64"), None);
        assert_eq!(tool_target_from("macos", "x86_64"), None);
        assert_eq!(tool_target_from("linux", "x86_64"), None);
    }

    #[test]
    fn uses_platform_specific_tool_names() {
        let windows = tool_names_for_target("win-x64").unwrap();
        assert_eq!(windows.yt_dlp, "yt-dlp.exe");
        assert_eq!(windows.ffmpeg, "ffmpeg.exe");
        assert_eq!(windows.ffprobe, "ffprobe.exe");
        assert_eq!(windows.deno, "deno.exe");

        assert!(tool_names_for_target("win-arm64").is_none());
        assert!(tool_names_for_target("macos-arm64").is_none());
        assert!(tool_names_for_target("linux-x64").is_none());
    }

    #[test]
    fn selects_tools_for_current_manifest_target() {
        let manifest = r#"{
          "schemaVersion": 2,
          "targets": [{
            "target": "win-x64",
            "tools": [{
              "name": "yt-dlp",
              "path": "Tools/win-x64/yt-dlp/yt-dlp.exe",
              "sourceUrl": "https://example.test/yt-dlp.exe",
              "sha256": "abc",
              "kind": "file"
            }]
          }, {"target": "win-arm64", "tools": []}]
        }"#;

        let manifest = parse_manifest(manifest).unwrap();
        let target = manifest_target(&manifest, "win-x64").unwrap();
        assert_eq!(target.target, "win-x64");
        assert_eq!(target.tools.len(), 1);
        assert_eq!(target.tools[0].name, "yt-dlp");
    }

    #[test]
    fn rejects_manifest_paths_that_escape_the_target_root() {
        let tool = ManifestTool {
            name: "yt-dlp".to_string(),
            path: "Tools/win-x64/../../yt-dlp.exe".to_string(),
            source_url: String::new(),
            source_size: None,
            source_sha256: None,
            version: None,
            sha256: String::new(),
            kind: ManifestToolKind::File,
            archive_path_suffix: None,
            license_notes: None,
        };

        assert!(relative_manifest_tool_path(&tool).is_err());
    }

    #[test]
    fn schema_four_requires_source_integrity() {
        let manifest = r#"{
          "schemaVersion": 4,
          "revision": "20260712.1",
          "targets": [{
            "target": "win-x64",
            "tools": [{
              "name": "yt-dlp",
              "path": "Tools/win-x64/yt-dlp/yt-dlp.exe",
              "sourceUrl": "https://example.test/yt-dlp.exe",
              "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "kind": "file"
            }]
          }]
        }"#;

        let error = parse_manifest(manifest).unwrap_err();
        assert!(error.contains("sourceSize") || error.contains("sourceSha256"));
    }

    #[test]
    fn schema_three_keeps_source_integrity_optional() {
        let manifest = r#"{
          "schemaVersion": 3,
          "revision": "20260711.2",
          "targets": [{"target": "win-x64", "tools": []}]
        }"#;

        assert!(parse_manifest(manifest).is_ok());
    }
}
