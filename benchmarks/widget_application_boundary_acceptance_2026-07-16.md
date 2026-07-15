# Widget Application boundary acceptance - 2026-07-16

This report records Checkpoint B acceptance after Widget query/cache ownership
was moved out of UI capabilities and into dependency-injected Application
services. No playback, query, canonical frame, mapping, renderer, or external
API contract was intentionally changed.

## Boundary under test

```text
RuntimeCompositionRoot
  -> WidgetApplicationRuntime
      -> WidgetQueryContext
      -> cache-backed Widget DataSources
  -> WidgetAbilityRegistry factory
      -> DashboardWidget with frozen injected services
```

Capabilities render ViewModels and emit commands. They no longer construct
DataSources, call `DataFrameStore` or `FrameDemandService`, or use `.shared()`
service lookup. The table and event viewer remain read-only; query-capable
charts can only submit a lower-priority `widget` lane demand through the
Application boundary.

## Automated regression

- JavaScript contract tests: `98 / 98` passed.
- Python `unittest` contracts: `40 / 40` passed.
- JavaScript syntax checks: passed for every changed/new module.
- Demo-critical HTTP smoke: passed, including script order, health, schema,
  snapshot, and range queries.
- `git diff --check`: no whitespace errors.

## External Chrome Incognito annual acceptance

Conditions:

- Dataset: `pipeline_iceberg.chlor_a`.
- Advertised range: `2020-01-01..2020-12-31`.
- Sequential playback at `4x`.
- DataFrameStore budget verified by the visible capacity meter as `4.00 GB`.
- Cold run began at `0 B`; completed store size was `2.23 GB`.
- Warm run reused the same scope and in-memory canonical frames.

| Mode | Visible frames | Stalls | Stall total | Max stall | Cadence P95 | Queue P95 | HTTP P95 | Render P95 | Run time | Browser errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 354 | 100 | 115.64 s | 3.44 s | 2.49 s | 3.46 s | 5.32 s | 76.4 ms | 247.75 s | 0 |
| warm | 354 | 0 | 0 | 0 | 365.1 ms | - | - | 60.6 ms | 123.91 s | 0 |

The warm run kept the store at `2.23 GB`, emitted no queue/network phase, and
did not enter buffering. This confirms that the UI/Application split did not
introduce a second transport path or clear completed canonical frames.

## Dataset and interaction regression

All five imported Pipeline Iceberg layers were activated from the real data
layer drawer and resolved their complete 2020 ranges without browser errors:

- `chlor_a`
- `sea_temperature`
- `ocean_productivity_score`
- `sustainability_pressure`
- `fishing_hours`

On `sea_temperature`, single-cell selection produced one virtual-grid
rectangle and updated the line chart, pie chart, and EEZ attribution Widget
from the same selection state. Disabling selection cleared the rectangle before
the next dataset activation. No Widget-owned transport or Runtime exception was
observed.

## Acceptance conclusion

Checkpoint B is accepted. Widget data ownership now has one Application owner,
instances are assembled by the DI root, Registry and size matrix remain the
creation decision source, capabilities remain presentation-only, and the
annual playback baseline did not regress on the warm-cache path.
