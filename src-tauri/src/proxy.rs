use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

const CONFIG_FILE: &str = "proxy.json";
static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyMode {
    #[default]
    System,
    Direct,
    Custom,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProxyConfig {
    pub mode: ProxyMode,
    pub url: Option<String>,
}

impl ProxyConfig {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.mode != ProxyMode::Custom {
            self.url = None;
            return Ok(self);
        }
        let value = self.url.as_deref().unwrap_or("").trim();
        if value.chars().any(char::is_control) {
            return Err("Proxy address must not contain control characters.".into());
        }
        let url = reqwest::Url::parse(value).map_err(|_| {
            "Enter a complete proxy address, such as http://127.0.0.1:7890.".to_string()
        })?;
        if !matches!(
            url.scheme(),
            "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
        ) {
            return Err("Use an HTTP, HTTPS, SOCKS4 or SOCKS5 proxy address.".into());
        }
        if url.host_str().is_none()
            || url.port() == Some(0)
            || !matches!(url.path(), "" | "/")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "A proxy address needs a host and valid port, without a path, query or fragment."
                    .into(),
            );
        }
        if url.scheme().starts_with("socks") && url.port().is_none() {
            return Err("Include the port in a SOCKS proxy address.".into());
        }
        self.url = Some(url.to_string());
        Ok(self)
    }

    pub fn configure(&self, command: &mut Command) {
        match self.mode {
            ProxyMode::System => {}
            ProxyMode::Direct => {
                command.args(["--proxy", ""]);
            }
            ProxyMode::Custom => {
                command.arg("--proxy").arg(
                    self.url
                        .as_deref()
                        .expect("custom proxies are validated before use"),
                );
            }
        }
    }

    pub fn summary(&self) -> Self {
        let mut summary = self.clone();
        if let Some(url) = &self.url {
            if let Ok(mut parsed) = reqwest::Url::parse(url) {
                let _ = parsed.set_username("");
                let _ = parsed.set_password(None);
                summary.url = Some(parsed.to_string());
            }
        }
        summary
    }

    pub fn redact_error(&self, message: String) -> String {
        let Some(url) = &self.url else {
            return message;
        };
        let Some((authority, _)) = url.rsplit_once('@') else {
            return message;
        };
        let Some((_, credentials)) = authority.split_once("://") else {
            return message;
        };
        message.replace(&format!("{credentials}@"), "")
    }
}

pub(crate) fn read(directory: &Path) -> Result<ProxyConfig, String> {
    match fs::read(directory.join(CONFIG_FILE)) {
        Ok(bytes) => serde_json::from_slice::<ProxyConfig>(&bytes)
            .map_err(|_| "Saved proxy configuration is invalid.".to_string())?
            .validate(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProxyConfig::default()),
        Err(error) => Err(format!("Could not read proxy settings: {error}")),
    }
}

pub(crate) fn save(directory: &Path, config: ProxyConfig) -> Result<ProxyConfig, String> {
    let config = config.validate()?;
    let bytes = serde_json::to_vec(&config).map_err(|error| error.to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(
        ".proxy-{}-{}.tmp",
        std::process::id(),
        NEXT_WRITE.fetch_add(1, Ordering::Relaxed),
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temporary, directory.join(CONFIG_FILE)));
    if let Err(error) = result {
        let _ = fs::remove_file(temporary);
        return Err(format!("Could not save proxy settings: {error}"));
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(url: &str) -> ProxyConfig {
        ProxyConfig {
            mode: ProxyMode::Custom,
            url: Some(url.into()),
        }
    }

    #[test]
    fn proxy_modes_preserve_default_detection_and_allow_explicit_direct_connections() {
        let mut command = Command::new("yt-dlp");
        ProxyConfig::default().configure(&mut command);
        assert_eq!(command.get_args().count(), 0);
        ProxyConfig {
            mode: ProxyMode::Direct,
            url: None,
        }
        .configure(&mut command);
        assert_eq!(command.get_args().collect::<Vec<_>>(), ["--proxy", ""]);
        let mut command = Command::new("yt-dlp");
        custom("socks5h://127.0.0.1:1080")
            .validate()
            .unwrap()
            .configure(&mut command);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["--proxy", "socks5h://127.0.0.1:1080"]
        );
    }

    #[test]
    fn custom_proxy_validation_rejects_incomplete_or_unrelated_urls() {
        for url in [
            "",
            "127.0.0.1:7890",
            "file:///tmp/proxy",
            "ftp://proxy:21",
            "http://proxy:0",
            "http://proxy:7890/path",
            "http://proxy:7890?token=secret",
            "http://proxy:7890#fragment",
            "socks5://proxy",
            "http://proxy:\n7890",
        ] {
            assert!(custom(url).validate().is_err(), "accepted {url}");
        }
        for url in [
            " http://127.0.0.1:7890 ",
            "https://proxy.example",
            "http://[::1]:7890",
            "socks4a://proxy:1080",
            "socks5://user:pass@proxy:1080/",
        ] {
            assert!(custom(url).validate().is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn queue_summaries_and_proxy_failures_do_not_expose_url_credentials() {
        let config = custom("http://user:private%40password@proxy.example:7890/")
            .validate()
            .unwrap();
        assert_eq!(
            config.summary().url.as_deref(),
            Some("http://proxy.example:7890/")
        );
        assert_eq!(
            config.redact_error(
                "Could not connect to http://user:private%40password@proxy.example:7890".into()
            ),
            "Could not connect to http://proxy.example:7890"
        );
    }

    #[test]
    fn saved_settings_round_trip_and_invalid_updates_preserve_the_previous_value() {
        let directory = std::env::temp_dir().join(format!(
            "yt-dlp-proxy-test-{}-{}",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        assert_eq!(read(&directory).unwrap(), ProxyConfig::default());
        let original = save(&directory, custom("http://127.0.0.1:7890")).unwrap();
        assert_eq!(read(&directory).unwrap(), original);
        assert!(save(&directory, custom("invalid")).is_err());
        assert_eq!(read(&directory).unwrap(), original);
        let direct = save(
            &directory,
            ProxyConfig {
                mode: ProxyMode::Direct,
                url: original.url,
            },
        )
        .unwrap();
        assert_eq!(direct.url, None);
        assert_eq!(read(&directory).unwrap(), direct);
        fs::remove_file(directory.join(CONFIG_FILE)).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
