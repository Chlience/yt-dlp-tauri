use crate::{
    cookies::{self, CookieSelection, PreparedCookiesFile},
    parse_progress_line,
    process::Task,
    process_failure_message,
    proxy::ProxyConfig,
    toolchain::ToolPaths,
    yt_dlp_cookie_args, DownloadProgress, OUTPUT_PATH_PREFIX, PROGRESS_PREFIX,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct PlaylistOrigin {
    pub url: String,
    pub title: String,
    pub index: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct DownloadInput {
    pub url: String,
    pub title: String,
    pub video_id: Option<String>,
    pub thumbnail_url: Option<String>,
    pub format_selector: String,
    pub label: String,
    #[serde(default)]
    pub audio_only: bool,
    pub playlist: Option<PlaylistOrigin>,
}

#[derive(Clone)]
pub(crate) struct DownloadJob {
    pub input: DownloadInput,
    pub directory: PathBuf,
    pub filename: String,
    pub output_key: String,
    pub tools: ToolPaths,
    pub cookies: Option<CookieSelection>,
    pub proxy: ProxyConfig,
}

impl DownloadJob {
    pub fn new(
        input: DownloadInput,
        root: PathBuf,
        tools: ToolPaths,
        cookies: Option<CookieSelection>,
        proxy: ProxyConfig,
    ) -> Result<Self, String> {
        cookies::http_url(&input.url)?;
        if input.title.trim().is_empty() {
            return Err("A download request needs a title.".to_string());
        }
        let directory = match &input.playlist {
            Some(origin) => {
                cookies::http_url(&origin.url)?;
                if origin.index == 0 {
                    return Err("Playlist item numbers start at 1.".to_string());
                }
                root.join(safe_component(&origin.title))
            }
            None => root,
        };
        let filename = output_filename(
            &input.title,
            input.video_id.as_deref(),
            &input.url,
            input.playlist.as_ref().map(|origin| origin.index),
        );
        // Downloads targeting the same base filename are serialized, including format variants.
        let resolved_directory = resolved_destination(&directory);
        let output_key = resolved_directory
            .join(&filename)
            .to_string_lossy()
            .to_lowercase();
        Ok(Self {
            input,
            directory,
            filename,
            output_key,
            tools,
            cookies,
            proxy,
        })
    }

    fn command(&self, cookies_file: Option<&std::path::Path>) -> Command {
        let mut command = Command::new(&self.tools.yt_dlp);
        self.proxy.configure(&mut command);
        let selector = if self.input.format_selector.trim().is_empty() {
            "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b"
        } else {
            &self.input.format_selector
        };
        command
            .args([
                "--ignore-config",
                "--no-playlist",
                "--playlist-items",
                "1",
                "--no-overwrites",
                "--newline",
                "--paths",
            ])
            .arg(format!("home:{}", self.directory.display()))
            .args([
                "--output",
                &format!("{}.%(ext)s", self.filename.replace('%', "%%")),
                "--format",
                selector,
            ]);
        if self.input.audio_only {
            command.args(["--extract-audio", "--audio-format", "best"]);
        } else {
            command.args(["--merge-output-format", "mp4"]);
        }
        command.arg("--ffmpeg-location").arg(&self.tools.ffmpeg_dir)
            .arg("--js-runtimes").arg(format!("deno:{}", self.tools.deno.display()))
            .args(yt_dlp_cookie_args(cookies_file))
            .args(["--progress-template", &format!("{PROGRESS_PREFIX}%(progress.status)s|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s")])
            .args(["--print", &format!("after_move:{OUTPUT_PATH_PREFIX}%(filepath)s"), "--progress", "--"])
            .arg(&self.input.url);
        command
    }

    pub fn run(
        &self,
        task: &Task,
        report: &mut (dyn FnMut(DownloadProgress) + Send),
    ) -> Result<Option<String>, String> {
        if task.is_cancelled() {
            return Err(crate::process::CANCELLED.to_string());
        }
        let prepared = self
            .cookies
            .as_ref()
            .map(|selection| cookies::prepare(selection, &self.input.url))
            .transpose()?;
        fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let mut command = self.command(prepared.as_ref().map(PreparedCookiesFile::path));
        let mut saved_path = None;
        let output = task.run(&mut command, "Download request", None, |line| {
            if let Some(progress) = parse_progress_line(line) {
                report(progress);
            }
            if let Some(path) = line.strip_prefix(OUTPUT_PATH_PREFIX) {
                saved_path = Some(path.trim().to_string());
            }
        })?;
        if !output.status.success() {
            return Err(self.proxy.redact_error(process_failure_message(
                "Download failed.",
                output.status.code(),
                &output.stderr,
                &[],
            )));
        }
        Ok(saved_path)
    }
}

// Resolve the existing ancestor before appending missing directories. This keeps
// Windows verbatim paths and relative paths consistent before and after creation.
fn resolved_destination(path: &Path) -> PathBuf {
    let mut ancestor = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut remaining = Vec::new();
    let mut resolved = loop {
        if let Ok(resolved) = fs::canonicalize(&ancestor) {
            break resolved;
        }
        let component = ancestor
            .components()
            .next_back()
            .map(|part| part.as_os_str().to_owned());
        if !ancestor.pop() {
            break ancestor;
        }
        if let Some(component) = component {
            remaining.push(component);
        }
    };
    for component in remaining.into_iter().rev() {
        if component == ".." {
            resolved.pop();
        } else if component != "." {
            resolved.push(component);
        }
    }
    resolved
}

pub(crate) fn output_filename(
    title: &str,
    id: Option<&str>,
    url: &str,
    index: Option<u32>,
) -> String {
    let id = id
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            let safe = safe_component(id);
            if safe.len() <= 48 {
                safe
            } else {
                format!("{:x}", Sha256::digest(id.as_bytes()))[..12].to_string()
            }
        })
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(url.as_bytes()))[..12].to_string());
    let prefix = index
        .map(|index| format!("{index:02} - "))
        .unwrap_or_default();
    format!("{prefix}{} [{id}]", safe_component(title))
}

