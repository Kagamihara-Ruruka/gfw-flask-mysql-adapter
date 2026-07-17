from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence

from common_adapter.query.immutable import freeze_json, thaw_json


CANONICAL_GRID_FRAME_VERSION = "rrkal.canonical_grid_frame.v1"
CANONICAL_GRID_FRAME_FIELDS = ("date", "resolution_km")
CANONICAL_GRID_ROW_FIELDS = (
    "cell_id",
    "lat",
    "lon",
    "value",
    "coverage_ratio",
    "data_status",
    "bounds.west",
    "bounds.south",
    "bounds.east",
    "bounds.north",
)
_MISSING = object()


def _field_value(row: Mapping[str, Any], field_name: str) -> Any:
    if not field_name.startswith("bounds."):
        return row.get(field_name)
    bounds = row.get("bounds")
    return bounds.get(field_name.split(".", 1)[1]) if isinstance(bounds, Mapping) else None


def _row_from_values(
    row_fields: Sequence[str],
    values: Sequence[Any],
    frame_fields: Mapping[str, Any],
) -> dict[str, Any]:
    row: dict[str, Any] = {}
    bounds: dict[str, Any] = {}
    for field_name, value in zip(row_fields, values, strict=True):
        if field_name.startswith("bounds."):
            bounds[field_name.split(".", 1)[1]] = value
        else:
            row[field_name] = value
    for field_name, value in frame_fields.items():
        row[field_name] = value
    if bounds and any(value is not None for value in bounds.values()):
        row = {"bounds": bounds, **row}
    return row


@dataclass(frozen=True, slots=True)
class CanonicalGridFrame:
    """Immutable columnar truth for one canonical sampled-grid snapshot."""

    row_fields: tuple[str, ...]
    columns: tuple[tuple[Any, ...], ...]
    frame_fields: Mapping[str, Any]
    row_count: int
    _field_indexes: Mapping[str, int] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if len(self.row_fields) != len(self.columns):
            raise ValueError("canonical grid frame field/column count mismatch")
        if len(set(self.row_fields)) != len(self.row_fields):
            raise ValueError("canonical grid frame fields must be unique")
        if self.row_count < 0:
            raise ValueError("canonical grid frame row_count cannot be negative")
        if any(len(column) != self.row_count for column in self.columns):
            raise ValueError("canonical grid frame column length mismatch")
        object.__setattr__(self, "frame_fields", freeze_json(dict(self.frame_fields)))
        object.__setattr__(
            self,
            "_field_indexes",
            freeze_json({name: index for index, name in enumerate(self.row_fields)}),
        )

    def column(self, field_name: str) -> tuple[Any, ...] | None:
        index = self._field_indexes.get(field_name)
        return None if index is None else self.columns[index]

    def value_at(self, field_name: str, index: int) -> Any:
        if index < 0 or index >= self.row_count:
            raise IndexError(index)
        if field_name in self.frame_fields:
            return self.frame_fields[field_name]
        column = self.column(field_name)
        return None if column is None else column[index]

    def bounds_at(self, index: int) -> dict[str, float] | None:
        values = {
            direction: self.value_at(f"bounds.{direction}", index)
            for direction in ("west", "south", "east", "north")
        }
        if any(value is None for value in values.values()):
            return None
        return {direction: float(value) for direction, value in values.items()}

    def row_at(self, index: int) -> dict[str, Any]:
        values = [column[index] for column in self.columns]
        return _row_from_values(self.row_fields, values, self.frame_fields)

    def view(self, indices: Iterable[int] | None = None) -> "CanonicalGridFrameView":
        return CanonicalGridFrameView(self, None if indices is None else tuple(indices))


