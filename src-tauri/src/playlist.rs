use crate::{
    cookies,
    downloads::{output_filename, safe_component},
    read_thumbnail_urls,
};
use serde::Serialize;
use serde_json::Value;

pub(crate) const PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PlaylistItem {
    pub index: u32,
    pub id: Option<String>,
    pub title: String,
    pub filename: Option<String>,
    pub url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub duration_seconds: Option<f64>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct PlaylistPage {
    pub title: String,
    pub directory_name: String,
    pub entries: Vec<PlaylistItem>,
    pub total: Option<u32>,
    pub next_start: Option<u32>,
    pub error: Option<String>,
}

pub(crate) struct PageReader {
    start: u32,
    title: Option<String>,
    total: Option<u32>,
    entries: Vec<PlaylistItem>,
    more: bool,
    error: Option<String>,
}

impl PageReader {
    pub fn new(start: u32) -> Result<Self, String> {
        if start == 0 || start.checked_add(PAGE_SIZE).is_none() {
            return Err("Invalid playlist page.".to_string());
        }
        Ok(Self {
            start,
            title: None,
            total: None,
            entries: Vec::new(),
            more: false,
            error: None,
        })
    }

    pub fn line(&mut self, line: &str) {
        if line.trim().is_empty() {
            return;
        }
        let root: Value = match serde_json::from_str(line) {
            Ok(root) => root,
            Err(error) => {
                self.error
                    .get_or_insert_with(|| format!("Could not read a playlist item: {error}"));
                return;
            }
        };
        if self.title.is_none() {
            self.title = text(&root, "playlist_title").or_else(|| text(&root, "playlist"));
        }
        if let Some(total) = number(&root, "playlist_count") {
            self.total = Some(total);
        }
        let index =
            number(&root, "playlist_index").unwrap_or(self.start + self.entries.len() as u32);
        if index >= self.start + PAGE_SIZE || self.entries.len() >= PAGE_SIZE as usize {
            self.more = true;
            return;
        }
        if index < self.start || self.entries.iter().any(|entry| entry.index == index) {
            return;
        }
        let id = text(&root, "id");
        let title = text(&root, "title").unwrap_or_else(|| format!("Item {index}"));
        let url = item_url(&root);
        let unavailable_reason = if url.is_none() {
            Some("Video URL is unavailable.".to_string())
        } else if matches!(title.as_str(), "[Private video]" | "[Deleted video]") {
            Some("This playlist item is unavailable to the selected account.".to_string())
        } else {
            None
        };
        let filename = url
            .as_deref()
            .map(|url| output_filename(&title, id.as_deref(), url, Some(index)));
        self.entries.push(PlaylistItem {
            filename,
            index,
            id,
            title,
            url,
            thumbnail_url: read_thumbnail_urls(&root).first().cloned(),
            duration_seconds: root.get("duration").and_then(Value::as_f64),
            unavailable_reason,
        });
    }

    pub fn finish(self, failure: Option<String>) -> PlaylistPage {
        let error = failure.or(self.error);
        let title = self.title.unwrap_or_else(|| "Playlist".to_string());
        let next_start = if error.is_some() {
            Some(
                self.entries
                    .last()
                    .map(|entry| entry.index + 1)
                    .unwrap_or(self.start),
            )
        } else if self.more
            || self
                .total
                .is_some_and(|total| total > self.start + PAGE_SIZE - 1)
        {
            Some(self.start + PAGE_SIZE)
        } else {
            None
        };
        PlaylistPage {
            directory_name: safe_component(&title),
            title,
            entries: self.entries,
            total: self.total,
            next_start,
            error,
        }
    }
}

// A Bilibili part URL suppresses anthology expansion even with --yes-playlist.
// Remove only its part selector after the user explicitly chooses the full list.
pub(crate) fn source_url(value: &str) -> Result<String, String> {
    let mut url = cookies::http_url(value)?;
    let host = url.host_str().unwrap_or("");
    if (host == "bilibili.com" || host.ends_with(".bilibili.com"))
        && url.path().starts_with("/video/")
    {
        let retained: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "p")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.set_query(None);
        if !retained.is_empty() {
            url.query_pairs_mut().extend_pairs(retained);
        }
    }
    Ok(url.to_string())
}

