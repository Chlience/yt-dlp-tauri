use std::{
    collections::HashMap,
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use zip::ZipArchive;

const MIN_DECOMPRESSED_LIMIT: u64 = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_LIMIT: u64 = 1024 * 1024 * 1024;
const MAX_EXPANSION_RATIO: u64 = 32;

pub(super) struct ArchiveMemberRequest<'a> {
    pub label: &'a str,
    pub suffix: &'a str,
    pub destination: &'a Path,
}

pub(super) fn safe_archive_member(name: &str) -> Result<PathBuf, String> {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') || normalized.contains('\0') {
        return Err(format!("Unsafe archive member path: {name}"));
    }

    let first = normalized.split('/').next().unwrap_or_default();
    if first.contains(':') {
        return Err(format!("Unsafe archive member path: {name}"));
    }

    let path = Path::new(&normalized);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(format!("Unsafe archive member path: {name}"));
    }

    let clean = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            Component::CurDir => None,
            _ => None,
        })
        .collect::<PathBuf>();
    if clean.as_os_str().is_empty() {
        return Err(format!("Unsafe archive member path: {name}"));
    }
    Ok(clean)
}

pub(super) fn extract_requested_members(
    archive_path: &Path,
    requests: &[ArchiveMemberRequest<'_>],
) -> Result<(), String> {
    let archive_file = fs::File::open(archive_path)
        .map_err(|error| format!("Failed to open archive {}: {error}", archive_path.display()))?;
    let archive_size = archive_file
        .metadata()
        .map_err(|error| {
            format!(
                "Failed to inspect archive {}: {error}",
                archive_path.display()
            )
        })?
        .len();
    let mut archive = ZipArchive::new(archive_file).map_err(|error| {
        format!(
            "Failed to parse archive {}: {error}",
            archive_path.display()
        )
    })?;
    if archive.has_overlapping_files().map_err(|error| {
        format!(
            "Failed to inspect archive {}: {error}",
            archive_path.display()
        )
    })? {
        return Err(format!(
            "Archive {} contains overlapping entries",
            archive_path.display()
        ));
    }

    let normalized_suffixes = requests
        .iter()
        .map(|request| {
            safe_archive_member(request.suffix).map(|path| {
                (
                    request.label,
                    path.to_string_lossy().replace('\\', "/"),
                    request.destination,
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut matches = HashMap::<usize, usize>::new();
    let mut selected_sizes = HashMap::<usize, u64>::new();

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect archive entry {index}: {error}"))?;
        if entry.enclosed_name().is_none() {
            return Err(format!("Unsafe archive member path: {}", entry.name()));
        }
        let member = safe_archive_member(entry.name())?;
        if entry.is_symlink() {
            return Err(format!(
                "Archive member {} is a symbolic link",
                entry.name()
            ));
        }
        if entry.encrypted() {
            return Err(format!("Archive member {} is encrypted", entry.name()));
        }
        let member = member.to_string_lossy().replace('\\', "/");

        for (request_index, (_, suffix, _)) in normalized_suffixes.iter().enumerate() {
            if normalized_suffix_match(&member, suffix) {
                if entry.is_dir() || !entry.is_file() {
                    return Err(format!(
                        "Archive member {} is not a regular file",
                        entry.name()
                    ));
                }
                if matches.insert(request_index, index).is_some() {
                    return Err(format!(
                        "Archive contains multiple files matching suffix {suffix}"
                    ));
                }
                selected_sizes.insert(request_index, entry.size());
            }
        }
    }

    // Standalone executables can legitimately exceed the compressed HTTP asset size.
    // Bound both the expansion ratio and absolute output instead of rejecting those archives.
    let decompressed_limit = archive_size
        .saturating_mul(MAX_EXPANSION_RATIO)
        .clamp(MIN_DECOMPRESSED_LIMIT, MAX_DECOMPRESSED_LIMIT);
    let total_size = normalized_suffixes.iter().enumerate().try_fold(
        0_u64,
        |total, (request_index, (label, suffix, _))| {
            let size = selected_sizes.get(&request_index).copied().ok_or_else(|| {
                format!(
                    "Unable to find {label} at {suffix} in {}",
                    archive_path.display()
                )
            })?;
            if size > decompressed_limit {
                return Err(format!(
                    "Archive member for {label} exceeds the decompressed size limit"
                ));
            }
            total
                .checked_add(size)
                .ok_or_else(|| "Archive member sizes overflowed".to_string())
        },
    )?;
    if total_size > decompressed_limit {
        return Err(format!(
            "Requested archive members exceed the decompressed size limit for {}",
            archive_path.display()
        ));
    }

    for (request_index, (label, _, destination)) in normalized_suffixes.iter().enumerate() {
        let index = *matches
            .get(&request_index)
            .ok_or_else(|| format!("Unable to find {label} in {}", archive_path.display()))?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to open archive member for {label}: {error}"))?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to prepare {}: {error}", parent.display()))?;
        }
        let mut output = fs::File::create(destination).map_err(|error| {
            format!(
                "Failed to create {} for {label}: {error}",
                destination.display()
            )
        })?;
        let copied = io::copy(
            &mut entry.by_ref().take(decompressed_limit + 1),
            &mut output,
        )
        .map_err(|error| format!("Failed to extract {label}: {error}"))?;
        if copied > decompressed_limit {
            let _ = fs::remove_file(destination);
            return Err(format!(
                "Extracted {label} exceeds the decompressed size limit"
            ));
        }
        output
            .flush()
            .map_err(|error| format!("Failed to flush extracted {label}: {error}"))?;
    }

    Ok(())
}

fn normalized_suffix_match(member: &str, suffix: &str) -> bool {
    member == suffix
        || member
            .strip_suffix(suffix)
            .is_some_and(|prefix| prefix.ends_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use zip::write::SimpleFileOptions;

    #[test]
    fn rejects_parent_segments_in_archive_members() {
        assert_eq!(
            safe_archive_member("build/bin/ffmpeg.exe").unwrap(),
            PathBuf::from("build/bin/ffmpeg.exe")
        );
        assert!(safe_archive_member("../ffmpeg.exe").is_err());
        assert!(safe_archive_member("/tmp/ffmpeg").is_err());
        assert!(safe_archive_member("C:/ffmpeg.exe").is_err());
    }

    #[test]
    fn suffix_matching_requires_a_path_component_boundary() {
        assert!(normalized_suffix_match(
            "build/bin/ffmpeg.exe",
            "bin/ffmpeg.exe"
        ));
        assert!(normalized_suffix_match("deno.exe", "deno.exe"));
        assert!(!normalized_suffix_match(
            "build/bin/notffmpeg.exe",
            "ffmpeg.exe"
        ));
    }

    #[test]
    fn extracts_only_the_requested_archive_member() {
        let root = temporary_test_root("requested-member");
        let archive_path = root.join("tools.zip");
        write_test_archive(
            &archive_path,
            &[
                ("bundle/bin/ffmpeg.exe", b"ffmpeg"),
                ("bundle/README.txt", b"documentation"),
            ],
        );
        let destination = root.join("output/ffmpeg.exe");

        extract_requested_members(
            &archive_path,
            &[ArchiveMemberRequest {
                label: "ffmpeg",
                suffix: "bin/ffmpeg.exe",
                destination: &destination,
            }],
        )
        .unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"ffmpeg");
        assert!(!root.join("output/README.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_duplicate_archive_suffix_matches() {
        let root = temporary_test_root("duplicate-member");
        let archive_path = root.join("tools.zip");
        write_test_archive(
            &archive_path,
            &[
                ("first/bin/ffmpeg.exe", b"first"),
                ("second/bin/ffmpeg.exe", b"second"),
            ],
        );
        let destination = root.join("ffmpeg.exe");

        let error = extract_requested_members(
            &archive_path,
            &[ArchiveMemberRequest {
                label: "ffmpeg",
                suffix: "bin/ffmpeg.exe",
                destination: &destination,
            }],
        )
        .unwrap_err();

        assert!(error.contains("multiple files matching suffix"));
        assert!(!destination.exists());
        let _ = fs::remove_dir_all(root);
    }

    fn temporary_test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "yt-dlp-tauri-archive-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_test_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        for (name, contents) in entries {
            archive
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap();
    }
}