@dataclass(frozen=True, slots=True)
class CanonicalGridFrameView:
    """A zero-copy logical row selection over one CanonicalGridFrame."""

    frame: CanonicalGridFrame
    indices: tuple[int, ...] | None = None

    def __post_init__(self) -> None:
        if self.indices is None:
            return
        if any(index < 0 or index >= self.frame.row_count for index in self.indices):
            raise IndexError("canonical grid frame view index is outside the source frame")

    @property
    def row_count(self) -> int:
        return self.frame.row_count if self.indices is None else len(self.indices)

    def source_index(self, logical_index: int) -> int:
        if logical_index < 0 or logical_index >= self.row_count:
            raise IndexError(logical_index)
        return logical_index if self.indices is None else self.indices[logical_index]

    def value_at(self, field_name: str, logical_index: int) -> Any:
        return self.frame.value_at(field_name, self.source_index(logical_index))

    def bounds_at(self, logical_index: int) -> dict[str, float] | None:
        return self.frame.bounds_at(self.source_index(logical_index))

    def row_at(self, logical_index: int) -> dict[str, Any]:
        return self.frame.row_at(self.source_index(logical_index))

    def iter_rows(self) -> Iterator[dict[str, Any]]:
        for index in range(self.row_count):
            yield self.row_at(index)

    def rows(self, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
        start = max(0, int(offset))
        stop = self.row_count if limit is None else min(self.row_count, start + max(0, int(limit)))
        return [self.row_at(index) for index in range(start, stop)]

    def select(self, predicate: Callable[["CanonicalGridFrameView", int], bool]) -> "CanonicalGridFrameView":
        selected = tuple(index for index in range(self.row_count) if predicate(self, index))
        if len(selected) == self.row_count:
            return self
        source = tuple(self.source_index(index) for index in selected)
        return CanonicalGridFrameView(self.frame, source)

    def intersecting(self, bbox: Mapping[str, float] | None, *, epsilon: float = 0.0) -> "CanonicalGridFrameView":
        if not bbox:
            return self

        def intersects(view: CanonicalGridFrameView, index: int) -> bool:
            bounds = view.bounds_at(index)
            if bounds is not None:
                return (
                    bounds["west"] < float(bbox["east"]) - epsilon
                    and bounds["east"] > float(bbox["west"]) + epsilon
                    and bounds["south"] < float(bbox["north"]) - epsilon
                    and bounds["north"] > float(bbox["south"]) + epsilon
                )
            lat = view.value_at("lat", index)
            lon = view.value_at("lon", index)
            try:
                latitude = float(lat)
                longitude = float(lon)
            except (TypeError, ValueError):
                return False
            return (
                float(bbox["west"]) <= longitude <= float(bbox["east"])
                and float(bbox["south"]) <= latitude <= float(bbox["north"])
            )

        return self.select(intersects)

    def sliced(self, offset: int = 0, limit: int | None = None) -> "CanonicalGridFrameView":
        start = max(0, int(offset))
        stop = self.row_count if limit is None else min(self.row_count, start + max(0, int(limit)))
        if start == 0 and stop == self.row_count:
            return self
        return CanonicalGridFrameView(
            self.frame,
            tuple(self.source_index(index) for index in range(start, stop)),
        )

    def transport(self) -> dict[str, Any]:
        if self.indices is None:
            columns: Sequence[Sequence[Any]] = self.frame.columns
        else:
            columns = tuple(
                tuple(column[index] for index in self.indices)
                for column in self.frame.columns
            )
        return {
            "schema": CANONICAL_GRID_FRAME_VERSION,
            "row_fields": list(self.frame.row_fields),
            "frame_fields": thaw_json(self.frame.frame_fields),
            "columns": columns,
            "row_count": self.row_count,
        }


class CanonicalGridFrameBuilder:
    """Collects canonical values once and hoists invariant frame fields."""

    def __init__(
        self,
        row_fields: Sequence[str] = CANONICAL_GRID_ROW_FIELDS,
        frame_field_names: Sequence[str] = CANONICAL_GRID_FRAME_FIELDS,
    ) -> None:
        all_fields = tuple(dict.fromkeys((*row_fields, *frame_field_names)))
        self._all_fields = all_fields
        self._columns = {name: [] for name in all_fields}
        self._frame_field_names = frozenset(frame_field_names)
        self._constants = {name: _MISSING for name in frame_field_names}
        self._constant = {name: True for name in frame_field_names}

    def append(self, values: Mapping[str, Any] | Sequence[Any]) -> None:
        if isinstance(values, Mapping):
            resolved = tuple(values.get(name) for name in self._all_fields)
        else:
            resolved = tuple(values)
            if len(resolved) != len(self._all_fields):
                raise ValueError("canonical grid builder row width mismatch")
        for name, value in zip(self._all_fields, resolved, strict=True):
            self._columns[name].append(value)
            if name not in self._frame_field_names:
                continue
            previous = self._constants[name]
            if previous is _MISSING:
                self._constants[name] = value
            elif previous != value:
                self._constant[name] = False

    def build(self) -> CanonicalGridFrame:
        row_count = len(self._columns[self._all_fields[0]]) if self._all_fields else 0
        frame_fields = {
            name: None if self._constants[name] is _MISSING else self._constants[name]
            for name in self._frame_field_names
            if self._constant[name]
        }
        row_fields = tuple(name for name in self._all_fields if name not in frame_fields)
        columns = tuple(tuple(self._columns[name]) for name in row_fields)
        return CanonicalGridFrame(row_fields, columns, frame_fields, row_count)


def canonical_grid_frame_from_rows(rows: Iterable[Mapping[str, Any]]) -> CanonicalGridFrame:
    values = [row for row in rows if isinstance(row, Mapping)]
    has_bounds = any(isinstance(row.get("bounds"), Mapping) for row in values)
    present = {
        str(field_name)
        for row in values
        for field_name in row
        if field_name not in {*CANONICAL_GRID_FRAME_FIELDS, "bounds"}
    }
    row_fields = tuple(
        field_name
        for field_name in CANONICAL_GRID_ROW_FIELDS
        if field_name in present or (has_bounds and field_name.startswith("bounds."))
    )
    frame_field_names = tuple(
        field_name
        for field_name in CANONICAL_GRID_FRAME_FIELDS
        if any(field_name in row for row in values)
    )
    builder = CanonicalGridFrameBuilder(row_fields, frame_field_names)
    for row in values:
        builder.append({
            **{field_name: _field_value(row, field_name) for field_name in row_fields},
            **{field_name: row.get(field_name) for field_name in CANONICAL_GRID_FRAME_FIELDS},
        })
    return builder.build()


def canonical_grid_frame_from_transport(value: Mapping[str, Any]) -> CanonicalGridFrame:
    if value.get("schema") != CANONICAL_GRID_FRAME_VERSION:
        raise ValueError("unsupported canonical grid frame schema")
    row_fields = tuple(str(field_name) for field_name in value.get("row_fields") or [])
    columns = tuple(tuple(column) for column in value.get("columns") or [])
    row_count = int(value.get("row_count") or 0)
    return CanonicalGridFrame(
        row_fields=row_fields,
        columns=columns,
        frame_fields=dict(value.get("frame_fields") or {}),
        row_count=row_count,
    )
