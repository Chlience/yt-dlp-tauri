use super::{
    manifest_target, relative_manifest_tool_path, sha256_bytes, tool_names_for_target,
    tool_paths_from_manifest, ToolPaths, ToolchainRevision, ToolsManifest, TOOLS_DIRECTORY,
};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::fs::File;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const ACTIVE_STATE_SCHEMA_VERSION: u32 = 1;
const ACTIVE_STATE_FILE: &str = "active.json";
pub const REVISION_MANIFEST_FILE: &str = "tools-manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveToolchainState {
    pub schema_version: u32,
    pub target: String,
    pub revision: String,
    pub manifest_sha256: String,
    pub previous_revision: Option<String>,
    pub activated_at_unix: u64,
}

impl ActiveToolchainState {
    pub fn new(
        target: &str,
        revision: &str,
        manifest_sha256: &str,
        previous_revision: Option<String>,
    ) -> Result<Self, String> {
        let state = Self {
            schema_version: ACTIVE_STATE_SCHEMA_VERSION,
            target: target.to_string(),
            revision: revision.to_string(),
            manifest_sha256: manifest_sha256.to_string(),
            previous_revision,
            activated_at_unix: unix_timestamp()?,
        };
        validate_active_state(&state, target)?;
        Ok(state)
    }
}

pub fn revision_root(base: &Path, target: &str, revision: &str) -> Result<PathBuf, String> {
    validate_target(target)?;
    let revision = ToolchainRevision::parse(revision)?;
    Ok(revisions_root(base, target).join(revision.to_string()))
}

pub fn revisions_root(base: &Path, target: &str) -> PathBuf {
    base.join(TOOLS_DIRECTORY).join(target).join("revisions")
}

pub fn active_state_path(base: &Path, target: &str) -> Result<PathBuf, String> {
    validate_target(target)?;
    Ok(base
        .join(TOOLS_DIRECTORY)
        .join(target)
        .join(ACTIVE_STATE_FILE))
}

pub fn read_active_state(
    base: &Path,
    target: &str,
) -> Result<Option<ActiveToolchainState>, String> {
    let path = active_state_path(base, target)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| {
        format!(
            "Failed to read active toolchain state at {}: {error}",
            path.display()
        )
    })?;
    let state: ActiveToolchainState = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Invalid active toolchain state at {}: {error}",
            path.display()
        )
    })?;
    validate_active_state(&state, target)?;
    Ok(Some(state))
}

pub fn active_tool_paths(base: &Path, target: &str) -> Result<Option<ToolPaths>, String> {
    let Some(state) = read_active_state(base, target)? else {
        return Ok(None);
    };
    tool_paths_for_state(base, &state).map(Some)
}

pub fn activate_revision(base: &Path, state: &ActiveToolchainState) -> Result<(), String> {
    validate_active_state(state, &state.target)?;
    let _ = tool_paths_for_state(base, state)?;

    let current = read_active_state(base, &state.target)?;
    match (current.as_ref(), state.previous_revision.as_deref()) {
        (Some(current), Some(previous)) if current.revision == previous => {}
        (None, None) => {}
        (Some(current), _) => {
            return Err(format!(
                "Active toolchain changed before activation: expected previous revision {:?}, found {}",
                state.previous_revision, current.revision
            ));
        }
        (None, Some(previous)) => {
            return Err(format!(
                "Active toolchain changed before activation: expected previous revision {previous}, found none"
            ));
        }
    }

    let destination = active_state_path(base, &state.target)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Active toolchain state has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create active toolchain state directory {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(
        ".active-{}-{}-{}.json",
        state.revision,
        std::process::id(),
        unique_nonce()?
    ));
    let mut json = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to serialize active toolchain state: {error}"))?;
    json.push(b'\n');
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "Failed to create temporary active state {}: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(&json).map_err(|error| {
            format!(
                "Failed to write temporary active state {}: {error}",
                temporary.display()
            )
        })?;
        file.flush().map_err(|error| {
            format!(
                "Failed to flush temporary active state {}: {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "Failed to sync temporary active state {}: {error}",
                temporary.display()
            )
        })?;
        drop(file);
        atomic_replace(&temporary, &destination)
    })();
    if write_result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn tool_paths_for_state(base: &Path, state: &ActiveToolchainState) -> Result<ToolPaths, String> {
    let root = revision_root(base, &state.target, &state.revision)?;
    let manifest_path = root.join(REVISION_MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        format!(
            "Failed to read active toolchain manifest at {}: {error}",
            manifest_path.display()
        )
    })?;
    let actual_digest = sha256_bytes(&manifest_bytes);
    if actual_digest != state.manifest_sha256 {
        return Err(format!(
            "Active toolchain manifest SHA-256 mismatch for {}: expected {}, received {actual_digest}",
            state.revision, state.manifest_sha256
        ));
    }
    let manifest_json = std::str::from_utf8(&manifest_bytes).map_err(|error| {
        format!(
            "Active toolchain manifest at {} is not valid UTF-8: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: ToolsManifest = super::parse_manifest(manifest_json)?;
    if manifest.revision.as_deref() != Some(state.revision.as_str()) {
        return Err(format!(
            "Active toolchain manifest revision does not match {}",
            state.revision
        ));
    }
    let target = manifest_target(&manifest, &state.target)?;
    let paths = tool_paths_from_manifest(&root, &target)?;
    for tool in &target.tools {
        let path = root.join(relative_manifest_tool_path(tool)?);
        if !path.is_file() {
            return Err(format!(
                "Active toolchain revision {} is incomplete: missing {}/{} at {}",
                state.revision,
                state.target,
                tool.name,
                path.display()
            ));
        }
    }
    Ok(paths)
}

fn validate_active_state(state: &ActiveToolchainState, target: &str) -> Result<(), String> {
    if state.schema_version != ACTIVE_STATE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported active toolchain state schema: {}",
            state.schema_version
        ));
    }
    validate_target(target)?;
    if state.target != target {
        return Err(format!(
            "Active toolchain target mismatch: expected {target}, found {}",
            state.target
        ));
    }
    ToolchainRevision::parse(&state.revision)?;
    validate_sha256(&state.manifest_sha256)?;
    if let Some(previous) = state.previous_revision.as_deref() {
        ToolchainRevision::parse(previous)?;
    }
    if state.activated_at_unix == 0 {
        return Err("Active toolchain activation timestamp must be positive".to_string());
    }
    Ok(())
}

