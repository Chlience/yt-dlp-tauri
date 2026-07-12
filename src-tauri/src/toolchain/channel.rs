use super::{parse_manifest, ToolchainRevision, ToolsManifest};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const ARCHIVE_REPOSITORY: &str = "Chlience/yt-dlp-tauri-toolchain";
const CHANNEL_MARKER_OPEN: &str = "<!-- toolchain-channel";
const CHANNEL_MARKER_CLOSE: &str = "-->";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelRecord {
    pub repository: String,
    pub revision: String,
    pub release_tag: String,
    pub manifest: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelRecordWire {
    schema_version: u32,
    repository: String,
    revision: String,
    release_tag: String,
    manifest: String,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GitHubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub immutable: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub digest: Option<String>,
    pub browser_download_url: String,
}

pub fn parse_channel_record(body: &str) -> Result<ChannelRecord, String> {
    let starts = body
        .match_indices(CHANNEL_MARKER_OPEN)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let start = match starts.as_slice() {
        [] => return Err("Toolchain channel record is missing".to_string()),
        [start] => *start,
        _ => return Err("Multiple toolchain channel records found".to_string()),
    };
    let close_offset = body[start + CHANNEL_MARKER_OPEN.len()..]
        .find(CHANNEL_MARKER_CLOSE)
        .ok_or_else(|| "Toolchain channel record is not terminated".to_string())?;
    let end = start + CHANNEL_MARKER_OPEN.len() + close_offset + CHANNEL_MARKER_CLOSE.len();
    let marker = body[start..end].replace("\r\n", "\n");
    let lines = marker.split('\n').collect::<Vec<_>>();
    if lines.len() != 3
        || lines[0]
            .strip_prefix(CHANNEL_MARKER_OPEN)
            .is_none_or(|suffix| !suffix.bytes().all(|byte| matches!(byte, b' ' | b'\t')))
        || lines[1].is_empty()
        || lines[2] != CHANNEL_MARKER_CLOSE
    {
        return Err("Toolchain channel record has invalid marker formatting".to_string());
    }

    let wire: ChannelRecordWire = serde_json::from_str(lines[1])
        .map_err(|error| format!("Toolchain channel record contains invalid JSON: {error}"))?;
    if wire.schema_version != 2 {
        return Err(format!(
            "Unsupported toolchain channel schema: {}",
            wire.schema_version
        ));
    }
    if wire.repository != ARCHIVE_REPOSITORY {
        return Err(format!(
            "Toolchain channel repository must be {ARCHIVE_REPOSITORY}"
        ));
    }
    let revision = ToolchainRevision::parse(&wire.revision)?;
    if wire.release_tag != format!("toolchain-{revision}") {
        return Err(format!(
            "Toolchain channel release tag must match revision {revision}"
        ));
    }
    if wire.manifest != format!("tools-manifest-{revision}.json") {
        return Err(format!(
            "Toolchain channel manifest must match revision {revision}"
        ));
    }
    validate_sha256(&wire.sha256, "Toolchain channel digest")?;

    Ok(ChannelRecord {
        repository: wire.repository,
        revision: revision.to_string(),
        release_tag: wire.release_tag,
        manifest: wire.manifest,
        sha256: wire.sha256,
    })
}

pub fn select_revision_manifest_asset(
    release: &GitHubRelease,
    record: &ChannelRecord,
) -> Result<ReleaseAsset, String> {
    if release.tag_name != record.release_tag
        || release.draft
        || release.prerelease
        || !release.immutable
    {
        return Err(format!(
            "Toolchain revision {} must be a published immutable release",
            record.revision
        ));
    }
    let matches = release
        .assets
        .iter()
        .filter(|asset| asset.name == record.manifest)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(format!(
            "Expected exactly one release asset named {}, found {}",
            record.manifest,
            matches.len()
        ));
    }
    let asset = matches[0];
    if asset.id == 0 || asset.size == 0 {
        return Err(format!(
            "{} must have a positive asset ID and byte size",
            record.manifest
        ));
    }
    let url = reqwest::Url::parse(&asset.browser_download_url)
        .map_err(|error| format!("{} has an invalid download URL: {error}", record.manifest))?;
    let expected_path = format!(
        "/{}/releases/download/{}/{}",
        record.repository, record.release_tag, record.manifest
    );
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != expected_path
    {
        return Err(format!(
            "{} URL must match the archive revision release",
            record.manifest
        ));
    }
    if let Some(digest) = asset.digest.as_deref() {
        if digest != format!("sha256:{}", record.sha256) {
            return Err(format!(
                "{} GitHub asset digest does not match the channel",
                record.manifest
            ));
        }
    }

    Ok(asset.clone())
}

