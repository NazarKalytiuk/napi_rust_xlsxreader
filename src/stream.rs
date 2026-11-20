use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Either, Null, Task};
use napi::{Env, Result};
use napi_derive::napi;

use crate::error::{ReaderError, ReaderResult};
use crate::reader::{ParsedReadOptions, ReadOptions, produce_rows};
use crate::source::WorkbookSource;
use crate::worksheet::Rows;

pub const DEFAULT_BATCH_SIZE: u32 = 4_096;
pub const MAX_BATCH_SIZE: u32 = 65_536;

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct StreamOptions {
    pub range: Option<String>,
    pub formula_mode: Option<String>,
    pub date_mode: Option<String>,
    pub batch_size: Option<u32>,
}

struct ParsedStreamOptions {
    read: ParsedReadOptions,
    batch_size: usize,
}

impl ParsedStreamOptions {
    fn parse(options: Option<StreamOptions>) -> ReaderResult<Self> {
        let options = options.unwrap_or_default();
        let batch_size = options.batch_size.unwrap_or(DEFAULT_BATCH_SIZE);
        if !(1..=MAX_BATCH_SIZE).contains(&batch_size) {
            return Err(ReaderError::new(
                "INVALID_OPTION",
                format!("batchSize must be between 1 and {MAX_BATCH_SIZE}; received {batch_size}"),
            ));
        }

        Ok(Self {
            read: ParsedReadOptions::parse(Some(ReadOptions {
                range: options.range,
                formula_mode: options.formula_mode,
                date_mode: options.date_mode,
            }))?,
            batch_size: batch_size as usize,
        })
    }
}

enum StreamMessage {
    Batch(Rows),
    Error(ReaderError),
    End,
}

/// How often a waiting thread re-checks `Shared::cancelled`; see [`Shared`].
const CANCEL_POLL: Duration = Duration::from_millis(50);

/// What a cursor's row thread and its `next_batch` and `close` tasks share.
///
/// The JavaScript thread never waits for a lock another thread can hold: a
/// browser's main thread cannot block, and `Atomics.wait` throwing there aborts
/// the WebAssembly instance. So `state` is locked only by the row thread and by
/// the tasks, which run on the async-work pool. The JavaScript thread, in
/// `close()` and when a cursor is garbage collected, only sets `cancelled` and
/// wakes the waiters, which `Condvar::notify_all` does without the lock.
/// Because that wake-up can come between a waiter's check of `cancelled` and
/// its wait, the waits re-check the flag every [`CANCEL_POLL`].
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    cancelled: AtomicBool,
}

#[derive(Default)]
struct State {
    /// The message `next_batch` takes next. The row thread waits while it is
    /// full, so it stays at most one batch ahead of JavaScript.
    message: Option<StreamMessage>,
    /// The row thread has returned.
    worker_done: bool,
    /// `next_batch` has returned the end, an error, or an abort; later calls
    /// return null.
    exhausted: bool,
}

impl Shared {
    fn lock(&self) -> Result<MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| {
            ReaderError::new("INTERNAL_ERROR", "Row cursor lock was poisoned").into_napi()
        })
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Safe on the JavaScript thread: it takes no lock.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.changed.notify_all();
    }

    fn wait<'a>(&self, guard: MutexGuard<'a, State>) -> Result<MutexGuard<'a, State>> {
        match self.changed.wait_timeout(guard, CANCEL_POLL) {
            Ok((guard, _)) => Ok(guard),
            Err(_) => {
                Err(ReaderError::new("INTERNAL_ERROR", "Row cursor lock was poisoned").into_napi())
            }
        }
    }
}

#[napi]
pub struct RuscRowCursor {
    shared: Arc<Shared>,
    next_lock: Arc<Mutex<()>>,
}

impl RuscRowCursor {
    pub(crate) fn spawn(
        source: WorkbookSource,
        sheet_name: String,
        epoch: u16,
        options: Option<StreamOptions>,
    ) -> ReaderResult<Self> {
        let options = ParsedStreamOptions::parse(options)?;
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            cancelled: AtomicBool::new(false),
        });
        let worker_shared = Arc::clone(&shared);

        thread::Builder::new()
            .name(format!("rusc-xlsx-reader-{sheet_name}"))
            .spawn(move || {
                run_worker(source, sheet_name, epoch, options, &worker_shared);
                // A poisoned lock means a panic, which already ended the stream.
                if let Ok(mut state) = worker_shared.state.lock() {
                    state.worker_done = true;
                }
                worker_shared.changed.notify_all();
            })
            .map_err(ReaderError::from)?;

        Ok(Self {
            shared,
            next_lock: Arc::new(Mutex::new(())),
        })
    }
}

impl Drop for RuscRowCursor {
    fn drop(&mut self) {
        // Runs on the JavaScript thread when the cursor is garbage collected.
        self.shared.cancel();
    }
}

#[napi]
impl RuscRowCursor {
    #[napi]
    pub fn next_batch(&self) -> AsyncTask<NextBatchTask> {
        AsyncTask::new(NextBatchTask {
            shared: Arc::clone(&self.shared),
            next_lock: Arc::clone(&self.next_lock),
        })
    }

