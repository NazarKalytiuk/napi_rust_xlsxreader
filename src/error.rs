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

// Calamine only ever parses workbook contents here: user-supplied ranges are
// parsed by `CellRange` and sheet selectors are resolved against the opened
// metadata before calamine is called. A calamine reference or lookup failure
// therefore describes a malformed package, never invalid caller input.
impl From<XlsxError> for ReaderError {
    fn from(error: XlsxError) -> Self {
        let code = match &error {
            XlsxError::Io(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
                "SOURCE_NOT_FOUND"
            }
            XlsxError::Io(_) => "IO_ERROR",
            XlsxError::Password => "ENCRYPTED_WORKBOOK",
            XlsxError::NotAWorksheet(_) => "NOT_A_WORKSHEET",
            XlsxError::Zip(_)
            | XlsxError::Xml(_)
            | XlsxError::XmlAttr(_)
            | XlsxError::XmlEof(_)
            | XlsxError::FileNotFound(_)
            | XlsxError::RelationshipNotFound
            | XlsxError::WorksheetNotFound(_)
            | XlsxError::Alphanumeric(_)
            | XlsxError::NumericColumn(_)
            | XlsxError::RangeWithoutColumnComponent
            | XlsxError::RangeWithoutRowComponent
            | XlsxError::ColumnNumberOverflow
            | XlsxError::RowNumberOverflow
            | XlsxError::DimensionCount(_) => "CORRUPT_WORKBOOK",
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

#[cfg(test)]
mod tests {
    use std::io::{Error as IoError, ErrorKind};

    use super::*;

    fn code(error: XlsxError) -> &'static str {
        ReaderError::from(error).code
    }

    #[test]
    fn maps_calamine_errors_to_public_codes() {
        assert_eq!(
            code(XlsxError::Io(IoError::from(ErrorKind::NotFound))),
            "SOURCE_NOT_FOUND"
        );
        assert_eq!(
            code(XlsxError::Io(IoError::from(ErrorKind::PermissionDenied))),
            "IO_ERROR"
        );
        assert_eq!(code(XlsxError::Password), "ENCRYPTED_WORKBOOK");
        assert_eq!(
            code(XlsxError::NotAWorksheet("chartsheet".to_owned())),
            "NOT_A_WORKSHEET"
        );
        assert_eq!(
            code(XlsxError::CellError("#SPILL!".to_owned())),
            "PARSE_ERROR"
        );
    }

    #[test]
    fn classifies_malformed_package_contents_as_corrupt() {
        for error in [
            XlsxError::XmlEof("sheetData"),
            XlsxError::FileNotFound("xl/workbook.xml".to_owned()),
            XlsxError::RelationshipNotFound,
            XlsxError::WorksheetNotFound("Data".to_owned()),
            XlsxError::Alphanumeric(b'#'),
            XlsxError::NumericColumn(b'1'),
            XlsxError::RangeWithoutColumnComponent,
            XlsxError::RangeWithoutRowComponent,
            XlsxError::ColumnNumberOverflow,
            XlsxError::RowNumberOverflow,
            XlsxError::DimensionCount(3),
        ] {
            let description = format!("{error:?}");
            assert_eq!(code(error), "CORRUPT_WORKBOOK", "{description}");
        }
    }

    #[test]
    fn maps_io_errors_to_public_codes() {
        assert_eq!(
            ReaderError::from(IoError::from(ErrorKind::NotFound)).code,
            "SOURCE_NOT_FOUND"
        );
        assert_eq!(
            ReaderError::from(IoError::from(ErrorKind::PermissionDenied)).code,
            "IO_ERROR"
        );
    }

    #[test]
    fn prefixes_messages_with_the_code_for_the_javascript_facade() {
        let error = ReaderError::new("INVALID_RANGE", "bad range");
        assert_eq!(error.to_string(), "[INVALID_RANGE] bad range");
        assert_eq!(error.into_napi().reason, "[INVALID_RANGE] bad range");
        assert_eq!(ReaderError::aborted().code, "ABORTED");
    }
}
