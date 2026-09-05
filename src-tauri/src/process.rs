use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) const CANCELLED: &str = "Operation cancelled.";

#[derive(Clone, Default)]
pub(crate) struct ProcessState {
    active: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl ProcessState {
    // Reserve before dispatching blocking work, so cancellation also covers preparation and spawn.
    pub fn begin(&self) -> Result<Task, String> {
        let mut active = self.active.lock().map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("Another video operation is already running.".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        *active = Some(Arc::clone(&cancelled));
        Ok(Task {
            state: self.clone(),
            cancelled,
        })
    }

    pub fn cancel(&self) -> Result<(), String> {
        if let Some(cancelled) = self
            .active
            .lock()
            .map_err(|error| error.to_string())?
            .as_ref()
        {
            cancelled.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
}

pub(crate) struct Task {
    state: ProcessState,
    cancelled: Arc<AtomicBool>,
}

impl Task {
    pub fn run(
        &self,
        command: &mut Command,
        label: &str,
        timeout: Option<Duration>,
        on_stdout: impl FnMut(&str) + Send,
    ) -> Result<ProcessOutput, String> {
        run(command, label, timeout, &self.cancelled, on_stdout)
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active.lock() {
            *active = None;
        }
    }
}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    pub status: ExitStatus,
    pub stderr: Vec<u8>,
}

pub(crate) fn run(
    command: &mut Command,
    label: &str,
    timeout: Option<Duration>,
    cancelled: &AtomicBool,
    mut on_stdout: impl FnMut(&str) + Send,
) -> Result<ProcessOutput, String> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(CANCELLED.to_string());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process =
        ProcessTree::spawn(command).map_err(|error| format!("Failed to start {label}: {error}"))?;
    let stdout = process.child.stdout.take().expect("stdout was piped");
    let mut stderr = process.child.stderr.take().expect("stderr was piped");
    thread::scope(|scope| {
        // Drain both pipes while the child runs, including during version probes.
        let stdout_reader = scope.spawn(move || -> Result<(), String> {
            for line in BufReader::new(stdout).lines() {
                on_stdout(&line.map_err(|error| error.to_string())?);
            }
            Ok(())
        });
        let stderr_reader = scope.spawn(move || {
            let mut bytes = Vec::new();
            stderr
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|error| error.to_string())
        });
        let started = Instant::now();
        let status = loop {
            if cancelled.load(Ordering::Relaxed) {
                break Err(CANCELLED.to_string());
            }
            if let Some(timeout) = timeout {
                if started.elapsed() >= timeout {
                    break Err(format!(
                        "{label} timed out after {} seconds.",
                        timeout.as_secs()
                    ));
                }
            }
            match process.child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(25)),
                Err(error) => break Err(format!("Failed to wait for {label}: {error}")),
            }
        };
        // Close the process tree before joining readers: descendants may still hold pipe handles.
        drop(process);
        let stdout_result = stdout_reader
            .join()
            .map_err(|_| format!("{label} stdout reader panicked"));
        let stderr_result = stderr_reader
            .join()
            .map_err(|_| format!("{label} stderr reader panicked"));
        let status = status?;
        stdout_result??;
        let stderr = stderr_result??;
        Ok(ProcessOutput { status, stderr })
    })
}

struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    job: Option<windows::Job>,
}

