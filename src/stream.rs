use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crossbeam_channel::{Receiver, Sender, bounded, select};
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

#[napi]
pub struct RuscRowCursor {
    receiver: Receiver<StreamMessage>,
    cancel_sender: Sender<()>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    next_lock: Arc<Mutex<()>>,
    completion: Receiver<()>,
}

impl RuscRowCursor {
    pub(crate) fn spawn(
        source: WorkbookSource,
        sheet_name: String,
        epoch: u16,
        options: Option<StreamOptions>,
    ) -> ReaderResult<Self> {
        let options = ParsedStreamOptions::parse(options)?;
        let (sender, receiver) = bounded(1);
        let (cancel_sender, cancel_receiver) = bounded(1);
        let (completion_sender, completion) = bounded(1);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);

        thread::Builder::new()
            .name(format!("rusc-xlsx-reader-{sheet_name}"))
            .spawn(move || {
                run_worker(
                    source,
                    sheet_name,
                    epoch,
                    options,
                    sender,
                    cancel_receiver,
                    worker_cancelled,
                );
                let _ = completion_sender.send(());
            })
            .map_err(ReaderError::from)?;

        Ok(Self {
            receiver,
            cancel_sender,
            cancelled,
            finished: Arc::new(AtomicBool::new(false)),
            next_lock: Arc::new(Mutex::new(())),
            completion,
        })
    }

    fn request_close(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            let _ = self.cancel_sender.try_send(());
        }
    }
}

impl Drop for RuscRowCursor {
    fn drop(&mut self) {
        self.request_close();
    }
}

#[napi]
impl RuscRowCursor {
    #[napi]
    pub fn next_batch(&self) -> AsyncTask<NextBatchTask> {
        AsyncTask::new(NextBatchTask {
            receiver: self.receiver.clone(),
            cancelled: Arc::clone(&self.cancelled),
            finished: Arc::clone(&self.finished),
            next_lock: Arc::clone(&self.next_lock),
        })
    }

    #[napi]
    pub fn close(&self) -> AsyncTask<CloseCursorTask> {
        self.request_close();
        AsyncTask::new(CloseCursorTask {
            completion: self.completion.clone(),
        })
    }
}

pub struct NextBatchTask {
    receiver: Receiver<StreamMessage>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    next_lock: Arc<Mutex<()>>,
}

#[napi]
impl Task for NextBatchTask {
    type Output = Either<Rows, Null>;
    type JsValue = Either<Rows, Null>;

    fn compute(&mut self) -> Result<Self::Output> {
        let _guard = self.next_lock.lock().map_err(|_| {
            ReaderError::new("INTERNAL_ERROR", "Row cursor lock was poisoned").into_napi()
        })?;

        if self.finished.load(Ordering::Acquire) {
            return Ok(Either::B(Null));
        }

        match self.receiver.recv() {
            Ok(StreamMessage::Batch(rows)) => Ok(Either::A(rows)),
            Ok(StreamMessage::Error(error)) => {
                self.finished.store(true, Ordering::Release);
                Err(error.into_napi())
            }
            Ok(StreamMessage::End) => {
                self.finished.store(true, Ordering::Release);
                Ok(Either::B(Null))
            }
            Err(_) if self.cancelled.load(Ordering::Acquire) => {
                self.finished.store(true, Ordering::Release);
                Err(ReaderError::aborted().into_napi())
            }
            Err(_) => {
                self.finished.store(true, Ordering::Release);
                Err(ReaderError::new(
                    "STREAM_ERROR",
                    "Row worker stopped before signaling completion",
                )
                .into_napi())
            }
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct CloseCursorTask {
    completion: Receiver<()>,
}

#[napi]
impl Task for CloseCursorTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        let _ = self.completion.recv();
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
    sender: Sender<StreamMessage>,
    cancel_receiver: Receiver<()>,
    cancelled: Arc<AtomicBool>,
) {
    let mut batch = Vec::with_capacity(options.batch_size);
    let result = produce_rows(
        &source,
        &sheet_name,
        epoch,
        &options.read,
        &cancelled,
        |row| {
            batch.push(row);
            if batch.len() == options.batch_size {
                let ready = std::mem::replace(&mut batch, Vec::with_capacity(options.batch_size));
                send_message(&sender, &cancel_receiver, StreamMessage::Batch(ready))?;
            }
            Ok(())
        },
    );

    match result {
        Ok(()) => {
            if !batch.is_empty()
                && send_message(&sender, &cancel_receiver, StreamMessage::Batch(batch)).is_err()
            {
                return;
            }
            let _ = send_message(&sender, &cancel_receiver, StreamMessage::End);
        }
        Err(error) if cancelled.load(Ordering::Acquire) => {
            let _ = error;
        }
        Err(error) => {
            let _ = send_message(&sender, &cancel_receiver, StreamMessage::Error(error));
        }
    }
}

fn send_message(
    sender: &Sender<StreamMessage>,
    cancel_receiver: &Receiver<()>,
    message: StreamMessage,
) -> ReaderResult<()> {
    select! {
        send(sender, message) -> result => result.map_err(|_| ReaderError::aborted()),
        recv(cancel_receiver) -> _ => Err(ReaderError::aborted()),
    }
}