fn validate_target(target: &str) -> Result<(), String> {
    tool_names_for_target(target)
        .map(|_| ())
        .ok_or_else(|| format!("Unsupported tool target: {target}"))
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("Active toolchain manifest digest must be a lowercase 64-character SHA-256".to_string())
    }
}

fn unix_timestamp() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))
}

fn unique_nonce() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))
}

#[cfg(unix)]
fn atomic_replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|error| {
        format!(
            "Failed to activate toolchain state {}: {error}",
            destination.display()
        )
    })?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Active toolchain state has no parent directory".to_string())?;
    // Rename is the commit point; a later directory-sync error cannot be reported as a rollback-safe failure.
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::{iter, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                ptr::null(),
                0,
                ptr::null(),
                ptr::null(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if replaced == 0 {
        Err(format!(
            "Failed to activate toolchain state {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, time::SystemTime};

    struct TestDirectory(std::path::PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "yt-dlp-tauri-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn revision_storage_is_target_scoped() {
        assert_eq!(
            revision_root(Path::new("/data"), "win-x64", "20260712.1").unwrap(),
            Path::new("/data/Tools/win-x64/revisions/20260712.1"),
        );
    }

    #[test]
    fn invalid_active_state_never_selects_partial_tools() {
        let root = TestDirectory::new("invalid-active-state");
        let state_path = active_state_path(root.path(), "win-x64").unwrap();
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(state_path, "{broken").unwrap();

        assert!(read_active_state(root.path(), "win-x64").is_err());
        assert!(active_tool_paths(root.path(), "win-x64").is_err());
    }

    fn write_complete_revision(base: &Path, revision: &str) -> String {
        let root = revision_root(base, "win-x64", revision).unwrap();
        let manifest = format!(
            r#"{{
              "schemaVersion": 2,
              "revision": "{revision}",
              "targets": [{{
                "target": "win-x64",
                "tools": [
                  {{"name":"yt-dlp","path":"Tools/win-x64/yt-dlp/yt-dlp.exe","sourceUrl":"https://example.test/yt-dlp.exe","sha256":"a","kind":"file"}},
                  {{"name":"ffmpeg","path":"Tools/win-x64/ffmpeg/bin/ffmpeg.exe","sourceUrl":"https://example.test/ffmpeg.exe","sha256":"b","kind":"file"}},
                  {{"name":"ffprobe","path":"Tools/win-x64/ffmpeg/bin/ffprobe.exe","sourceUrl":"https://example.test/ffprobe.exe","sha256":"c","kind":"file"}},
                  {{"name":"deno","path":"Tools/win-x64/deno/deno.exe","sourceUrl":"https://example.test/deno.exe","sha256":"d","kind":"file"}}
                ]
              }}]
            }}"#
        );
        for relative in [
            "yt-dlp/yt-dlp.exe",
            "ffmpeg/bin/ffmpeg.exe",
            "ffmpeg/bin/ffprobe.exe",
            "deno/deno.exe",
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"fixture").unwrap();
        }
        fs::write(root.join(REVISION_MANIFEST_FILE), manifest.as_bytes()).unwrap();
        sha256_bytes(manifest.as_bytes())
    }

    #[test]
    fn activates_and_reads_a_complete_revision() {
        let root = TestDirectory::new("active-revision");
        let digest = write_complete_revision(root.path(), "20260712.1");
        let state = ActiveToolchainState::new("win-x64", "20260712.1", &digest, None).unwrap();

        activate_revision(root.path(), &state).unwrap();

        assert_eq!(
            read_active_state(root.path(), "win-x64").unwrap().unwrap(),
            state
        );
        assert!(active_tool_paths(root.path(), "win-x64")
            .unwrap()
            .unwrap()
            .yt_dlp
            .is_file());
    }

    #[test]
    fn rejected_activation_preserves_the_current_state() {
        let root = TestDirectory::new("preserved-active-revision");
        let first_digest = write_complete_revision(root.path(), "20260711.2");
        let first =
            ActiveToolchainState::new("win-x64", "20260711.2", &first_digest, None).unwrap();
        activate_revision(root.path(), &first).unwrap();
        let next_digest = write_complete_revision(root.path(), "20260712.1");
        let stale = ActiveToolchainState::new(
            "win-x64",
            "20260712.1",
            &next_digest,
            Some("20260710.1".to_string()),
        )
        .unwrap();

        assert!(activate_revision(root.path(), &stale).is_err());
        assert_eq!(
            read_active_state(root.path(), "win-x64")
                .unwrap()
                .unwrap()
                .revision,
            "20260711.2"
        );
    }
}
