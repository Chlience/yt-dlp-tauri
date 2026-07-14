use super::{
    probe::probe_executable, tool_names_for_target, verify_toolchain_combination, ToolPaths,
    ToolStatus,
};
use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
};

const LOCAL_TOOLCHAIN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolchainSource {
    #[default]
    Managed,
    Local,
}

impl ToolchainSource {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim() {
            "managed" => Ok(Self::Managed),
            "local" => Ok(Self::Local),
            value => Err(format!("Unsupported toolchain source: {value}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Local => "local",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalToolchainConfig {
    schema_version: u32,
    pub yt_dlp_path: Option<PathBuf>,
    pub ffmpeg_directory: Option<PathBuf>,
    pub deno_path: Option<PathBuf>,
}

impl Default for LocalToolchainConfig {
    fn default() -> Self {
        Self {
            schema_version: LOCAL_TOOLCHAIN_SCHEMA_VERSION,
            yt_dlp_path: None,
            ffmpeg_directory: None,
            deno_path: None,
        }
    }
}

impl LocalToolchainConfig {
    pub fn from_paths(
        yt_dlp_path: Option<PathBuf>,
        ffmpeg_directory: Option<PathBuf>,
        deno_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        let config = Self {
            schema_version: LOCAL_TOOLCHAIN_SCHEMA_VERSION,
            yt_dlp_path,
            ffmpeg_directory,
            deno_path,
        };
        validate_local_toolchain_config(&config)?;
        Ok(config)
    }
}

pub fn parse_local_toolchain_config(json: &str) -> Result<LocalToolchainConfig, String> {
    let config: LocalToolchainConfig = serde_json::from_str(json)
        .map_err(|error| format!("Invalid local toolchain configuration: {error}"))?;
    validate_local_toolchain_config(&config)?;
    Ok(config)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalToolchainResolution {
    pub yt_dlp: Option<PathBuf>,
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
    pub deno: Option<PathBuf>,
}

impl LocalToolchainResolution {
    pub fn ffmpeg_directory(&self) -> Option<&Path> {
        self.ffmpeg.as_deref().and_then(Path::parent)
    }

    pub fn complete_paths(&self) -> Result<ToolPaths, String> {
        let missing = [
            ("yt-dlp", self.yt_dlp.is_none()),
            ("ffmpeg", self.ffmpeg.is_none()),
            ("ffprobe", self.ffprobe.is_none()),
            ("deno", self.deno.is_none()),
        ]
        .into_iter()
        .filter_map(|(name, is_missing)| is_missing.then_some(name))
        .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(format!(
                "Local toolchain is incomplete: missing {}",
                missing.join(", ")
            ));
        }

        let ffmpeg = self.ffmpeg.clone().expect("checked above");
        let ffmpeg_dir = ffmpeg
            .parent()
            .ok_or_else(|| "Local FFmpeg path has no parent directory".to_string())?
            .to_path_buf();
        Ok(ToolPaths {
            root: ffmpeg_dir.clone(),
            yt_dlp: self.yt_dlp.clone().expect("checked above"),
            ffmpeg,
            ffmpeg_dir,
            ffprobe: self.ffprobe.clone().expect("checked above"),
            deno: self.deno.clone().expect("checked above"),
        })
    }
}

pub fn resolve_local_toolchain(
    config: &LocalToolchainConfig,
    target: &str,
) -> Result<LocalToolchainResolution, String> {
    let path_directories = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    resolve_local_toolchain_with(config, target, &path_directories, Path::is_file)
}

pub fn probe_local_toolchain(resolution: &LocalToolchainResolution) -> Vec<ToolStatus> {
    let mut statuses = vec![
        probe_candidate("yt-dlp", resolution.yt_dlp.as_deref()),
        probe_candidate("ffmpeg", resolution.ffmpeg.as_deref()),
        probe_candidate("ffprobe", resolution.ffprobe.as_deref()),
        probe_candidate("deno", resolution.deno.as_deref()),
    ];

    if statuses
        .iter()
        .all(|status| status.availability == "available")
    {
        if let Err(error) = resolution
            .complete_paths()
            .and_then(|paths| verify_toolchain_combination(&paths))
        {
            if let Some(status) = statuses.first_mut() {
                status.availability = "cannot_execute".to_string();
                status.error = Some(format!(
                    "Local toolchain compatibility check failed: {error}"
                ));
            }
        }
    }
    statuses
}

fn validate_local_toolchain_config(config: &LocalToolchainConfig) -> Result<(), String> {
    if config.schema_version != LOCAL_TOOLCHAIN_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported local toolchain configuration schema: {}",
            config.schema_version
        ));
    }
    for (label, path) in [
        ("yt-dlp", config.yt_dlp_path.as_deref()),
        ("FFmpeg directory", config.ffmpeg_directory.as_deref()),
        ("Deno", config.deno_path.as_deref()),
    ] {
        if path.is_some_and(|path| !path.is_absolute()) {
            return Err(format!("Local {label} path must be absolute"));
        }
    }
    Ok(())
}