pub(crate) fn safe_component(value: &str) -> String {
    let mut result = String::new();
    for ch in value.trim().chars() {
        let ch = if ch.is_control() || "<>:\"/\\|?*".contains(ch) {
            '_'
        } else {
            ch
        };
        if result.len() + ch.len_utf8() > 150 {
            break;
        }
        result.push(ch);
    }
    let trimmed = result.trim_matches([' ', '.']);
    let stem = trimmed.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(index: Option<u32>) -> DownloadJob {
        DownloadJob::new(
            DownloadInput {
                url: "https://video.example/watch/3".into(),
                title: "Exposure 100%".into(),
                video_id: Some("video-3".into()),
                thumbnail_url: None,
                format_selector: "b[height<=1080]".into(),
                label: "1080p".into(),
                audio_only: false,
                playlist: index.map(|index| PlaylistOrigin {
                    url: "https://video.example/list".into(),
                    title: "Course/one".into(),
                    index,
                }),
            },
            PathBuf::from("/downloads"),
            ToolPaths {
                root: "/tools".into(),
                yt_dlp: "/tools/yt-dlp".into(),
                ffmpeg: "/tools/ffmpeg".into(),
                ffmpeg_dir: "/tools".into(),
                ffprobe: "/tools/ffprobe".into(),
                deno: "/tools/deno".into(),
            },
            None,
            ProxyConfig::default(),
        )
        .unwrap()
    }

    #[test]
    fn output_identity_is_stable_when_a_playlist_directory_is_created() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("yt-dlp-output-{}-{stamp}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let directory = root.join("Course");
        let before = resolved_destination(&directory);
        fs::create_dir(&directory).unwrap();
        assert_eq!(before, resolved_destination(&directory));
        assert_eq!(
            before,
            resolved_destination(&directory.join("..").join("Course"))
        );
        fs::remove_dir(&directory).unwrap();
        fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn selected_items_keep_original_numbers_and_safe_filenames() {
        for index in [3, 5, 7] {
            let job = job(Some(index));
            assert_eq!(job.directory, PathBuf::from("/downloads/Course_one"));
            assert!(job.filename.starts_with(&format!("{index:02} - ")));
            assert!(job.filename.ends_with("[video-3]"));
        }
        assert_eq!(safe_component("../../CON.txt"), "_.._CON.txt");
        assert_eq!(safe_component("CON.txt"), "_CON.txt");
        assert_eq!(safe_component(" . "), "Untitled");
        assert!(safe_component(&"摄影".repeat(100)).len() <= 150);
        let long = output_filename(
            &"摄影".repeat(100),
            Some(&"video".repeat(100)),
            "https://video.example/1",
            Some(u32::MAX),
        );
        assert!(long.len() < 240);
    }

    #[test]
    fn command_downloads_only_one_item_and_does_not_overwrite_files() {
        let command = job(Some(3)).command(None);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert!(args.contains(&"--no-playlist".into()));
        assert!(args.contains(&"--no-overwrites".into()));
        assert!(args.iter().any(|arg| arg.contains("100%%")));
        assert_eq!(args.last().unwrap(), "https://video.example/watch/3");
        assert_eq!(args[args.len() - 2], "--");
    }

    #[test]
    fn download_command_applies_the_captured_proxy_before_the_url_terminator() {
        let mut job = job(None);
        job.proxy = ProxyConfig {
            mode: crate::proxy::ProxyMode::Custom,
            url: Some("socks5h://localhost:1080".into()),
        }
        .validate()
        .unwrap();
        let command = job.command(None);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert_eq!(&args[..2], ["--proxy", "socks5h://localhost:1080"]);
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), &job.input.url);
    }

    #[test]
    fn audio_requests_extract_audio_even_when_only_muxed_formats_exist() {
        let mut job = job(None);
        job.input.audio_only = true;
        job.input.format_selector = "ba/b".into();
        let command = job.command(None);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert!(args.contains(&"--extract-audio".into()));
        assert!(!args.contains(&"--merge-output-format".into()));
    }
}