impl ProcessTree {
    fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let job = {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
            command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
            windows::Job::new()?
        };
        let child = command.spawn().map_err(|error| error.to_string())?;
        let process = Self {
            child,
            #[cfg(windows)]
            job: Some(job),
        };
        #[cfg(windows)]
        process
            .job
            .as_ref()
            .expect("new job")
            .attach_and_resume(&process.child)?;
        Ok(process)
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.job.take());
        #[cfg(unix)]
        {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{}", self.child.id())])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod windows {
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Child,
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    pub(super) struct Job(OwnedHandle);

    impl Job {
        pub fn new() -> Result<Self, String> {
            // All handles are private, non-inheritable, and closed by OwnedHandle.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let result = unsafe {
                SetInformationJobObject(
                    job.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if result == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(job)
        }

        pub fn attach_and_resume(&self, child: &Child) -> Result<(), String> {
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            // The primary thread is suspended until assignment, so no descendant can escape the job.
            // Stable Rust does not expose its handle; find the thread belonging to this new process.
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
            if snapshot == INVALID_HANDLE_VALUE {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
            let mut entry = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
            while present != 0 {
                if entry.th32OwnerProcessID == child.id() {
                    let handle =
                        unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                    if handle.is_null() {
                        return Err(std::io::Error::last_os_error().to_string());
                    }
                    let thread = unsafe { OwnedHandle::from_raw_handle(handle) };
                    if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                        return Err(std::io::Error::last_os_error().to_string());
                    }
                    return Ok(());
                }
                present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
            }
            Err("Could not find the suspended tool process thread.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, sync::mpsc};

    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "process::tests::subprocess_fixture",
            "--nocapture",
        ]);
        command.env("YT_DLP_TEST_PROCESS", mode);
        command
    }

    #[test]
    fn subprocess_fixture() {
        let Ok(mode) = std::env::var("YT_DLP_TEST_PROCESS") else {
            return;
        };
        match mode.as_str() {
            "output" => {
                for _ in 0..4096 {
                    println!("fixture-output-abcdefghijklmnopqrstuvwxyz");
                    eprintln!("fixture-error-abcdefghijklmnopqrstuvwxyz");
                }
            }
            "sleep" => {
                println!("fixture-ready");
                std::io::stdout().flush().unwrap();
                thread::sleep(Duration::from_secs(30));
            }
            "descendant" => {
                let _child = fixture("sleep").spawn().unwrap();
                println!("fixture-descendant-started");
            }
            "failure" => {
                eprintln!("fixture failure");
                std::process::exit(7);
            }
            _ => panic!("Unknown fixture mode"),
        }
    }

    #[test]
    fn cancellation_before_spawn_is_retained_and_does_not_cancel_the_next_task() {
        let state = ProcessState::default();
        let task = state.begin().unwrap();
        assert!(state.begin().is_err());
        state.cancel().unwrap();
        let result = task.run(
            &mut Command::new("nonexistent-cancelled-tool"),
            "test",
            None,
            |_| {},
        );
        assert_eq!(result.unwrap_err(), CANCELLED);
        drop(task);
        let next = state.begin().unwrap();
        let result = next
            .run(
                &mut fixture("failure"),
                "test",
                Some(Duration::from_secs(10)),
                |_| {},
            )
            .unwrap();
        assert_eq!(result.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&result.stderr).contains("fixture failure"));
    }

    #[test]
    fn spawn_failure_releases_the_task_reservation() {
        let state = ProcessState::default();
        assert!(state
            .begin()
            .unwrap()
            .run(
                &mut Command::new("nonexistent-test-tool"),
                "test",
                None,
                |_| {}
            )
            .is_err());
        assert!(state.begin().is_ok());
    }

    #[test]
    fn output_larger_than_pipe_capacity_is_drained_while_running() {
        let mut lines = 0;
        let output = ProcessState::default()
            .begin()
            .unwrap()
            .run(
                &mut fixture("output"),
                "test",
                Some(Duration::from_secs(10)),
                |line| {
                    if line.starts_with("fixture-output-") {
                        lines += 1;
                    }
                },
            )
            .unwrap();
        assert!(output.status.success());
        assert_eq!(lines, 4096);
        assert!(output.stderr.len() > 64 * 1024);
    }

    #[test]
    fn running_process_can_be_cancelled_and_reaped() {
        let state = ProcessState::default();
        let task = state.begin().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let result = task.run(
                &mut fixture("sleep"),
                "test",
                Some(Duration::from_secs(10)),
                |line| {
                    if line == "fixture-ready" {
                        ready_tx.send(()).unwrap();
                    }
                },
            );
            drop(task);
            done_tx.send(result).unwrap();
        });
        let ready = ready_rx.recv_timeout(Duration::from_secs(5));
        state.cancel().unwrap();
        assert!(ready.is_ok());
        assert_eq!(
            done_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err(),
            CANCELLED
        );
        worker.join().unwrap();
        assert!(state.begin().is_ok());
    }

    #[test]
    fn timeout_and_parent_exit_close_descendant_pipe_handles() {
        let state = ProcessState::default();
        let started = Instant::now();
        let result = state.begin().unwrap().run(
            &mut fixture("sleep"),
            "metadata",
            Some(Duration::from_millis(200)),
            |_| {},
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
        let started = Instant::now();
        let result = state
            .begin()
            .unwrap()
            .run(
                &mut fixture("descendant"),
                "metadata",
                Some(Duration::from_secs(5)),
                |_| {},
            )
            .unwrap();
        assert!(result.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