fn text(root: &Value, key: &str) -> Option<String> {
    root.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

fn number(root: &Value, key: &str) -> Option<u32> {
    root.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn item_url(root: &Value) -> Option<String> {
    let flat = matches!(
        root.get("_type").and_then(Value::as_str),
        Some("url" | "url_transparent")
    );
    let keys = if flat {
        ["url", "webpage_url"]
    } else {
        ["webpage_url", "original_url"]
    };
    for key in keys {
        if let Some(url) = text(root, key).filter(|url| cookies::http_url(url).is_ok()) {
            return Some(url);
        }
    }
    if root.get("ie_key").and_then(Value::as_str) == Some("Youtube") {
        if let Some(id) = text(root, "id") {
            let mut url =
                reqwest::Url::parse("https://www.youtube.com/watch").expect("valid static URL");
            url.query_pairs_mut().append_pair("v", &id);
            return Some(url.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(index: u32) -> String {
        serde_json::json!({"_type":"url", "url":format!("https://video.example/{index}"),
            "title":format!("Video {index}"), "id":index.to_string(), "playlist_title":"Course",
            "playlist_index":index, "playlist_count":123})
        .to_string()
    }

    #[test]
    fn full_bilibili_lists_remove_only_the_part_selector() {
        assert_eq!(
            source_url("https://www.bilibili.com/video/BV123?p=3&foo=bar").unwrap(),
            "https://www.bilibili.com/video/BV123?foo=bar"
        );
        assert_eq!(
            source_url("https://video.example/watch?p=3").unwrap(),
            "https://video.example/watch?p=3"
        );
        assert_eq!(
            source_url("https://notbilibili.com/video/BV123?p=3").unwrap(),
            "https://notbilibili.com/video/BV123?p=3"
        );
    }

    #[test]
    fn large_playlists_are_read_in_bounded_pages_without_renumbering() {
        let mut all = Vec::new();
        for start in [1, 51, 101] {
            let mut reader = PageReader::new(start).unwrap();
            for index in start..=(start + PAGE_SIZE).min(123) {
                reader.line(&item(index));
            }
            let page = reader.finish(None);
            assert!(page.entries.len() <= 50);
            assert_eq!(page.total, Some(123));
            assert_eq!(
                page.next_start,
                if start < 101 { Some(start + 50) } else { None }
            );
            all.extend(page.entries.into_iter().map(|entry| entry.index));
        }
        assert_eq!(all, (1..=123).collect::<Vec<_>>());
    }

    #[test]
    fn partial_failure_preserves_results_and_resumes_after_the_last_item() {
        let mut reader = PageReader::new(51).unwrap();
        reader.line(&item(51));
        reader.line(&item(52));
        let page = reader.finish(Some("Connection interrupted".to_string()));
        assert_eq!(page.entries.len(), 2);
        assert_eq!(page.next_start, Some(53));
        assert!(page.error.is_some());
    }

    #[test]
    fn missing_metadata_does_not_invent_duration_or_total() {
        let mut reader = PageReader::new(1).unwrap();
        reader.line(
            r#"{"_type":"url","ie_key":"Youtube","id":"abc","title":"Video","n_entries":50}"#,
        );
        let page = reader.finish(None);
        assert_eq!(page.total, None);
        assert_eq!(page.entries[0].duration_seconds, None);
        assert_eq!(page.entries[0].thumbnail_url, None);
        assert_eq!(
            page.entries[0].url.as_deref(),
            Some("https://www.youtube.com/watch?v=abc")
        );
    }

    #[test]
    fn unavailable_items_keep_their_original_positions() {
        let mut reader = PageReader::new(1).unwrap();
        reader.line(r#"{"_type":"url","url":"https://video.example/3","title":"[Private video]","playlist_index":3}"#);
        let page = reader.finish(None);
        assert_eq!(page.entries[0].index, 3);
        assert!(page.entries[0].unavailable_reason.is_some());
    }
}
