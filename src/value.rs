use calamine::{CellErrorType, DataRef, ExcelDateTime};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use napi::bindgen_prelude::{Either, Either8, Null};
use napi_derive::napi;

use crate::error::{ReaderError, ReaderResult};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FormulaMode {
    Value,
    Formula,
    Both,
}

impl FormulaMode {
    pub fn parse(value: Option<&str>) -> ReaderResult<Self> {
        match value.unwrap_or("value") {
            "value" => Ok(Self::Value),
            "formula" => Ok(Self::Formula),
            "both" => Ok(Self::Both),
            other => Err(ReaderError::new(
                "INVALID_OPTION",
                format!("formulaMode must be value, formula, or both; received {other:?}"),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DateMode {
    Object,
    Serial,
    Iso,
    JsDate,
}

impl DateMode {
    pub fn parse(value: Option<&str>) -> ReaderResult<Self> {
        match value.unwrap_or("object") {
            "object" => Ok(Self::Object),
            "serial" => Ok(Self::Serial),
            "iso" => Ok(Self::Iso),
            "jsDate" => Ok(Self::JsDate),
            other => Err(ReaderError::new(
                "INVALID_OPTION",
                format!("dateMode must be object, serial, iso, or jsDate; received {other:?}"),
            )),
        }
    }
}

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct DateTimeValue {
    pub r#type: String,
    pub serial: Either<f64, Null>,
    pub iso: Either<String, Null>,
    pub epoch: Either<u16, Null>,
}

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct DurationValue {
    pub r#type: String,
    pub serial: Either<f64, Null>,
    pub iso: Either<String, Null>,
}

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct ErrorValue {
    pub r#type: String,
    pub code: String,
}

pub type BaseCellValue =
    Either8<String, f64, bool, NaiveDateTime, DateTimeValue, DurationValue, ErrorValue, Null>;

#[napi(object, object_from_js = false)]
#[derive(Clone, Debug)]
pub struct FormulaValue {
    pub r#type: String,
    pub formula: String,
    pub value: BaseCellValue,
}

pub type CellValue = Either<BaseCellValue, FormulaValue>;

pub fn convert_data(value: DataRef<'_>, date_mode: DateMode, epoch: u16) -> BaseCellValue {
    match value {
        DataRef::Int(value) => BaseCellValue::B(value as f64),
        DataRef::Float(value) => BaseCellValue::B(value),
        DataRef::String(value) => BaseCellValue::A(value),
        DataRef::SharedString(value) => BaseCellValue::A(value.to_owned()),
        DataRef::Bool(value) => BaseCellValue::C(value),
        DataRef::DateTime(value) => convert_serial_datetime(value, date_mode, epoch),
        DataRef::DateTimeIso(value) => convert_iso_datetime(value, date_mode),
        DataRef::DurationIso(value) => convert_iso_duration(value, date_mode),
        DataRef::Error(value) => BaseCellValue::G(ErrorValue {
            r#type: "error".to_owned(),
            code: error_code(value).to_owned(),
        }),
        DataRef::Empty => BaseCellValue::H(Null),
    }
}

pub fn wrap_formula(value: BaseCellValue, formula: Option<String>, mode: FormulaMode) -> CellValue {
    match (mode, formula) {
        (FormulaMode::Formula, Some(formula)) => {
            CellValue::A(BaseCellValue::A(normalize_formula(formula)))
        }
        (FormulaMode::Both, Some(formula)) => CellValue::B(FormulaValue {
            r#type: "formula".to_owned(),
            formula: normalize_formula(formula),
            value,
        }),
        _ => CellValue::A(value),
    }
}

pub fn null_cell() -> CellValue {
    CellValue::A(BaseCellValue::H(Null))
}

fn convert_serial_datetime(value: ExcelDateTime, mode: DateMode, epoch: u16) -> BaseCellValue {
    let serial = value.as_f64();

    if value.is_duration() {
        let iso = duration_to_iso(serial);
        return match mode {
            DateMode::Serial => BaseCellValue::B(serial),
            DateMode::Iso if iso.is_some() => BaseCellValue::A(iso.unwrap()),
            _ => BaseCellValue::F(DurationValue {
                r#type: "duration".to_owned(),
                serial: Either::A(serial),
                iso: option_string(iso),
            }),
        };
    }

    let datetime = value.as_datetime();
    let iso = datetime.map(format_naive_datetime);

    match mode {
        DateMode::Serial => BaseCellValue::B(serial),
        DateMode::Iso if iso.is_some() => BaseCellValue::A(iso.unwrap()),
        DateMode::JsDate if datetime.is_some() => BaseCellValue::D(datetime.unwrap()),
        _ => BaseCellValue::E(DateTimeValue {
            r#type: "datetime".to_owned(),
            serial: Either::A(serial),
            iso: option_string(iso),
            epoch: Either::A(epoch),
        }),
    }
}

fn convert_iso_datetime(value: String, mode: DateMode) -> BaseCellValue {
    match mode {
        DateMode::Serial | DateMode::Iso => BaseCellValue::A(value),
        DateMode::JsDate => match parse_iso_datetime(&value) {
            Some(datetime) => BaseCellValue::D(datetime),
            None => tagged_iso_datetime(value),
        },
        DateMode::Object => tagged_iso_datetime(value),
    }
}

fn tagged_iso_datetime(value: String) -> BaseCellValue {
    BaseCellValue::E(DateTimeValue {
        r#type: "datetime".to_owned(),
        serial: Either::B(Null),
        iso: Either::A(value),
        epoch: Either::B(Null),
    })
}

fn convert_iso_duration(value: String, mode: DateMode) -> BaseCellValue {
    match mode {
        DateMode::Serial | DateMode::Iso => BaseCellValue::A(value),
        DateMode::Object | DateMode::JsDate => BaseCellValue::F(DurationValue {
            r#type: "duration".to_owned(),
            serial: Either::B(Null),
            iso: Either::A(value),
        }),
    }
}

fn normalize_formula(formula: String) -> String {
    match formula.strip_prefix('=') {
        Some(without_prefix) => format!("={without_prefix}"),
        None => format!("={formula}"),
    }
}

fn error_code(error: CellErrorType) -> &'static str {
    match error {
        CellErrorType::Div0 => "#DIV/0!",
        CellErrorType::NA => "#N/A",
        CellErrorType::Name => "#NAME?",
        CellErrorType::Null => "#NULL!",
        CellErrorType::Num => "#NUM!",
        CellErrorType::Ref => "#REF!",
        CellErrorType::Value => "#VALUE!",
        CellErrorType::GettingData => "#DATA!",
    }
}

fn format_naive_datetime(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

fn parse_iso_datetime(value: &str) -> Option<NaiveDateTime> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value.naive_utc());
    }

    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(value) = NaiveDateTime::parse_from_str(value, format) {
            return Some(value);
        }
    }

    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
}

fn duration_to_iso(serial_days: f64) -> Option<String> {
    if !serial_days.is_finite() {
        return None;
    }

    let negative = serial_days.is_sign_negative();
    let total_millis = (serial_days.abs() * 86_400_000.0).round();
    if total_millis > u64::MAX as f64 {
        return None;
    }

    let mut remaining = total_millis as u64;
    let days = remaining / 86_400_000;
    remaining %= 86_400_000;
    let hours = remaining / 3_600_000;
    remaining %= 3_600_000;
    let minutes = remaining / 60_000;
    remaining %= 60_000;
    let seconds = remaining / 1_000;
    let millis = remaining % 1_000;

    let sign = if negative { "-" } else { "" };
    let seconds = if millis == 0 {
        seconds.to_string()
    } else {
        format!("{seconds}.{millis:03}")
    };

    Some(format!("{sign}P{days}DT{hours}H{minutes}M{seconds}S"))
}

fn option_string(value: Option<String>) -> Either<String, Null> {
    match value {
        Some(value) => Either::A(value),
        None => Either::B(Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_formula_prefix() {
        assert_eq!(normalize_formula("SUM(A1:A2)".to_owned()), "=SUM(A1:A2)");
        assert_eq!(normalize_formula("=A1".to_owned()), "=A1");
    }

    #[test]
    fn formats_durations_stably() {
        assert_eq!(duration_to_iso(1.5).as_deref(), Some("P1DT12H0M0S"));
        assert_eq!(
            duration_to_iso(-0.000_001).as_deref(),
            Some("-P0DT0H0M0.086S")
        );
    }
}
