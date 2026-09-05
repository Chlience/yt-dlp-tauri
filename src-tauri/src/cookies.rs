use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const COOKIE_HEADER_EXPIRY: &str = "2147483647";
const SELECTION_FILE: &str = "cookies-file.json";

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CookieSelection {
    pub path: PathBuf,
    pub origin: Option<String>,
}

pub(crate) fn http_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| "Enter a valid http or https video URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Enter a valid http or https video URL.".to_string());
    }
    Ok(url)
}

pub(crate) fn select(path: PathBuf, url: &str) -> Result<CookieSelection, String> {
    let content = read_content(&path)?;
    let origin = if is_netscape_cookie_content(&content) {
        None
    } else {
        let parsed = http_url(url).map_err(|_| {
            "Paste the video's URL before selecting a one-line Cookie file.".to_string()
        })?;
        cookie_header_to_netscape_content(&parsed, &content)?;
        Some(parsed.origin().ascii_serialization())
    };
    Ok(CookieSelection { path, origin })
}

pub(crate) fn read_selection(state_dir: &Path) -> Result<Option<CookieSelection>, String> {
    match fs::read_to_string(state_dir.join(SELECTION_FILE)) {
        Ok(json) => {
            return serde_json::from_str(&json)
                .map_err(|error| format!("Invalid Cookie selection: {error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // Existing Netscape selections keep working. Legacy headers must be explicitly bound again.
    match fs::read_to_string(state_dir.join("cookies-file.txt")) {
        Ok(path) if !path.trim().is_empty() => Ok(Some(CookieSelection {
            path: PathBuf::from(path.trim()),
            origin: None,
        })),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn save_selection(
    state_dir: &Path,
    selection: Option<&CookieSelection>,
) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    let json = serde_json::to_vec(&selection).map_err(|error| error.to_string())?;
    fs::write(state_dir.join(SELECTION_FILE), json).map_err(|error| error.to_string())
}

pub(crate) struct PreparedCookiesFile {
    path: PathBuf,
    temporary: bool,
}

impl PreparedCookiesFile {
    pub fn path(&self) -> &Path {
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

pub(crate) fn prepare(
    selection: &CookieSelection,
    url: &str,
) -> Result<PreparedCookiesFile, String> {
    let content = read_content(&selection.path)?;
    if is_netscape_cookie_content(&content) {
        return Ok(PreparedCookiesFile {
            path: selection.path.clone(),
            temporary: false,
        });
    }
    let parsed = http_url(url)?;
    let origin = parsed.origin().ascii_serialization();
    if selection.origin.as_deref() != Some(origin.as_str()) {
        return Err("This one-line Cookie file is not bound to this site. Select it again for the current video's URL, or clear it.".to_string());
    }
    let converted = cookie_header_to_netscape_content(&parsed, &content)?;
    let path = temp_cookies_file_path();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Failed to create temporary Cookie file: {error}"))?;
    let prepared = PreparedCookiesFile {
        path,
        temporary: true,
    };
    file.write_all(converted.as_bytes())
        .map_err(|error| format!("Failed to write temporary Cookie file: {error}"))?;
    Ok(prepared)
}

fn read_content(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("Cookie file cannot be read at {}: {error}", path.display()))
}

fn is_netscape_cookie_content(content: &str) -> bool {
    content.lines().any(|line| {
        let line = line.trim();
        line.starts_with("# Netscape HTTP Cookie File")
            || line.starts_with("# HTTP Cookie File")
            || (!line.is_empty() && !line.starts_with('#') && line.split('\t').count() == 7)
    })
}

fn cookie_header_to_netscape_content(url: &reqwest::Url, content: &str) -> Result<String, String> {
    let domain = url
        .host_str()
        .ok_or_else(|| "Cookie URL has no host".to_string())?;
    let secure = if url.scheme() == "https" {
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
            "{domain}\tFALSE\t/\t{secure}\t{COOKIE_HEADER_EXPIRY}\t{name}\t{value}"
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
            return Err("Cookie header entry is missing `=`".to_string());
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = temp_cookies_file_path().with_extension("fixture");
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, content: &str) -> PathBuf {
            let path = self.0.join("cookies.txt");
            fs::write(&path, content).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn header_selection_binds_the_exact_origin_and_cleans_temporary_credentials() {
        let fixture = Fixture::new();
        let source = fixture.file("Cookie: session=TEST_ONLY; preference=a=b");
        let selection = select(source.clone(), "https://Video.Example.co.uk:443/watch").unwrap();
        assert_eq!(
            selection.origin.as_deref(),
            Some("https://video.example.co.uk")
        );
        let prepared = prepare(&selection, "https://video.example.co.uk/another-video").unwrap();
        let temporary = prepared.path().to_path_buf();
        let content = fs::read_to_string(&temporary).unwrap();
        assert!(
            content.contains("video.example.co.uk\tFALSE\t/\tTRUE\t2147483647\tsession\tTEST_ONLY")
        );
        assert!(content.contains("\tpreference\ta=b"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&temporary).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(prepared);
        assert!(!temporary.exists());
        assert!(source.is_file());
    }

    #[test]
    fn bound_headers_reject_other_hosts_schemes_and_ports() {
        let fixture = Fixture::new();
        let selection = select(
            fixture.file("session=TEST_ONLY"),
            "https://video.example/watch",
        )
        .unwrap();
        for url in [
            "https://other.example/watch",
            "https://sub.video.example/watch",
            "http://video.example/watch",
            "https://video.example:8443/watch",
        ] {
            assert!(prepare(&selection, url).is_err(), "accepted {url}");
        }
        assert!(select(selection.path, "").is_err());
        assert!(http_url("https://").is_err());
        assert!(http_url("file:///video").is_err());
    }

    #[test]
    fn legacy_headers_require_selection_again_and_clearing_overrides_legacy_state() {
        let fixture = Fixture::new();
        let source = fixture.file("session=TEST_ONLY");
        fs::write(fixture.0.join("cookies-file.txt"), source.to_str().unwrap()).unwrap();
        let legacy = read_selection(&fixture.0).unwrap().unwrap();
        assert!(prepare(&legacy, "https://video.example/watch").is_err());
        let selected = select(source.clone(), "https://video.example/watch").unwrap();
        save_selection(&fixture.0, Some(&selected)).unwrap();
        let restored = read_selection(&fixture.0).unwrap().unwrap();
        assert_eq!(restored.path, source);
        assert_eq!(restored.origin, selected.origin);
        save_selection(&fixture.0, None).unwrap();
        assert!(read_selection(&fixture.0).unwrap().is_none());
        assert!(fixture.0.join("cookies-file.txt").is_file());
    }

    #[test]
    fn netscape_files_keep_their_own_domains_and_are_never_removed() {
        let fixture = Fixture::new();
        let source = fixture.file(
            "# Netscape HTTP Cookie File\n.example.test\tTRUE\t/\tFALSE\t0\tsession\tTEST_ONLY\n",
        );
        let selection = select(source.clone(), "").unwrap();
        assert!(selection.origin.is_none());
        let prepared = prepare(&selection, "https://elsewhere.example/watch").unwrap();
        assert_eq!(prepared.path(), source);
        drop(prepared);
        assert!(source.is_file());
        fs::write(&source, "session=CHANGED_TO_HEADER").unwrap();
        assert!(prepare(&selection, "https://elsewhere.example/watch").is_err());
    }

    #[test]
    fn malformed_header_or_selection_is_not_silently_rebound() {
        let fixture = Fixture::new();
        let path = fixture.file("session=TEST_ONLY; invalid-entry");
        assert!(select(path, "https://video.example/watch").is_err());
        fs::write(fixture.0.join(SELECTION_FILE), "{broken").unwrap();
        assert!(read_selection(&fixture.0).is_err());
    }
}
