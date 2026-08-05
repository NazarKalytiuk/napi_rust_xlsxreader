use std::io::{Read, Seek};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use calamine::{Reader, SheetType, SheetVisible, Xlsx};
use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer, Either, Task};
use napi::{Env, Result};
use napi_derive::napi;

use crate::error::{ReaderError, ReaderResult};
use crate::range::CellRange;
use crate::source::{open_buffer, open_path, PendingSource, WorkbookSource};
use crate::worksheet::RuscWorksheet;

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct SheetMetadata {
    pub name: String,
    pub r#type: String,
    pub visibility: String,
    pub declared_range: Option<String>,
}

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct DefinedName {
    pub name: String,
    pub formula: String,
}

pub struct OpenedWorkbook {
    source: WorkbookSource,
    sheets: Vec<SheetMetadata>,
    defined_names: Vec<DefinedName>,
    epoch: u16,
}

#[napi]
pub struct RuscWorkbook {
    pub(crate) source: WorkbookSource,
    sheets: Arc<Vec<SheetMetadata>>,
    defined_names: Arc<Vec<DefinedName>>,
    epoch: u16,
}

#[napi]
impl RuscWorkbook {
    #[napi(getter)]
    pub fn sheets(&self) -> Vec<SheetMetadata> {
        self.sheets.as_ref().clone()
    }

    #[napi(getter)]
    pub fn defined_names(&self) -> Vec<DefinedName> {
        self.defined_names.as_ref().clone()
    }

    #[napi(getter)]
    pub fn epoch(&self) -> u16 {
        self.epoch
    }

    #[napi]
    pub fn worksheet_by_name(&self, name: String) -> Result<RuscWorksheet> {
        let metadata = self
            .sheets
            .iter()
            .find(|sheet| sheet.name == name)
            .cloned()
            .ok_or_else(|| {
                ReaderError::new(
                    "SHEET_NOT_FOUND",
                    format!("Worksheet {name:?} was not found"),
                )
                .into_napi()
            })?;

        Ok(RuscWorksheet::new(
            self.source.clone(),
            metadata,
            self.epoch,
        ))
    }

    #[napi]
    pub fn worksheet_by_index(&self, index: u32) -> Result<RuscWorksheet> {
        let metadata = self.sheets.get(index as usize).cloned().ok_or_else(|| {
            ReaderError::new(
                "SHEET_NOT_FOUND",
                format!("Worksheet index {index} is out of range"),
            )
            .into_napi()
        })?;

        Ok(RuscWorksheet::new(
            self.source.clone(),
            metadata,
            self.epoch,
        ))
    }
}

pub struct OpenWorkbookTask {
    source: Option<PendingSource>,
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl Task for OpenWorkbookTask {
    type Output = OpenedWorkbook;
    type JsValue = RuscWorkbook;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ReaderError::aborted().into_napi());
        }

        let source = self
            .source
            .take()
            .ok_or_else(|| {
                ReaderError::new("INTERNAL_ERROR", "Workbook source was consumed").into_napi()
            })?
            .snapshot()
            .map_err(ReaderError::into_napi)?;

        let (sheets, defined_names, epoch) = match &source {
            WorkbookSource::Path(path) => {
                let mut workbook = open_path(path).map_err(ReaderError::into_napi)?;
                inspect_workbook(&mut workbook, &self.cancelled).map_err(ReaderError::into_napi)?
            }
            WorkbookSource::Buffer(bytes) => {
                let mut workbook =
                    open_buffer(Arc::clone(bytes)).map_err(ReaderError::into_napi)?;
                inspect_workbook(&mut workbook, &self.cancelled).map_err(ReaderError::into_napi)?
            }
        };

        Ok(OpenedWorkbook {
            source,
            sheets,
            defined_names,
            epoch,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(RuscWorkbook {
            source: output.source,
            sheets: Arc::new(output.sheets),
            defined_names: Arc::new(output.defined_names),
            epoch: output.epoch,
        })
    }
}

#[napi]
pub fn open_workbook(
    source: Either<String, Buffer>,
    signal: Option<AbortSignal>,
) -> AsyncTask<OpenWorkbookTask> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = signal.as_ref() {
        let cancelled = Arc::clone(&cancelled);
        signal.on_abort(move || cancelled.store(true, Ordering::Release));
    }

    AsyncTask::with_optional_signal(
        OpenWorkbookTask {
            source: Some(PendingSource::from_js(source)),
            cancelled,
        },
        signal,
    )
}

fn inspect_workbook<RS>(
    workbook: &mut Xlsx<RS>,
    cancelled: &AtomicBool,
) -> ReaderResult<(Vec<SheetMetadata>, Vec<DefinedName>, u16)>
where
    RS: Read + Seek,
{
    let epoch = if workbook.has_1904_epoch() {
        1904
    } else {
        1900
    };
    let backend_sheets = workbook.sheets_metadata().to_vec();
    let mut sheets = Vec::with_capacity(backend_sheets.len());

    for sheet in backend_sheets {
        if cancelled.load(Ordering::Acquire) {
            return Err(ReaderError::aborted());
        }

        let declared_range = if sheet.typ == SheetType::WorkSheet {
            let mut reader = workbook
                .worksheet_cells_reader(&sheet.name)
                .map_err(ReaderError::from)?;
            let dimensions = reader.dimensions();
            if reader.next_cell().map_err(ReaderError::from)?.is_some() {
                Some(CellRange::from_dimensions(dimensions).to_a1())
            } else {
                None
            }
        } else {
            None
        };

        sheets.push(SheetMetadata {
            name: sheet.name,
            r#type: sheet_type(sheet.typ).to_owned(),
            visibility: sheet_visibility(sheet.visible).to_owned(),
            declared_range,
        });
    }

    let defined_names = workbook
        .defined_names()
        .iter()
        .map(|(name, formula)| DefinedName {
            name: name.clone(),
            formula: normalize_formula(formula),
        })
        .collect();

    Ok((sheets, defined_names, epoch))
}

fn sheet_type(value: SheetType) -> &'static str {
    match value {
        SheetType::WorkSheet => "worksheet",
        SheetType::DialogSheet => "dialog",
        SheetType::MacroSheet => "macro",
        SheetType::ChartSheet => "chart",
        SheetType::Vba => "vba",
    }
}

fn sheet_visibility(value: SheetVisible) -> &'static str {
    match value {
        SheetVisible::Visible => "visible",
        SheetVisible::Hidden => "hidden",
        SheetVisible::VeryHidden => "veryHidden",
    }
}

fn normalize_formula(formula: &str) -> String {
    if formula.starts_with('=') {
        formula.to_owned()
    } else {
        format!("={formula}")
    }
}
