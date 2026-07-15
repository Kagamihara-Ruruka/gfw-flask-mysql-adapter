from __future__ import annotations

import datetime as dt
import decimal
from typing import Any, Iterable


def json_ready(value: Any) -> Any:
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        as_int = int(value)
        return as_int if value == as_int else float(value)
    return value


def rows_json_ready(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{key: json_ready(value) for key, value in row.items()} for row in rows]
