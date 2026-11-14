use calamine::Dimensions;

use crate::error::{ReaderError, ReaderResult};

pub const MAX_ROWS: u32 = 1_048_576;
pub const MAX_COLUMNS: u32 = 16_384;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CellRange {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

impl CellRange {
    pub fn parse(input: &str) -> ReaderResult<Self> {
        let trimmed = input.trim();
        if trimmed.is_empty() || trimmed.contains('!') {
            return Err(invalid_range(input));
        }

        let mut parts = trimmed.split(':');
        let start = parse_cell(parts.next().unwrap_or_default(), input)?;
        let end = match parts.next() {
            Some(value) => parse_cell(value, input)?,
            None => start,
        };

        if parts.next().is_some() || start.0 > end.0 || start.1 > end.1 {
            return Err(invalid_range(input));
        }

        Ok(Self {
            start_row: start.0,
            start_col: start.1,
            end_row: end.0,
            end_col: end.1,
        })
    }

    pub fn from_dimensions(dimensions: Dimensions) -> Self {
        Self {
            start_row: dimensions.start.0,
            start_col: dimensions.start.1,
            end_row: dimensions.end.0,
            end_col: dimensions.end.1,
        }
    }

    pub fn width(self) -> usize {
        (self.end_col - self.start_col + 1) as usize
    }

    pub fn contains(self, row: u32, column: u32) -> bool {
        row >= self.start_row
            && row <= self.end_row
            && column >= self.start_col
            && column <= self.end_col
    }

    pub fn to_a1(self) -> String {
        dimensions_to_a1(Dimensions::new(
            (self.start_row, self.start_col),
            (self.end_row, self.end_col),
        ))
    }
}

pub fn dimensions_to_a1(dimensions: Dimensions) -> String {
    let start = format!(
        "{}{}",
        column_name(dimensions.start.1),
        dimensions.start.0 + 1
    );
    let end = format!("{}{}", column_name(dimensions.end.1), dimensions.end.0 + 1);

    if start == end {
        start
    } else {
        format!("{start}:{end}")
    }
}

fn parse_cell(value: &str, original: &str) -> ReaderResult<(u32, u32)> {
    let value = value.as_bytes();
    let mut cursor = 0;

    if value.get(cursor) == Some(&b'$') {
        cursor += 1;
    }

    let column_start = cursor;
    while value
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphabetic())
    {
        cursor += 1;
    }

    if cursor == column_start {
        return Err(invalid_range(original));
    }

    let column = parse_column(&value[column_start..cursor], original)?;

    if value.get(cursor) == Some(&b'$') {
        cursor += 1;
    }

    let row_start = cursor;
    while value.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }

    if cursor == row_start || cursor != value.len() {
        return Err(invalid_range(original));
    }

    let row_text =
        std::str::from_utf8(&value[row_start..cursor]).map_err(|_| invalid_range(original))?;
    let row = row_text
        .parse::<u32>()
        .map_err(|_| invalid_range(original))?;

    if row == 0 || row > MAX_ROWS {
        return Err(invalid_range(original));
    }

    Ok((row - 1, column))
}

fn parse_column(value: &[u8], original: &str) -> ReaderResult<u32> {
    let mut column = 0_u32;

    for byte in value {
        let letter = byte.to_ascii_uppercase();
        if !letter.is_ascii_uppercase() {
            return Err(invalid_range(original));
        }
        column = column
            .checked_mul(26)
            .and_then(|current| current.checked_add(u32::from(letter - b'A' + 1)))
            .ok_or_else(|| invalid_range(original))?;
    }

    if column == 0 || column > MAX_COLUMNS {
        return Err(invalid_range(original));
    }

    Ok(column - 1)
}

fn column_name(mut column: u32) -> String {
    let mut bytes = [0_u8; 7];
    let mut cursor = bytes.len();

    loop {
        let remainder = (column % 26) as u8;
        cursor -= 1;
        bytes[cursor] = b'A' + remainder;
        if column < 26 {
            break;
        }
        column = column / 26 - 1;
    }

    String::from_utf8_lossy(&bytes[cursor..]).into_owned()
}

fn invalid_range(value: &str) -> ReaderError {
    ReaderError::new(
        "INVALID_RANGE",
        format!("Expected A1 or A1:B2 range syntax, received {value:?}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_and_bounded_ranges() {
        assert_eq!(
            CellRange::parse("A1").unwrap(),
            CellRange {
                start_row: 0,
                start_col: 0,
                end_row: 0,
                end_col: 0,
            }
        );
        assert_eq!(
            CellRange::parse("$b$2:XFD1048576").unwrap().to_a1(),
            "B2:XFD1048576"
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(CellRange::parse("  a1:b2\t").unwrap().to_a1(), "A1:B2");
    }

    #[test]
    fn rejects_unsupported_or_reversed_ranges() {
        for value in [
            "",
            "   ",
            "Sheet1!A1",
            "A:A",
            "1:2",
            "B2:A1",
            "B1:A1",
            "A2:A1",
            "XFE1",
            "A1048577",
            "A0",
            "A1:B2:C3",
            "A1:",
            ":A1",
            "1A",
            "A1B",
            "A$",
            "$1",
            "A-1",
            "É1",
            "AAAAAAAA1",
            "A99999999999",
        ] {
            let error = CellRange::parse(value).unwrap_err();
            assert_eq!(error.code, "INVALID_RANGE", "{value:?} should fail");
        }
    }

    #[test]
    fn renders_column_names_across_letter_boundaries() {
        for (column, name) in [
            (0, "A"),
            (25, "Z"),
            (26, "AA"),
            (51, "AZ"),
            (52, "BA"),
            (701, "ZZ"),
            (702, "AAA"),
            (MAX_COLUMNS - 1, "XFD"),
        ] {
            assert_eq!(column_name(column), name);
            assert_eq!(
                CellRange::parse(&format!("{name}1")).unwrap().start_col,
                column
            );
        }
    }

    #[test]
    fn checks_containment_and_width() {
        let range = CellRange::parse("B2:D4").unwrap();
        assert_eq!(range.width(), 3);
        assert!(range.contains(1, 1));
        assert!(range.contains(3, 3));
        assert!(!range.contains(0, 1));
        assert!(!range.contains(1, 4));
        assert!(!range.contains(4, 3));
    }
}
