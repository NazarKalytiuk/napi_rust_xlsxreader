use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Task};
use napi::{Env, Result};
use napi_derive::napi;

use crate::error::ReaderError;
use crate::reader::{ParsedReadOptions, ReadOptions, collect_rows};
use crate::source::WorkbookSource;
use crate::stream::{RuscRowCursor, StreamOptions};
use crate::structural::StructuralMetadataTask;
use crate::value::CellValue;
use crate::workbook::SheetMetadata;

pub type Rows = Vec<Vec<CellValue>>;

#[napi]
pub struct RuscWorksheet {
    pub(crate) source: WorkbookSource,
    metadata: SheetMetadata,
    pub(crate) epoch: u16,
}

impl RuscWorksheet {
    pub(crate) fn new(source: WorkbookSource, metadata: SheetMetadata, epoch: u16) -> Self {
        Self {
            source,
            metadata,
            epoch,
        }
    }
}

#[napi]
impl RuscWorksheet {
    #[napi(getter)]
    pub fn metadata(&self) -> SheetMetadata {
        self.metadata.clone()
    }

    #[napi]
    pub fn read_rows(
        &self,
        options: Option<ReadOptions>,
        signal: Option<AbortSignal>,
    ) -> Result<AsyncTask<ReadRowsTask>> {
        let options = ParsedReadOptions::parse(options).map_err(ReaderError::into_napi)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(signal) = signal.as_ref() {
            let cancelled = Arc::clone(&cancelled);
            signal.on_abort(move || cancelled.store(true, Ordering::Release));
        }

        Ok(AsyncTask::with_optional_signal(
            ReadRowsTask {
                source: self.source.clone(),
                sheet_name: self.metadata.name.clone(),
                epoch: self.epoch,
                options,
                cancelled,
            },
            signal,
        ))
    }

    #[napi]
    pub fn create_row_cursor(&self, options: Option<StreamOptions>) -> Result<RuscRowCursor> {
        RuscRowCursor::spawn(
            self.source.clone(),
            self.metadata.name.clone(),
            self.epoch,
            options,
        )
        .map_err(ReaderError::into_napi)
    }

    #[napi]
    pub fn structural_metadata(
        &self,
        signal: Option<AbortSignal>,
    ) -> AsyncTask<StructuralMetadataTask> {
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Some(signal) = signal.as_ref() {
            let cancelled = Arc::clone(&cancelled);
            signal.on_abort(move || cancelled.store(true, Ordering::Release));
        }

        AsyncTask::with_optional_signal(
            StructuralMetadataTask {
                source: self.source.clone(),
                sheet_name: self.metadata.name.clone(),
                cancelled,
            },
            signal,
        )
    }
}

pub struct ReadRowsTask {
    source: WorkbookSource,
    sheet_name: String,
    epoch: u16,
    options: ParsedReadOptions,
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl Task for ReadRowsTask {
    type Output = Rows;
    type JsValue = Rows;

    fn compute(&mut self) -> Result<Self::Output> {
        collect_rows(
            &self.source,
            &self.sheet_name,
            self.epoch,
            &self.options,
            &self.cancelled,
        )
        .map_err(ReaderError::into_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