fn resolve_local_toolchain_with<F>(
    config: &LocalToolchainConfig,
    target: &str,
    path_directories: &[PathBuf],
    is_file: F,
) -> Result<LocalToolchainResolution, String>
where
    F: Fn(&Path) -> bool,
{
    validate_local_toolchain_config(config)?;
    let names = tool_names_for_target(target)
        .ok_or_else(|| format!("Unsupported tool target: {target}"))?;
    let yt_dlp = config
        .yt_dlp_path
        .clone()
        .or_else(|| find_executable(path_directories, names.yt_dlp, &is_file));
    let deno = config
        .deno_path
        .clone()
        .or_else(|| find_executable(path_directories, names.deno, &is_file));

    let ffmpeg_directory = config.ffmpeg_directory.clone().or_else(|| {
        path_directories.iter().find_map(|directory| {
            if !directory.is_absolute() {
                return None;
            }
            let ffmpeg = directory.join(names.ffmpeg);
            let ffprobe = directory.join(names.ffprobe);
            (is_file(&ffmpeg) && is_file(&ffprobe)).then(|| directory.clone())
        })
    });
    let (ffmpeg, ffprobe) = ffmpeg_directory
        .map(|directory| {
            (
                Some(directory.join(names.ffmpeg)),
                Some(directory.join(names.ffprobe)),
            )
        })
        .unwrap_or((None, None));

    Ok(LocalToolchainResolution {
        yt_dlp,
        ffmpeg,
        ffprobe,
        deno,
    })
}

fn find_executable<F>(directories: &[PathBuf], name: &str, is_file: &F) -> Option<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    directories.iter().find_map(|directory| {
        if !directory.is_absolute() {
            return None;
        }
        let candidate = directory.join(name);
        is_file(&candidate).then_some(candidate)
    })
}

