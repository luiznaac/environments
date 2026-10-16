# Coding standards — Python lane

The Python-idiom rules the scaffold's tooling (Ruff, mypy `--strict`, import-linter) does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails on is not restated here.

## R1 — Domain models are frozen dataclasses; Pydantic lives only at the edges

Model the domain with `@dataclass(frozen=True, slots=True)` — immutable, value-typed, no validation framework — and use Pydantic only at the two edges (`httpapi/schema.py` DTOs, `application/settings.py`).

```python
# Reject — a mutable domain model
@dataclass
class Widget:
    name: str

# Prefer — immutable and slotted
@dataclass(frozen=True, slots=True)
class Widget:
    name: str
```

## R2 — Ports are `Protocol` types, named with an `I` prefix

Declare an outbound port as a `typing.Protocol` (`IHealthChecker`, `ITransactionTemplate`), not an abstract base class; adapters satisfy it structurally and need not inherit it.

## R3 — Prefer a comprehension or a builtin over a manual accumulation loop

Build a list/dict/set with a comprehension or a generator rather than an empty container appended in a loop; use `defaultdict` / `Counter` / `groupby` where they fit.

```python
# Reject — manual accumulation
names = []
for widget in widgets:
    names.append(widget.name)

# Prefer — a comprehension
names = [widget.name for widget in widgets]
```

## R4 — Put `from __future__ import annotations` at the top of every module

The scaffold's convention: on the scaffold's Python target the future import is what keeps annotations unevaluated.

## R5 — Define domain exceptions; never raise a bare `Exception`

Raise a domain exception that inherits from a project base class, with a name ending in `Error` and no repetition; do not raise `Exception` / `RuntimeError` directly.

## R6 — Use implicit truthiness

Write `if not seq:` rather than `if len(seq) == 0`.

## R7 — `async` all the way down; blocking work goes through `anyio.to_thread`

Keep the call graph async end to end, and offload a genuinely blocking call with `anyio.to_thread.run_sync` rather than calling it inline in a coroutine.

## R8 — Take time from `IClock` and log through `get_logger`

Read the clock from the injected `IClock`, never `datetime.now()` inside logic, so tests can fix time; log with `get_logger(__name__)` and event-style keys (`_log.info("widgets.listed", count=n)`), never a bare `print`.
