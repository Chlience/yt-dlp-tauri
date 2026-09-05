use crate::{
    downloads::{DownloadInput, DownloadJob},
    process::{ProcessState, Task},
    proxy::ProxyConfig,
    DownloadProgress,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    thread,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestStatus {
    Waiting,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

impl RequestStatus {
    fn active(self) -> bool {
        matches!(self, Self::Running | Self::Cancelling)
    }
    pub fn finished(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolchain::ToolPaths;
    use std::{
        path::PathBuf,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn job(name: &str) -> DownloadJob {
        DownloadJob::new(
            DownloadInput {
                url: format!("https://video.example/{name}"),
                title: name.into(),
                video_id: Some(name.into()),
                thumbnail_url: None,
                format_selector: "b".into(),
                label: "Best".into(),
                audio_only: false,
                playlist: None,
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

    struct Harness {
        queue: QueueState,
        started: mpsc::Receiver<(String, mpsc::Sender<bool>)>,
        events: mpsc::Receiver<QueueSnapshot>,
    }

    impl Harness {
        fn new() -> Self {
            let (started_tx, started) = mpsc::channel();
            let (events_tx, events) = mpsc::channel();
            let queue = QueueState::new(
                ProcessState::default(),
                Arc::new(move |job, task, report| {
                    let (done_tx, done_rx) = mpsc::channel();
                    started_tx.send((job.input.title.clone(), done_tx)).unwrap();
                    report(DownloadProgress {
                        percent: Some(25.0),
                        status: "downloading".into(),
                        speed: None,
                        eta: None,
                        raw: None,
                    });
                    let success = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    if task.is_cancelled() {
                        Err(crate::process::CANCELLED.into())
                    } else if success {
                        Ok(Some(format!("/downloads/{}.mp4", job.input.title)))
                    } else {
                        Err("Fixture failure".into())
                    }
                }),
                Arc::new(move |event| {
                    if let QueueEvent::Snapshot(snapshot) = event {
                        let _ = events_tx.send(snapshot);
                    }
                }),
            );
            Self {
                queue,
                started,
                events,
            }
        }

        fn started(&self, name: &str) -> mpsc::Sender<bool> {
            let (actual, finish) = self.started.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(actual, name);
            finish
        }

        fn wait(&self, id: &str, status: RequestStatus) -> QueueSnapshot {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let snapshot = self.queue.snapshot().unwrap();
                if snapshot
                    .requests
                    .iter()
                    .any(|item| item.id == id && item.status == status)
                {
                    return snapshot;
                }
                self.events
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap();
            }
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            self.queue.shutdown();
        }
    }

    #[test]
    fn concurrent_requests_cancel_independently_and_fill_the_available_slot() {
        let test = Harness::new();
        test.queue.set_options(2, false).unwrap();
        test.queue
            .enqueue(vec![job("one"), job("two"), job("three")])
            .unwrap();
        let mut running = std::collections::HashMap::new();
        for _ in 0..2 {
            let (name, finish) = test.started.recv_timeout(Duration::from_secs(5)).unwrap();
            running.insert(name, finish);
        }
        assert!(running.contains_key("one") && running.contains_key("two"));
        assert_eq!(
            test.queue.item("request-3").unwrap().status,
            RequestStatus::Waiting
        );
        test.queue.cancel("request-1").unwrap();
        running.remove("one").unwrap().send(true).unwrap();
        test.wait("request-1", RequestStatus::Cancelled);
        let third = test.started("three");
        assert_eq!(
            test.queue.item("request-2").unwrap().status,
            RequestStatus::Running
        );
        running.remove("two").unwrap().send(true).unwrap();
        third.send(true).unwrap();
        test.wait("request-2", RequestStatus::Completed);
        test.wait("request-3", RequestStatus::Completed);
    }

    #[test]
    fn failure_continues_and_retry_preserves_successful_requests() {
        let test = Harness::new();
        test.queue.enqueue(vec![job("one"), job("two")]).unwrap();
        test.started("one").send(false).unwrap();
        test.started("two").send(true).unwrap();
        test.wait("request-2", RequestStatus::Completed);
        let completed = test.queue.item("request-2").unwrap();
        test.queue
            .retry("request-1", test.queue.job("request-1").unwrap())
            .unwrap();
        test.started("one").send(true).unwrap();
        test.wait("request-1", RequestStatus::Completed);
        let retained = test.queue.item("request-2").unwrap();
        assert_eq!(retained.revision, completed.revision);
        assert_eq!(retained.output_path, completed.output_path);
        assert!(test.queue.retry("request-2", job("two")).is_err());
    }

    #[test]
    fn queued_jobs_keep_their_proxy_and_retry_replaces_only_the_selected_jobs_proxy() {
        let test = Harness::new();
        test.queue.set_options(1, true).unwrap();
        let mut original = job("one");
        original.proxy = ProxyConfig {
            mode: crate::proxy::ProxyMode::Custom,
            url: Some("http://user:secret@localhost:7890".into()),
        }
        .validate()
        .unwrap();
        test.queue
            .enqueue(vec![original.clone(), job("two")])
            .unwrap();
        let serialized = serde_json::to_string(&test.queue.snapshot().unwrap()).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("user:"));
        assert_eq!(test.queue.job("request-1").unwrap().proxy, original.proxy);
        test.queue.cancel("request-1").unwrap();
        let mut retry = test.queue.job("request-1").unwrap();
        retry.proxy = ProxyConfig {
            mode: crate::proxy::ProxyMode::Direct,
            url: None,
        };
        test.queue.retry("request-1", retry).unwrap();
        assert_eq!(
            test.queue.item("request-1").unwrap().proxy.mode,
            crate::proxy::ProxyMode::Direct
        );
        assert_eq!(
            test.queue.job("request-1").unwrap().input.url,
            original.input.url
        );
        assert_eq!(
            test.queue.job("request-1").unwrap().directory,
            original.directory
        );
        assert_eq!(
            test.queue.job("request-2").unwrap().proxy,
            ProxyConfig::default()
        );
    }

    #[test]
    fn stopping_new_requests_keeps_running_work_and_waiting_cancellation_never_starts() {
        let test = Harness::new();
        test.queue
            .enqueue(vec![job("one"), job("two"), job("three")])
            .unwrap();
        let first = test.started("one");
        test.queue.set_options(1, true).unwrap();
        test.queue.cancel("request-2").unwrap();
        first.send(true).unwrap();
        test.wait("request-1", RequestStatus::Completed);
        assert_eq!(
            test.queue.item("request-3").unwrap().status,
            RequestStatus::Waiting
        );
        assert!(test.started.try_recv().is_err());
        let remaining = test.queue.clear_finished().unwrap();
        assert_eq!(remaining.requests.len(), 1);
        assert_eq!(remaining.requests[0].id, "request-3");
        test.queue.set_options(1, false).unwrap();
        test.started("three").send(true).unwrap();
        test.wait("request-3", RequestStatus::Completed);
    }

    #[test]
    fn colliding_output_names_are_serialized_and_other_paths_can_start() {
        let test = Harness::new();
        test.queue.set_options(3, false).unwrap();
        test.queue
            .enqueue(vec![job("one"), job("one"), job("three")])
            .unwrap();
        let mut running = std::collections::HashMap::new();
        for _ in 0..2 {
            let (name, finish) = test.started.recv_timeout(Duration::from_secs(5)).unwrap();
            running.insert(name, finish);
        }
        assert_eq!(
            test.queue.item("request-2").unwrap().status,
            RequestStatus::Waiting
        );
        running.remove("one").unwrap().send(true).unwrap();
        test.started("one").send(true).unwrap();
        running.remove("three").unwrap().send(true).unwrap();
        test.wait("request-2", RequestStatus::Completed);
        test.wait("request-3", RequestStatus::Completed);
    }

    #[test]
    fn invalid_options_do_not_mutate_queue_and_waiting_requests_block_maintenance() {
        let test = Harness::new();
        assert!(test.queue.set_options(0, false).is_err());
        assert!(test.queue.set_options(4, false).is_err());
        assert!(test.queue.enqueue(vec![]).is_err());
        test.queue.set_options(1, true).unwrap();
        test.queue.enqueue(vec![job("one")]).unwrap();
        assert!(test.queue.processes.begin_maintenance().is_err());
        test.queue.cancel("request-1").unwrap();
        assert!(test.queue.processes.begin_maintenance().is_ok());
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct DownloadItem {
    pub id: String,
    pub revision: u64,
    pub request: DownloadInput,
    pub status: RequestStatus,
    pub directory: String,
    pub filename: String,
    pub cookie_origin: Option<String>,
    pub proxy: ProxyConfig,
    pub cookie_file: Option<String>,
    pub progress: Option<DownloadProgress>,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct QueueSnapshot {
    pub revision: u64,
    pub concurrency: usize,
    pub paused: bool,
    pub requests: Vec<DownloadItem>,
}

pub(crate) enum QueueEvent {
    Snapshot(QueueSnapshot),
    Progress(Box<DownloadItem>),
}
type Runner = dyn Fn(
        &DownloadJob,
        &Task,
        &mut (dyn FnMut(DownloadProgress) + Send),
    ) -> Result<Option<String>, String>
    + Send
    + Sync;
type Observer = dyn Fn(QueueEvent) + Send + Sync;

struct Entry {
    item: DownloadItem,
    job: Arc<DownloadJob>,
    task: Option<Arc<Task>>,
}

struct Queue {
    next_id: u64,
    revision: u64,
    concurrency: usize,
    paused: bool,
    entries: Vec<Entry>,
}

impl Queue {
    fn snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            revision: self.revision,
            concurrency: self.concurrency,
            paused: self.paused,
            requests: self
                .entries
                .iter()
                .map(|entry| entry.item.clone())
                .collect(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct QueueState {
    inner: Arc<Mutex<Queue>>,
    processes: ProcessState,
    runner: Arc<Runner>,
    observer: Arc<Observer>,
}

impl QueueState {
    pub fn new(processes: ProcessState, runner: Arc<Runner>, observer: Arc<Observer>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Queue {
                next_id: 1,
                revision: 0,
                concurrency: 1,
                paused: false,
                entries: vec![],
            })),
            processes,
            runner,
            observer,
        }
    }

    pub fn snapshot(&self) -> Result<QueueSnapshot, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|error| error.to_string())?
            .snapshot())
    }

    // Publish under the state lock so updates from concurrent workers preserve their revision order.
    fn changed(&self, queue: &mut Queue, ids: &[String]) -> QueueSnapshot {
        queue.revision += 1;
        for entry in &mut queue.entries {
            if ids.contains(&entry.item.id) {
                entry.item.revision = queue.revision;
            }
        }
        let snapshot = queue.snapshot();
        (self.observer)(QueueEvent::Snapshot(snapshot.clone()));
        snapshot
    }

    pub fn enqueue(&self, jobs: Vec<DownloadJob>) -> Result<QueueSnapshot, String> {
        if jobs.is_empty() {
            return Err("Select at least one item to download.".to_string());
        }
        let mut queue = self.inner.lock().map_err(|error| error.to_string())?;
        let mut additions = Vec::with_capacity(jobs.len());
        for job in jobs {
            let id = format!("request-{}", queue.next_id);
            queue.next_id += 1;
            let task = Arc::new(self.processes.begin_named(&id)?);
            additions.push(Entry {
                item: DownloadItem {
                    id,
                    revision: 0,
                    request: job.input.clone(),
                    status: RequestStatus::Waiting,
                    directory: job.directory.display().to_string(),
                    filename: job.filename.clone(),
                    cookie_file: job
                        .cookies
                        .as_ref()
                        .map(|cookie| cookie.path.display().to_string()),
                    cookie_origin: job
                        .cookies
                        .as_ref()
                        .and_then(|cookie| cookie.origin.clone()),
                    proxy: job.proxy.summary(),
                    progress: None,
                    output_path: None,
                    error: None,
                },
                job: Arc::new(job),
                task: Some(task),
            });
        }
        let ids = additions
            .iter()
            .map(|entry| entry.item.id.clone())
            .collect::<Vec<_>>();
        queue.entries.extend(additions);
        self.changed(&mut queue, &ids);
        drop(queue);
        self.start();
        self.snapshot()
    }

    pub fn set_options(&self, concurrency: usize, paused: bool) -> Result<QueueSnapshot, String> {
        if !(1..=3).contains(&concurrency) {
            return Err("Simultaneous downloads must be between 1 and 3.".to_string());
        }
        let mut queue = self.inner.lock().map_err(|error| error.to_string())?;
        queue.concurrency = concurrency;
        queue.paused = paused;
        self.changed(&mut queue, &[]);
        drop(queue);
        self.start();
        self.snapshot()
    }

    pub fn cancel(&self, id: &str) -> Result<QueueSnapshot, String> {
        let mut queue = self.inner.lock().map_err(|error| error.to_string())?;
        let entry = queue
            .entries
            .iter_mut()
            .find(|entry| entry.item.id == id)
            .ok_or("Download request was not found.")?;
        if entry.item.status.finished() {
            return Ok(queue.snapshot());
        }
        if let Some(task) = &entry.task {
            task.cancel();
        }
        if entry.item.status == RequestStatus::Waiting {
            entry.item.status = RequestStatus::Cancelled;
            entry.task = None;
        } else {
            entry.item.status = RequestStatus::Cancelling;
        }
        Ok(self.changed(&mut queue, &[id.to_string()]))
    }

    pub fn job(&self, id: &str) -> Result<DownloadJob, String> {
        self.inner
            .lock()
            .map_err(|error| error.to_string())?
            .entries
            .iter()
            .find(|entry| entry.item.id == id)
            .map(|entry| (*entry.job).clone())
            .ok_or_else(|| "Download request was not found.".to_string())
    }

    pub fn item(&self, id: &str) -> Result<DownloadItem, String> {
        self.inner
            .lock()
            .map_err(|error| error.to_string())?
            .entries
            .iter()
            .find(|entry| entry.item.id == id)
            .map(|entry| entry.item.clone())
            .ok_or_else(|| "Download request was not found.".to_string())
    }

    pub fn retry(&self, id: &str, job: DownloadJob) -> Result<QueueSnapshot, String> {
        let mut queue = self.inner.lock().map_err(|error| error.to_string())?;
        let entry = queue
            .entries
            .iter_mut()
            .find(|entry| entry.item.id == id)
            .ok_or("Download request was not found.")?;
        if !matches!(
            entry.item.status,
            RequestStatus::Failed | RequestStatus::Cancelled
        ) {
            return Err("Only failed or cancelled requests can be retried.".to_string());
        }
        entry.task = Some(Arc::new(self.processes.begin_named(id)?));
        entry.item.status = RequestStatus::Waiting;
        entry.item.progress = None;
        entry.item.error = None;
        entry.item.output_path = None;
        entry.item.cookie_origin = job
            .cookies
            .as_ref()
            .and_then(|cookie| cookie.origin.clone());
        entry.item.cookie_file = job
            .cookies
            .as_ref()
            .map(|cookie| cookie.path.display().to_string());
        entry.item.proxy = job.proxy.summary();
        entry.job = Arc::new(job);
        self.changed(&mut queue, &[id.to_string()]);
        drop(queue);
        self.start();
        self.snapshot()
    }

    pub fn clear_finished(&self) -> Result<QueueSnapshot, String> {
        let mut queue = self.inner.lock().map_err(|error| error.to_string())?;
        queue.entries.retain(|entry| !entry.item.status.finished());
        Ok(self.changed(&mut queue, &[]))
    }

    pub fn has_unfinished(&self) -> bool {
        self.inner
            .lock()
            .map(|queue| {
                queue
                    .entries
                    .iter()
                    .any(|entry| !entry.item.status.finished())
            })
            .unwrap_or(true)
    }

    pub fn shutdown(&self) {
        if let Ok(mut queue) = self.inner.lock() {
            queue.paused = true;
            for entry in &mut queue.entries {
                if let Some(task) = &entry.task {
                    task.cancel();
                }
                if entry.item.status == RequestStatus::Waiting {
                    entry.item.status = RequestStatus::Cancelled;
                    entry.task = None;
                }
            }
        }
        let _ = self.processes.cancel_all();
    }

    fn start(&self) {
        let Ok(mut queue) = self.inner.lock() else {
            return;
        };
        if queue.paused {
            return;
        }
        let mut active = queue
            .entries
            .iter()
            .filter(|entry| entry.item.status.active())
            .count();
        let mut paths: HashSet<_> = queue
            .entries
            .iter()
            .filter(|entry| entry.item.status.active())
            .map(|entry| entry.job.output_key.clone())
            .collect();
        let limit = queue.concurrency;
        let mut starts = Vec::new();
        for entry in &mut queue.entries {
            if active >= limit {
                break;
            }
            if entry.item.status != RequestStatus::Waiting || paths.contains(&entry.job.output_key)
            {
                continue;
            }
            let task = Arc::clone(
                entry
                    .task
                    .as_ref()
                    .expect("waiting requests reserve a process"),
            );
            entry.item.status = RequestStatus::Running;
            paths.insert(entry.job.output_key.clone());
            active += 1;
            starts.push((entry.item.id.clone(), Arc::clone(&entry.job), task));
        }
        if !starts.is_empty() {
            let ids = starts
                .iter()
                .map(|(id, _, _)| id.clone())
                .collect::<Vec<_>>();
            self.changed(&mut queue, &ids);
        }
        drop(queue);
        for (id, job, task) in starts {
            let state = self.clone();
            let failed_id = id.clone();
            let result = thread::Builder::new().name(id.clone()).spawn(move || {
                let result =
                    (state.runner)(&job, &task, &mut |progress| state.progress(&id, progress));
                let cancelled = task.is_cancelled();
                drop(task);
                state.finish(&id, result, cancelled);
            });
            if let Err(error) = result {
                self.finish(
                    &failed_id,
                    Err(format!("Could not start download worker: {error}")),
                    false,
                );
            }
        }
    }

    fn progress(&self, id: &str, progress: DownloadProgress) {
        let Ok(mut queue) = self.inner.lock() else {
            return;
        };
        queue.revision += 1;
        let revision = queue.revision;
        if let Some(entry) = queue.entries.iter_mut().find(|entry| entry.item.id == id) {
            if entry.item.status != RequestStatus::Running {
                return;
            }
            entry.item.progress = Some(progress);
            entry.item.revision = revision;
            (self.observer)(QueueEvent::Progress(Box::new(entry.item.clone())));
        }
    }

    fn finish(&self, id: &str, result: Result<Option<String>, String>, cancelled: bool) {
        let Ok(mut queue) = self.inner.lock() else {
            return;
        };
        let Some(entry) = queue.entries.iter_mut().find(|entry| entry.item.id == id) else {
            return;
        };
        let cancelled = cancelled || entry.task.as_ref().is_some_and(|task| task.is_cancelled());
        entry.task = None;
        entry.item.status = if cancelled {
            RequestStatus::Cancelled
        } else if result.is_ok() {
            RequestStatus::Completed
        } else {
            RequestStatus::Failed
        };
        match result {
            Ok(path) if !cancelled => {
                entry.item.output_path = path;
                entry.item.error = None;
            }
            Err(error) if !cancelled => entry.item.error = Some(error),
            _ => {
                entry.item.output_path = None;
                entry.item.error = None;
            }
        }
        self.changed(&mut queue, &[id.to_string()]);
        drop(queue);
        self.start();
    }
}
