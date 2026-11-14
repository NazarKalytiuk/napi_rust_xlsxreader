use std::fs::File;
use std::io::{BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use calamine::{Xlsx, open_workbook, open_workbook_from_rs};
use napi::bindgen_prelude::{Buffer, Either};

use crate::error::{ReaderError, ReaderResult};

#[derive(Clone, Debug)]
pub enum WorkbookSource {
    Path(Arc<PathBuf>),
    Buffer(Arc<[u8]>),
}

pub enum PendingSource {
    Path(PathBuf),
    Buffer(Buffer),
}

impl PendingSource {
    pub fn from_js(source: Either<String, Buffer>) -> Self {
        match source {
            Either::A(path) => Self::Path(PathBuf::from(path)),
            Either::B(buffer) => Self::Buffer(buffer),
        }
    }

    pub fn snapshot(self) -> ReaderResult<WorkbookSource> {
        match self {
            Self::Path(path) => {
                let path = std::fs::canonicalize(&path).map_err(ReaderError::from)?;
                Ok(WorkbookSource::Path(Arc::new(path)))
            }
            Self::Buffer(buffer) => Ok(WorkbookSource::Buffer(Arc::from(buffer.as_ref()))),
        }
    }
}

pub fn open_path(path: &Path) -> ReaderResult<Xlsx<BufReader<File>>> {
    open_workbook(path).map_err(ReaderError::from)
}

pub fn open_buffer(bytes: Arc<[u8]>) -> ReaderResult<Xlsx<Cursor<Arc<[u8]>>>> {
    open_workbook_from_rs(Cursor::new(bytes)).map_err(ReaderError::from)
}
