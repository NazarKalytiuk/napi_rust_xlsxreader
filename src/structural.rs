use std::io::{Read, Seek};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use calamine::Xlsx;
use napi::bindgen_prelude::{Either, Null, Task};
use napi::{Env, Result};
use napi_derive::napi;

use crate::error::{ReaderError, ReaderResult};
use crate::range::dimensions_to_a1;
use crate::source::{open_buffer, open_path, WorkbookSource};

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct HyperlinkMetadata {
    pub range: String,
    pub target: Either<String, Null>,
    pub location: Either<String, Null>,
    pub displayed_text: Either<String, Null>,
    pub tooltip: Either<String, Null>,
}

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct StructuralMetadata {
    pub merged_ranges: Vec<String>,
    pub hyperlinks: Vec<HyperlinkMetadata>,
}

pub struct StructuralMetadataTask {
    pub source: WorkbookSource,
    pub sheet_name: String,
    pub cancelled: Arc<AtomicBool>,
}

#[napi]
impl Task for StructuralMetadataTask {
    type Output = StructuralMetadata;
    type JsValue = StructuralMetadata;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(ReaderError::aborted().into_napi());
        }

        read_structural_metadata(&self.source, &self.sheet_name, &self.cancelled)
            .map_err(ReaderError::into_napi)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn read_structural_metadata(
    source: &WorkbookSource,
    sheet_name: &str,
    cancelled: &AtomicBool,
) -> ReaderResult<StructuralMetadata> {
    match source {
        WorkbookSource::Path(path) => {
            let mut workbook = open_path(path)?;
            read_from_workbook(&mut workbook, sheet_name, cancelled)
        }
        WorkbookSource::Buffer(bytes) => {
            let mut workbook = open_buffer(Arc::clone(bytes))?;
            read_from_workbook(&mut workbook, sheet_name, cancelled)
        }
    }
}

fn read_from_workbook<RS>(
    workbook: &mut Xlsx<RS>,
    sheet_name: &str,
    cancelled: &AtomicBool,
) -> ReaderResult<StructuralMetadata>
where
    RS: Read + Seek,
{
    let merged_ranges = workbook
        .merge_cells_by_sheet_name(sheet_name)
        .map_err(ReaderError::from)?
        .into_iter()
        .map(dimensions_to_a1)
        .collect();

    if cancelled.load(Ordering::Acquire) {
        return Err(ReaderError::aborted());
    }

    let hyperlinks = workbook
        .hyperlinks_by_sheet_name(sheet_name)
        .map_err(ReaderError::from)?
        .into_iter()
        .map(|link| HyperlinkMetadata {
            range: dimensions_to_a1(link.range),
            target: nullable(link.target),
            location: nullable(link.location),
            displayed_text: nullable(link.displayed_text),
            tooltip: nullable(link.tooltip),
        })
        .collect();

    Ok(StructuralMetadata {
        merged_ranges,
        hyperlinks,
    })
}

fn nullable(value: Option<String>) -> Either<String, Null> {
    match value {
        Some(value) => Either::A(value),
        None => Either::B(Null),
    }
}
