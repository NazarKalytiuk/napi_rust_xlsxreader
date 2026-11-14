use std::io::{Read, Seek};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use calamine::{Dimensions, Xlsx};
use napi_derive::napi;

use crate::error::{ReaderError, ReaderResult};
use crate::range::{CellRange, dimensions_to_a1};
use crate::source::{WorkbookSource, open_buffer, open_path};
use crate::value::{CellValue, DateMode, FormulaMode, convert_data, null_cell, wrap_formula};

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct ReadOptions {
    pub range: Option<String>,
    pub formula_mode: Option<String>,
    pub date_mode: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ParsedReadOptions {
    pub range: Option<CellRange>,
    pub formula_mode: FormulaMode,
    pub date_mode: DateMode,
}

impl ParsedReadOptions {
    pub fn parse(options: Option<ReadOptions>) -> ReaderResult<Self> {
        let options = options.unwrap_or_default();
        Ok(Self {
            range: options.range.as_deref().map(CellRange::parse).transpose()?,
            formula_mode: FormulaMode::parse(options.formula_mode.as_deref())?,
            date_mode: DateMode::parse(options.date_mode.as_deref())?,
        })
    }
}

pub fn collect_rows(
    source: &WorkbookSource,
    sheet_name: &str,
    epoch: u16,
    options: &ParsedReadOptions,
    cancelled: &AtomicBool,
) -> ReaderResult<Vec<Vec<CellValue>>> {
    let mut rows = Vec::new();
    produce_rows(source, sheet_name, epoch, options, cancelled, |row| {
        rows.push(row);
        Ok(())
    })?;
    Ok(rows)
}

pub fn produce_rows<F>(
    source: &WorkbookSource,
    sheet_name: &str,
    epoch: u16,
    options: &ParsedReadOptions,
    cancelled: &AtomicBool,
    mut emit: F,
) -> ReaderResult<()>
where
    F: FnMut(Vec<CellValue>) -> ReaderResult<()>,
{
    match source {
        WorkbookSource::Path(path) => {
            let mut workbook = open_path(path)?;
            produce_workbook_rows(
                &mut workbook,
                sheet_name,
                epoch,
                options,
                cancelled,
                &mut emit,
            )
        }
        WorkbookSource::Buffer(bytes) => {
            let mut workbook = open_buffer(Arc::clone(bytes))?;
            produce_workbook_rows(
                &mut workbook,
                sheet_name,
                epoch,
                options,
                cancelled,
                &mut emit,
            )
        }
    }
}

fn produce_workbook_rows<RS, F>(
    workbook: &mut Xlsx<RS>,
    sheet_name: &str,
    epoch: u16,
    options: &ParsedReadOptions,
    cancelled: &AtomicBool,
    emit: &mut F,
) -> ReaderResult<()>
where
    RS: Read + Seek,
    F: FnMut(Vec<CellValue>) -> ReaderResult<()>,
{
    let mut reader = workbook
        .worksheet_cells_reader(sheet_name)
        .map_err(ReaderError::from)?;
    let explicit_range = options.range.is_some();
    let range = options
        .range
        .unwrap_or_else(|| CellRange::from_dimensions(reader.dimensions()));
    let width = range.width();
    let mut current_row_index = range.start_row;
    let mut current_row = null_row(width);
    let mut started = false;

    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(ReaderError::aborted());
        }

        let next = match options.formula_mode {
            FormulaMode::Value => reader.next_cell().map_err(ReaderError::from)?.map(|cell| {
                let position = cell.get_position();
                let value = convert_data(cell.get_value().clone(), options.date_mode, epoch);
                (position, wrap_formula(value, None, FormulaMode::Value))
            }),
            FormulaMode::Formula | FormulaMode::Both => reader
                .next_cell_with_formula()
                .map_err(ReaderError::from)?
                .map(|cell| {
                    let value = convert_data(cell.value, options.date_mode, epoch);
                    (
                        cell.pos,
                        wrap_formula(value, cell.formula, options.formula_mode),
                    )
                }),
        };

        let Some(((row, column), value)) = next else {
            break;
        };

        if !range.contains(row, column) {
            if explicit_range {
                if row > range.end_row {
                    break;
                }
                continue;
            }
            return Err(ReaderError::new(
                "CORRUPT_WORKBOOK",
                format!(
                    "Cell {} is outside declared worksheet range {}",
                    dimensions_to_a1(Dimensions::new((row, column), (row, column))),
                    range.to_a1()
                ),
            ));
        }

        if !started {
            while current_row_index < row {
                check_cancelled(cancelled)?;
                emit(null_row(width))?;
                current_row_index += 1;
            }
            started = true;
        } else if row > current_row_index {
            emit(current_row)?;
            current_row_index += 1;
            while current_row_index < row {
                check_cancelled(cancelled)?;
                emit(null_row(width))?;
                current_row_index += 1;
            }
            current_row = null_row(width);
        }

        current_row[(column - range.start_col) as usize] = value;
    }

    if explicit_range {
        if started {
            emit(current_row)?;
            current_row_index += 1;
        }
        while current_row_index <= range.end_row {
            check_cancelled(cancelled)?;
            emit(null_row(width))?;
            current_row_index += 1;
        }
    } else if started {
        emit(current_row)?;
        current_row_index += 1;
        while current_row_index <= range.end_row {
            check_cancelled(cancelled)?;
            emit(null_row(width))?;
            current_row_index += 1;
        }
    }

    Ok(())
}

fn null_row(width: usize) -> Vec<CellValue> {
    (0..width).map(|_| null_cell()).collect()
}

fn check_cancelled(cancelled: &AtomicBool) -> ReaderResult<()> {
    if cancelled.load(Ordering::Acquire) {
        Err(ReaderError::aborted())
    } else {
        Ok(())
    }
}
