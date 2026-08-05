use std::fmt;

use calamine::XlsxError;
use napi::{Error, Status};

pub type ReaderResult<T> = Result<T, ReaderError>;

#[derive(Debug)]
pub struct ReaderError {
    pub code: &'static str,
    pub message: String,
}

impl ReaderError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn aborted() -> Self {
        Self::new("ABORTED", "The read operation was aborted")
    }

    pub fn into_napi(self) -> Error {
        Error::new(
            Status::GenericFailure,
            format!("[{}] {}", self.code, self.message),
        )
    }
}

impl fmt::Display for ReaderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ReaderError {}

impl From<XlsxError> for ReaderError {
    fn from(error: XlsxError) -> Self {
        let code = match &error {
            XlsxError::Io(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                "SOURCE_NOT_FOUND"
            }
            XlsxError::Io(_) => "IO_ERROR",
            XlsxError::Password => "ENCRYPTED_WORKBOOK",
            XlsxError::WorksheetNotFound(_) => "SHEET_NOT_FOUND",
            XlsxError::NotAWorksheet(_) => "NOT_A_WORKSHEET",
            XlsxError::Alphanumeric(_)
            | XlsxError::NumericColumn(_)
            | XlsxError::RangeWithoutColumnComponent
            | XlsxError::RangeWithoutRowComponent
            | XlsxError::ColumnNumberOverflow
            | XlsxError::RowNumberOverflow => "INVALID_RANGE",
            XlsxError::Zip(_)
            | XlsxError::Xml(_)
            | XlsxError::XmlAttr(_)
            | XlsxError::XmlEof(_)
            | XlsxError::FileNotFound(_)
            | XlsxError::RelationshipNotFound => "CORRUPT_WORKBOOK",
            _ => "PARSE_ERROR",
        };

        Self::new(code, error.to_string())
    }
}

impl From<std::io::Error> for ReaderError {
    fn from(error: std::io::Error) -> Self {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            "SOURCE_NOT_FOUND"
        } else {
            "IO_ERROR"
        };
        Self::new(code, error.to_string())
    }
}