    #[napi]
    pub fn close(&self) -> AsyncTask<CloseCursorTask> {
        self.shared.cancel();
        AsyncTask::new(CloseCursorTask {
            shared: Arc::clone(&self.shared),
        })
    }
}

pub struct NextBatchTask {
    shared: Arc<Shared>,
    next_lock: Arc<Mutex<()>>,
}

#[napi]
impl Task for NextBatchTask {
    type Output = Either<Rows, Null>;
    type JsValue = Either<Rows, Null>;

    fn compute(&mut self) -> Result<Self::Output> {
        // Calls made before an earlier one returned get their batches in order.
        let _guard = self.next_lock.lock().map_err(|_| {
            ReaderError::new("INTERNAL_ERROR", "Row cursor lock was poisoned").into_napi()
        })?;

        let shared = &self.shared;
        let mut state = shared.lock()?;
        loop {
            if state.exhausted {
                return Ok(Either::B(Null));
            }
            if let Some(message) = state.message.take() {
                shared.changed.notify_all();
                return match message {
                    StreamMessage::Batch(rows) => Ok(Either::A(rows)),
                    StreamMessage::Error(error) => {
                        state.exhausted = true;
                        Err(error.into_napi())
                    }
                    StreamMessage::End => {
                        state.exhausted = true;
                        Ok(Either::B(Null))
                    }
                };
            }
            if shared.cancelled() {
                state.exhausted = true;
                return Err(ReaderError::aborted().into_napi());
            }
            if state.worker_done {
                state.exhausted = true;
                return Err(ReaderError::new(
                    "STREAM_ERROR",
                    "Row worker stopped before signaling completion",
                )
                .into_napi());
            }
            state = shared.wait(state)?;
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CloseCursorTask {
    shared: Arc<Shared>,
}

#[napi]
impl Task for CloseCursorTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let shared = &self.shared;
        let mut state = shared.lock()?;
        // Under the lock this wake-up cannot be missed, unlike the one close()
        // sent from the JavaScript thread.
        shared.changed.notify_all();
        while !state.worker_done {
            state = shared.wait(state)?;
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

fn run_worker(
    source: WorkbookSource,
    sheet_name: String,
    epoch: u16,
    options: ParsedStreamOptions,
    shared: &Shared,
) {
    let mut batch = Vec::with_capacity(options.batch_size);
    let result = produce_rows(
        &source,
        &sheet_name,
        epoch,
        &options.read,
        &shared.cancelled,
        |row| {
            batch.push(row);
            if batch.len() == options.batch_size {
                let ready = std::mem::replace(&mut batch, Vec::with_capacity(options.batch_size));
                send_message(shared, StreamMessage::Batch(ready))?;
            }
            Ok(())
        },
    );

    match result {
        Ok(()) => {
            if !batch.is_empty() && send_message(shared, StreamMessage::Batch(batch)).is_err() {
                return;
            }
            let _ = send_message(shared, StreamMessage::End);
        }
        Err(_) if shared.cancelled() => {}
        Err(error) => {
            let _ = send_message(shared, StreamMessage::Error(error));
        }
    }
}

/// Hands `message` to `next_batch` once the previous one was taken.
fn send_message(shared: &Shared, message: StreamMessage) -> ReaderResult<()> {
    let poisoned = || ReaderError::new("INTERNAL_ERROR", "Row cursor lock was poisoned");
    let mut state = shared.state.lock().map_err(|_| poisoned())?;
    loop {
        if shared.cancelled() {
            return Err(ReaderError::aborted());
        }
        if state.message.is_none() {
            state.message = Some(message);
            shared.changed.notify_all();
            return Ok(());
        }
        state = shared
            .changed
            .wait_timeout(state, CANCEL_POLL)
            .map_err(|_| poisoned())?
            .0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch_size(value: Option<u32>) -> ReaderResult<usize> {
        ParsedStreamOptions::parse(Some(StreamOptions {
            batch_size: value,
            ..StreamOptions::default()
        }))
        .map(|options| options.batch_size)
    }

    #[test]
    fn defaults_and_bounds_the_batch_size() {
        assert_eq!(
            ParsedStreamOptions::parse(None).unwrap().batch_size,
            DEFAULT_BATCH_SIZE as usize
        );
        assert_eq!(batch_size(None).unwrap(), DEFAULT_BATCH_SIZE as usize);
        assert_eq!(batch_size(Some(1)).unwrap(), 1);
        assert_eq!(
            batch_size(Some(MAX_BATCH_SIZE)).unwrap(),
            MAX_BATCH_SIZE as usize
        );
        for value in [0, MAX_BATCH_SIZE + 1] {
            assert_eq!(batch_size(Some(value)).unwrap_err().code, "INVALID_OPTION");
        }
    }

    #[test]
    fn validates_the_shared_read_options() {
        let error = ParsedStreamOptions::parse(Some(StreamOptions {
            range: Some("B2:A1".to_owned()),
            ..StreamOptions::default()
        }))
        .err()
        .unwrap();
        assert_eq!(error.code, "INVALID_RANGE");

        let error = ParsedStreamOptions::parse(Some(StreamOptions {
            date_mode: Some("calendar".to_owned()),
            ..StreamOptions::default()
        }))
        .err()
        .unwrap();
        assert_eq!(error.code, "INVALID_OPTION");
    }
}