pub fn verify_channel_manifest(
    record: &ChannelRecord,
    bytes: &[u8],
) -> Result<ToolsManifest, String> {
    let actual_sha256 = sha256_bytes(bytes);
    if actual_sha256 != record.sha256 {
        return Err(format!(
            "{} SHA-256 mismatch: expected {}, received {actual_sha256}",
            record.manifest, record.sha256
        ));
    }
    let json = std::str::from_utf8(bytes)
        .map_err(|error| format!("{} is not valid UTF-8: {error}", record.manifest))?;
    let manifest = parse_manifest(json)?;
    if manifest.schema_version != 4 {
        return Err(format!(
            "{} must use tools manifest schemaVersion 4",
            record.manifest
        ));
    }
    if manifest.revision.as_deref() != Some(record.revision.as_str()) {
        return Err(format!(
            "{} revision does not match channel revision {}",
            record.manifest, record.revision
        ));
    }
    let channel_revision = ToolchainRevision::parse(&record.revision)?;
    let expected_prefix = format!("/{}/releases/download/", record.repository);
    for target in &manifest.targets {
        for tool in &target.tools {
            let url = reqwest::Url::parse(&tool.source_url).map_err(|error| {
                format!(
                    "Invalid archive URL for {}/{}: {error}",
                    target.target, tool.name
                )
            })?;
            let source_path = url.path().strip_prefix(&expected_prefix).unwrap_or("");
            let (release_tag, asset_name) = source_path.split_once('/').unwrap_or(("", ""));
            let source_revision = release_tag
                .strip_prefix("toolchain-")
                .and_then(|value| ToolchainRevision::parse(value).ok());
            if url.scheme() != "https"
                || url.host_str() != Some("github.com")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || source_revision.is_none_or(|revision| revision > channel_revision)
                || asset_name.is_empty()
                || asset_name.contains('/')
            {
                return Err(format!(
                    "Archive URL for {}/{} must use a toolchain revision no newer than {}",
                    target.target, tool.name, record.revision
                ));
            }
        }
    }

    Ok(manifest)
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(format!("{label} must be a lowercase 64-character SHA-256"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn channel_body(repository: &str, release_tag: &str) -> String {
        format!(
            "<!-- toolchain-channel\n{{\"schemaVersion\":2,\"repository\":\"{repository}\",\"revision\":\"20260712.1\",\"releaseTag\":\"{release_tag}\",\"manifest\":\"tools-manifest-20260712.1.json\",\"sha256\":\"{DIGEST}\"}}\n-->"
        )
    }

    #[test]
    fn parses_one_schema_two_channel_record() {
        let body = channel_body("Chlience/yt-dlp-tauri-toolchain", "toolchain-20260712.1");

        let record = parse_channel_record(&body).unwrap();

        assert_eq!(record.release_tag, "toolchain-20260712.1");
        assert!(parse_channel_record(&format!("{body}\n{body}")).is_err());
    }

    #[test]
    fn rejects_channel_repository_or_release_mismatch() {
        assert!(
            parse_channel_record(&channel_body("someone/else", "toolchain-20260712.1")).is_err()
        );
        assert!(parse_channel_record(&channel_body(
            "Chlience/yt-dlp-tauri-toolchain",
            "toolchain-20260711.1"
        ))
        .is_err());
    }

    #[test]
    fn selects_one_exact_manifest_from_an_immutable_release() {
        let record = parse_channel_record(&channel_body(
            "Chlience/yt-dlp-tauri-toolchain",
            "toolchain-20260712.1",
        ))
        .unwrap();
        let release = GitHubRelease {
            tag_name: record.release_tag.clone(),
            body: None,
            draft: false,
            prerelease: false,
            immutable: true,
            assets: vec![ReleaseAsset {
                id: 7,
                name: record.manifest.clone(),
                size: 123,
                digest: Some(format!("sha256:{}", record.sha256)),
                browser_download_url: format!(
                    "https://github.com/{}/releases/download/{}/{}",
                    record.repository, record.release_tag, record.manifest
                ),
            }],
        };

        let asset = select_revision_manifest_asset(&release, &record).unwrap();

        assert_eq!(asset.id, 7);
        let mut mutable = release.clone();
        mutable.immutable = false;
        assert!(select_revision_manifest_asset(&mutable, &record).is_err());
        let mut duplicate = release.clone();
        duplicate.assets.push(duplicate.assets[0].clone());
        assert!(select_revision_manifest_asset(&duplicate, &record).is_err());
    }

    #[test]
    fn verifies_manifest_digest_revision_and_historical_archive_urls() {
        let manifest_json = br#"{
          "schemaVersion": 4,
          "revision": "20260712.2",
          "targets": [{
            "target": "win-x64",
            "tools": [{
              "name": "yt-dlp",
              "path": "Tools/win-x64/yt-dlp/yt-dlp.exe",
              "sourceUrl": "https://github.com/Chlience/yt-dlp-tauri-toolchain/releases/download/toolchain-20260712.1/yt-dlp.exe",
              "sourceSize": 10,
              "sourceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              "kind": "file"
            }]
          }]
        }"#;
        let record = ChannelRecord {
            repository: ARCHIVE_REPOSITORY.to_string(),
            revision: "20260712.2".to_string(),
            release_tag: "toolchain-20260712.2".to_string(),
            manifest: "tools-manifest-20260712.2.json".to_string(),
            sha256: sha256_bytes(manifest_json),
        };

        assert!(verify_channel_manifest(&record, manifest_json).is_ok());
        assert!(verify_channel_manifest(&record, b"{}").is_err());

        let future_manifest = String::from_utf8(manifest_json.to_vec())
            .unwrap()
            .replace("toolchain-20260712.1", "toolchain-20260713.1");
        let future_record = ChannelRecord {
            sha256: sha256_bytes(future_manifest.as_bytes()),
            ..record
        };
        assert!(verify_channel_manifest(&future_record, future_manifest.as_bytes()).is_err());
    }
}
