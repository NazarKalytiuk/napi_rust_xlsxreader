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
    use calamine::ExcelDateTimeType;

    use super::*;

    fn serial_datetime(serial: f64) -> DataRef<'static> {
        DataRef::DateTime(ExcelDateTime::new(
            serial,
            ExcelDateTimeType::DateTime,
            false,
        ))
    }

    fn serial_duration(serial: f64) -> DataRef<'static> {
        DataRef::DateTime(ExcelDateTime::new(
            serial,
            ExcelDateTimeType::TimeDelta,
            false,
        ))
    }

    fn naive(text: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").unwrap()
    }

    fn present<T: Clone>(value: &Either<T, Null>) -> Option<T> {
        match value {
            Either::A(value) => Some(value.clone()),
            Either::B(Null) => None,
        }
    }

    fn expect_string(value: BaseCellValue) -> String {
        match value {
            BaseCellValue::A(value) => value,
            other => panic!("expected a string, got {other:?}"),
        }
    }

    fn expect_number(value: BaseCellValue) -> f64 {
        match value {
            BaseCellValue::B(value) => value,
            other => panic!("expected a number, got {other:?}"),
        }
    }

    fn expect_date(value: BaseCellValue) -> NaiveDateTime {
        match value {
            BaseCellValue::D(value) => value,
            other => panic!("expected a JavaScript date, got {other:?}"),
        }
    }

    fn expect_datetime(value: BaseCellValue) -> DateTimeValue {
        match value {
            BaseCellValue::E(value) => value,
            other => panic!("expected a tagged datetime, got {other:?}"),
        }
    }

    fn expect_duration(value: BaseCellValue) -> DurationValue {
        match value {
            BaseCellValue::F(value) => value,
            other => panic!("expected a tagged duration, got {other:?}"),
        }
    }

    fn expect_error_code(value: BaseCellValue) -> String {
        match value {
            BaseCellValue::G(value) => {
                assert_eq!(value.r#type, "error");
                value.code
            }
            other => panic!("expected an Excel error, got {other:?}"),
        }
    }

    #[test]
    fn parses_formula_and_date_modes() {
        assert_eq!(FormulaMode::parse(None).unwrap(), FormulaMode::Value);
        assert_eq!(
            FormulaMode::parse(Some("value")).unwrap(),
            FormulaMode::Value
        );
        assert_eq!(
            FormulaMode::parse(Some("formula")).unwrap(),
            FormulaMode::Formula
        );
        assert_eq!(FormulaMode::parse(Some("both")).unwrap(), FormulaMode::Both);

        assert_eq!(DateMode::parse(None).unwrap(), DateMode::Object);
        assert_eq!(DateMode::parse(Some("object")).unwrap(), DateMode::Object);
        assert_eq!(DateMode::parse(Some("serial")).unwrap(), DateMode::Serial);
        assert_eq!(DateMode::parse(Some("iso")).unwrap(), DateMode::Iso);
        assert_eq!(DateMode::parse(Some("jsDate")).unwrap(), DateMode::JsDate);
    }

    #[test]
    fn rejects_unknown_modes_case_sensitively() {
        for value in ["calculate", "Value", ""] {
            assert_eq!(
                FormulaMode::parse(Some(value)).unwrap_err().code,
                "INVALID_OPTION"
            );
        }
        for value in ["calendar", "jsdate", ""] {
            assert_eq!(
                DateMode::parse(Some(value)).unwrap_err().code,
                "INVALID_OPTION"
            );
        }
    }

    #[test]
    fn converts_scalar_values() {
        assert_eq!(
            expect_number(convert_data(DataRef::Int(7), DateMode::Object, 1900)),
            7.0
        );
        assert_eq!(
            expect_number(convert_data(DataRef::Float(2.5), DateMode::Object, 1900)),
            2.5
        );
        assert_eq!(
            expect_string(convert_data(
                DataRef::String("inline".to_owned()),
                DateMode::Object,
                1900
            )),
            "inline"
        );
        assert_eq!(
            expect_string(convert_data(
                DataRef::SharedString("shared"),
                DateMode::Object,
                1900
            )),
            "shared"
        );
        assert!(matches!(
            convert_data(DataRef::Bool(true), DateMode::Object, 1900),
            BaseCellValue::C(true)
        ));
        assert!(matches!(
            convert_data(DataRef::Empty, DateMode::Object, 1900),
            BaseCellValue::H(Null)
        ));
    }

    #[test]
    fn converts_every_excel_error_code() {
        for (error, code) in [
            (CellErrorType::Div0, "#DIV/0!"),
            (CellErrorType::NA, "#N/A"),
            (CellErrorType::Name, "#NAME?"),
            (CellErrorType::Null, "#NULL!"),
            (CellErrorType::Num, "#NUM!"),
            (CellErrorType::Ref, "#REF!"),
            (CellErrorType::Value, "#VALUE!"),
            (CellErrorType::GettingData, "#DATA!"),
        ] {
            let value = convert_data(DataRef::Error(error), DateMode::Object, 1900);
            assert_eq!(expect_error_code(value), code);
        }
    }

    #[test]
    fn converts_serial_datetimes_per_date_mode() {
        let serial = 46_238.520_833_333_336;

        let tagged = expect_datetime(convert_data(
            serial_datetime(serial),
            DateMode::Object,
            1900,
        ));
        assert_eq!(tagged.r#type, "datetime");
        assert_eq!(present(&tagged.serial), Some(serial));
        assert_eq!(
            present(&tagged.iso).as_deref(),
            Some("2026-08-04T12:30:00.000")
        );
        assert_eq!(present(&tagged.epoch), Some(1900));

        assert_eq!(
            expect_number(convert_data(
                serial_datetime(serial),
                DateMode::Serial,
                1900
            )),
            serial
        );
        assert_eq!(
            expect_string(convert_data(serial_datetime(serial), DateMode::Iso, 1900)),
            "2026-08-04T12:30:00.000"
        );
        assert_eq!(
            expect_date(convert_data(
                serial_datetime(serial),
                DateMode::JsDate,
                1900
            )),
            naive("2026-08-04T12:30:00")
        );
    }

    #[test]
    fn honors_the_1904_date_system() {
        let value = DataRef::DateTime(ExcelDateTime::new(
            44_776.0,
            ExcelDateTimeType::DateTime,
            true,
        ));
        let tagged = expect_datetime(convert_data(value, DateMode::Object, 1904));
        assert_eq!(
            present(&tagged.iso).as_deref(),
            Some("2026-08-04T00:00:00.000")
        );
        assert_eq!(present(&tagged.epoch), Some(1904));
    }

    #[test]
    fn keeps_unrepresentable_serial_datetimes_lossless() {
        for mode in [DateMode::Object, DateMode::Iso, DateMode::JsDate] {
            let tagged = expect_datetime(convert_data(serial_datetime(1e10), mode, 1900));
            assert_eq!(present(&tagged.serial), Some(1e10));
            assert_eq!(present(&tagged.iso), None);
            assert_eq!(present(&tagged.epoch), Some(1900));
        }
        assert_eq!(
            expect_number(convert_data(serial_datetime(1e10), DateMode::Serial, 1900)),
            1e10
        );
    }

    #[test]
    fn converts_serial_durations_per_date_mode() {
        for mode in [DateMode::Object, DateMode::JsDate] {
            let tagged = expect_duration(convert_data(serial_duration(1.5), mode, 1900));
            assert_eq!(tagged.r#type, "duration");
            assert_eq!(present(&tagged.serial), Some(1.5));
            assert_eq!(present(&tagged.iso).as_deref(), Some("P1DT12H0M0S"));
        }
        assert_eq!(
            expect_number(convert_data(serial_duration(1.5), DateMode::Serial, 1900)),
            1.5
        );
        assert_eq!(
            expect_string(convert_data(serial_duration(1.5), DateMode::Iso, 1900)),
            "P1DT12H0M0S"
        );
    }

    #[test]
    fn converts_iso_datetimes_per_date_mode() {
        let source = "2026-08-04T12:30:00+02:00";
        let iso = || DataRef::DateTimeIso(source.to_owned());

        let tagged = expect_datetime(convert_data(iso(), DateMode::Object, 1900));
        assert_eq!(present(&tagged.serial), None);
        assert_eq!(present(&tagged.iso).as_deref(), Some(source));
        assert_eq!(present(&tagged.epoch), None);

        for mode in [DateMode::Serial, DateMode::Iso] {
            assert_eq!(expect_string(convert_data(iso(), mode, 1900)), source);
        }
        assert_eq!(
            expect_date(convert_data(iso(), DateMode::JsDate, 1900)),
            naive("2026-08-04T10:30:00")
        );

        let unparseable = convert_data(
            DataRef::DateTimeIso("not-a-date".to_owned()),
            DateMode::JsDate,
            1900,
        );
        assert_eq!(
            present(&expect_datetime(unparseable).iso).as_deref(),
            Some("not-a-date")
        );
    }

    #[test]
    fn parses_supported_iso_datetime_layouts() {
        for (input, expected) in [
            ("2026-08-04T12:30:00Z", "2026-08-04T12:30:00"),
            ("2026-08-04T12:30:00-01:00", "2026-08-04T13:30:00"),
            ("2026-08-04T12:30:00.250", "2026-08-04T12:30:00.250"),
            ("2026-08-04 12:30:00.250", "2026-08-04T12:30:00.250"),
            ("2026-08-04T12:30:00", "2026-08-04T12:30:00"),
            ("2026-08-04 12:30:00", "2026-08-04T12:30:00"),
            ("2026-08-04", "2026-08-04T00:00:00"),
        ] {
            assert_eq!(parse_iso_datetime(input), Some(naive(expected)), "{input}");
        }
        for input in ["", "not-a-date", "2026-13-01", "12:30:00"] {
            assert_eq!(parse_iso_datetime(input), None, "{input}");
        }
    }

    #[test]
    fn converts_iso_durations_per_date_mode() {
        let duration = || DataRef::DurationIso("PT12H30M".to_owned());

        for mode in [DateMode::Object, DateMode::JsDate] {
            let tagged = expect_duration(convert_data(duration(), mode, 1900));
            assert_eq!(present(&tagged.serial), None);
            assert_eq!(present(&tagged.iso).as_deref(), Some("PT12H30M"));
        }
        for mode in [DateMode::Serial, DateMode::Iso] {
            assert_eq!(
                expect_string(convert_data(duration(), mode, 1900)),
                "PT12H30M"
            );
        }
    }

    #[test]
    fn wraps_formulas_per_formula_mode() {
        let cached = || BaseCellValue::B(43.0);

        match wrap_formula(cached(), Some("B2*2".to_owned()), FormulaMode::Value) {
            CellValue::A(value) => assert_eq!(expect_number(value), 43.0),
            other => panic!("value mode must return the cached value, got {other:?}"),
        }
        match wrap_formula(cached(), Some("B2*2".to_owned()), FormulaMode::Formula) {
            CellValue::A(value) => assert_eq!(expect_string(value), "=B2*2"),
            other => panic!("formula mode must return formula text, got {other:?}"),
        }
        match wrap_formula(cached(), Some("=B2*2".to_owned()), FormulaMode::Both) {
            CellValue::B(formula) => {
                assert_eq!(formula.r#type, "formula");
                assert_eq!(formula.formula, "=B2*2");
                assert_eq!(expect_number(formula.value), 43.0);
            }
            other => panic!("both mode must return a formula object, got {other:?}"),
        }
        for mode in [FormulaMode::Formula, FormulaMode::Both] {
            match wrap_formula(cached(), None, mode) {
                CellValue::A(value) => assert_eq!(expect_number(value), 43.0),
                other => panic!("plain cells must stay unwrapped, got {other:?}"),
            }
        }
    }

    #[test]
    fn normalizes_formula_prefix() {
        assert_eq!(normalize_formula("SUM(A1:A2)".to_owned()), "=SUM(A1:A2)");
        assert_eq!(normalize_formula("=A1".to_owned()), "=A1");
    }

    #[test]
    fn formats_durations_stably() {
        assert_eq!(duration_to_iso(0.0).as_deref(), Some("P0DT0H0M0S"));
        assert_eq!(duration_to_iso(1.5).as_deref(), Some("P1DT12H0M0S"));
        assert_eq!(
            duration_to_iso(-0.000_001).as_deref(),
            Some("-P0DT0H0M0.086S")
        );
    }

    #[test]
    fn rejects_unrepresentable_durations() {
        for serial in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 1e300] {
            assert_eq!(duration_to_iso(serial), None, "{serial}");
        }
    }
}