fn probe_candidate(name: &str, path: Option<&Path>) -> ToolStatus {
    match path {
        Some(path) => probe_executable(name, path),
        None => ToolStatus {
            name: name.to_string(),
            relative_path: format!("PATH:{name}"),
            full_path: String::new(),
            availability: "missing".to_string(),
            version: None,
            expected_version: None,
            error: Some("Not Found".to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn absolute_path(components: &[&str]) -> PathBuf {
        #[cfg(windows)]
        let root = PathBuf::from(r"C:\");
        #[cfg(not(windows))]
        let root = PathBuf::from("/");

        components
            .iter()
            .fold(root, |path, component| path.join(component))
    }

    #[test]
    fn toolchain_source_accepts_only_managed_and_local() {
        assert_eq!(
            ToolchainSource::parse("managed"),
            Ok(ToolchainSource::Managed)
        );
        assert_eq!(ToolchainSource::parse("local"), Ok(ToolchainSource::Local));
        assert!(ToolchainSource::parse("system").is_err());
    }

    #[test]
    fn local_toolchain_config_requires_absolute_paths() {
        let result = LocalToolchainConfig::from_paths(
            Some(PathBuf::from("yt-dlp.exe")),
            Some(absolute_path(&["tools", "ffmpeg", "bin"])),
            Some(absolute_path(&["tools", "deno.exe"])),
        );

        assert!(result.is_err());
    }

    #[test]
    fn configured_local_paths_define_one_complete_toolchain() {
        let yt_dlp = absolute_path(&["tools", "yt-dlp.exe"]);
        let ffmpeg_directory = absolute_path(&["tools", "ffmpeg", "bin"]);
        let deno = absolute_path(&["tools", "deno.exe"]);
        let config = LocalToolchainConfig::from_paths(
            Some(yt_dlp.clone()),
            Some(ffmpeg_directory.clone()),
            Some(deno.clone()),
        )
        .expect("absolute paths should be accepted");

        let resolution =
            resolve_local_toolchain_with(&config, "win-x64", &[], |path| path.is_absolute())
                .expect("configured paths should resolve");

        assert_eq!(resolution.yt_dlp, Some(yt_dlp));
        assert_eq!(resolution.ffmpeg, Some(ffmpeg_directory.join("ffmpeg.exe")));
        assert_eq!(
            resolution.ffprobe,
            Some(ffmpeg_directory.join("ffprobe.exe"))
        );
        assert_eq!(resolution.deno, Some(deno));
    }

    #[test]
    fn path_detection_requires_ffmpeg_and_ffprobe_in_one_directory() {
        let media_directory = absolute_path(&["path", "media"]);
        let runtime_directory = absolute_path(&["path", "runtime"]);
        let available = [
            media_directory.join("ffmpeg.exe"),
            media_directory.join("ffprobe.exe"),
            runtime_directory.join("yt-dlp.exe"),
            runtime_directory.join("deno.exe"),
        ];
        let path_directories = vec![media_directory.clone(), runtime_directory];
        let resolution = resolve_local_toolchain_with(
            &LocalToolchainConfig::default(),
            "win-x64",
            &path_directories,
            |path| available.iter().any(|candidate| candidate == path),
        )
        .expect("PATH tools should resolve");

        assert_eq!(
            resolution.ffmpeg_directory(),
            Some(media_directory.as_path())
        );
        assert!(resolution.complete_paths().is_ok());
    }

    #[test]
    fn path_detection_rejects_a_split_ffmpeg_pair() {
        let ffmpeg_directory = absolute_path(&["path", "ffmpeg"]);
        let ffprobe_directory = absolute_path(&["path", "ffprobe"]);
        let available = [
            ffmpeg_directory.join("ffmpeg.exe"),
            ffprobe_directory.join("ffprobe.exe"),
        ];
        let resolution = resolve_local_toolchain_with(
            &LocalToolchainConfig::default(),
            "win-x64",
            &[ffmpeg_directory, ffprobe_directory],
            |path| available.iter().any(|candidate| candidate == path),
        )
        .expect("split PATH tools should produce an incomplete resolution");

        assert_eq!(resolution.ffmpeg, None);
        assert_eq!(resolution.ffprobe, None);
    }

    #[test]
    fn configured_paths_take_precedence_over_path_detection() {
        let configured_yt_dlp = absolute_path(&["configured", "yt-dlp.exe"]);
        let path_directory = absolute_path(&["path"]);
        let path_yt_dlp = path_directory.join("yt-dlp.exe");
        let config = LocalToolchainConfig::from_paths(Some(configured_yt_dlp.clone()), None, None)
            .expect("configured path should be valid");
        let resolution =
            resolve_local_toolchain_with(&config, "win-x64", &[path_directory], |path| {
                path == path_yt_dlp
            })
            .expect("configured path should resolve");

        assert_eq!(resolution.yt_dlp, Some(configured_yt_dlp));
    }

    #[test]
    fn local_toolchain_config_json_is_strict_and_round_trips() {
        let config = LocalToolchainConfig::from_paths(
            Some(absolute_path(&["tools", "yt-dlp.exe"])),
            Some(absolute_path(&["tools", "ffmpeg", "bin"])),
            Some(absolute_path(&["tools", "deno.exe"])),
        )
        .expect("absolute paths should be accepted");
        let json = serde_json::to_string(&config).expect("config should serialize");

        assert_eq!(
            parse_local_toolchain_config(&json).expect("config should parse"),
            config
        );
        assert!(parse_local_toolchain_config(
            r#"{"schemaVersion":1,"ytDlpPath":null,"ffmpegDirectory":null,"denoPath":null,"extra":true}"#,
        )
        .is_err());
        assert!(parse_local_toolchain_config(
            r#"{"schemaVersion":2,"ytDlpPath":null,"ffmpegDirectory":null,"denoPath":null}"#,
        )
        .is_err());
    }

    #[test]
    fn incomplete_path_detection_reports_every_missing_tool() {
        let resolution =
            resolve_local_toolchain_with(&LocalToolchainConfig::default(), "win-x64", &[], |_| {
                false
            })
            .expect("empty PATH should still produce a resolution");

        assert_eq!(
            resolution
                .complete_paths()
                .expect_err("incomplete paths should fail"),
            "Local toolchain is incomplete: missing yt-dlp, ffmpeg, ffprobe, deno"
        );
    }

    #[test]
    fn missing_local_tools_use_a_concise_status() {
        let statuses = probe_local_toolchain(&LocalToolchainResolution {
            yt_dlp: None,
            ffmpeg: None,
            ffprobe: None,
            deno: None,
        });

        assert_eq!(statuses.len(), 4);
        assert!(statuses.iter().all(|status| {
            status.availability == "missing" && status.error.as_deref() == Some("Not Found")
        }));
    }
}
