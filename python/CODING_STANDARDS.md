# Coding standards — Python lane

The Python-idiom rules this scaffold's tooling — Ruff (`pyproject.toml` → `[tool.ruff]`, `select = E, F, W, I, N, UP, B, A, C4, SIM, PTH, ASYNC, RUF`), mypy `--strict` and import-linter — does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails on is not restated here. The rules come from the Google Python Style Guide (google.github.io/styleguide/pyguide.html) and the language's own PEPs; each names the section it derives from and, where it matters, the tooling rule that is inactive.

The boundary this doc starts after: the tooling already fails import order (`I`), naming (`N`), line length (`E501`), an unused import or variable (`F`), a mutable default argument (`B006`), a re-raise without `from` (`B904`), a comprehension mechanic (`C4`), a `pathlib` opportunity (`PTH`) and a layer violation (`import-linter`), and mypy `--strict` owns annotation completeness. No rule about those belongs in this file. What is left is the set of *shapes* the tooling has no rule for — how a model is built, how a port is declared, and how a call graph flows.

## Types and modeling

### Model the domain with frozen, slotted dataclasses; Pydantic lives only at the edges

Model the domain with `@dataclass(frozen=True, slots=True)` — immutable, value-typed, no validation framework — and use Pydantic only at the two edges (the `httpapi` DTOs and `application/settings.py`).

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

Source: PEP 557 (dataclasses); this lane's `AGENTS.md` → Architecture. mypy checks the annotations but not that the model is frozen; Ruff has no rule that a dataclass should be frozen or slotted.

### Declare an outbound port as a `Protocol`, named with an `I` prefix

Declare an outbound port as a `typing.Protocol` (`IHealthChecker`, `ITransactionTemplate`), not an abstract base class; adapters satisfy it structurally and need not inherit it.

Source: PEP 544 (Protocols); this lane's `AGENTS.md` → Architecture. Neither Ruff nor mypy prefers a Protocol over an ABC, and the `I` prefix is a scaffold convention, not a pep8-naming rule.

### Return `Self` from a method that yields its own class

Annotate a classmethod factory or a fluent method with `typing.Self`, not the concrete class name, so the type stays correct under subclassing.

```python
# Reject — breaks in a subclass (returns the base type)
@classmethod
def create(cls) -> "Widget": ...

# Prefer — tracks the actual class
@classmethod
def create(cls) -> Self: ...
```

Source: Google Python Style Guide §3.19.1 Type Annotations → General Rules; PEP 673 (`Self`).

### Give a type used more than once a `type` alias

Name a parameterized or union type that appears in several signatures with a `type` alias, rather than repeating the long form.

```python
type UserIndex = dict[str, User]
```

Source: Google Python Style Guide §3.19.6 Type Aliases; PEP 695. Ruff's `UP040` rewrites the *syntax* of an existing `TypeAlias` to the `type` statement; it does not tell you a type should have been aliased.

## Functions

### Prefer a comprehension or a builtin to a manual accumulation loop

Build a list/dict/set with a comprehension or a generator rather than an empty container appended in a loop; use `defaultdict` / `Counter` / `groupby` where they fit.

```python
# Reject — manual accumulation
names = []
for widget in widgets:
    names.append(widget.name)

# Prefer — a comprehension
names = [widget.name for widget in widgets]
```

Source: Google Python Style Guide §2.7 Comprehensions & Generator Expressions. Ruff's flake8-comprehensions (`C4`) flags a redundant wrapper around a comprehension, not a hand-rolled loop that should have been one.

### Keep a comprehension to a single `for` and at most one `if`

A nested `for` clause or a second filter in a comprehension is hard to read; write the nested loop instead.

```python
# Reject — two `for` clauses and a filter in one comprehension
result = [(x, y) for x in range(10) for y in range(5) if x * y > 10]

# Prefer — a loop states the shape
result = []
for x in range(10):
    for y in range(5):
        if x * y > 10:
            result.append((x, y))
```

Source: Google Python Style Guide §2.7 (multiple `for` clauses or filter expressions are not permitted). `C4` does not split an over-complex comprehension.

### Iterate with the default iterators and operators

Iterate a mapping's items, test membership with `in`, and iterate a file line by line — the built-in protocols, not the list-returning methods.

```python
# Reject — materializes keys / lines needlessly
for key in counts.keys(): ...
for line in handle.readlines(): ...

# Prefer — the default iterator
for key, value in counts.items(): ...
for line in handle: ...
```

Source: Google Python Style Guide §2.8 Default Iterators and Operators.

### Use a generator for a lazy sequence

Return a generator when the caller consumes the values once and the whole sequence need not exist in memory; document it with a `Yields:` section.

Source: Google Python Style Guide §2.9 Generators.

### Keep a `lambda` to one expression; prefer `operator` to a trivial one

Use a `lambda` only for a short one-liner; for a common operation use the `operator` module function (`operator.mul`, `operator.itemgetter`), and for anything longer define a named function.

Source: Google Python Style Guide §2.10 Lambda Functions.

### Use a conditional expression only when every part fits on one line

Reach for a full `if` statement once the true/if/else parts no longer each fit on one line.

Source: Google Python Style Guide §2.11 Conditional Expressions.

### Nest a function only to close over a local; never nest to hide it

A nested function is for closing over an enclosing local; a helper that should be hidden from the module's users belongs at module scope with a leading underscore, so tests can still reach it.

Source: Google Python Style Guide §2.6 Nested/Local/Inner Classes and Functions.

### Hold a stateful resource in a `with` block

Open a file, socket, database connection or other closeable resource inside a `with` so it is released on every path; do not rely on the destructor's timing.

Source: Google Python Style Guide §3.11 Files, Sockets, and similar Stateful Resources. Ruff's `SIM115` flags an `open()` outside a context manager, but not a socket or connection held without one.

## Idioms

### Use implicit truthiness, and `is None` to test for `None`

Write `if not seq:` rather than `if len(seq) == 0`, and `if value is None` rather than `== None`.

```python
# Reject — explicit emptiness and a truthiness test for None
if len(items) == 0: ...
if value == None: ...

# Prefer — the empty value is already false
if not items: ...
if value is None: ...
```

Source: Google Python Style Guide §2.14 True/False Evaluations. Ruff's `E711` covers the `== None` comparison only; the emptiness idiom has no linter behind it.

### Reach for a property only for cheap, unsurprising access

Use a property (or a getter/setter) only when access does non-trivial work or enforces an invariant; a pair that merely reads and writes an attribute should be a plain public attribute.

Source: Google Python Style Guide §2.13 Properties, and §3.15 Getters and Setters.

### Avoid mutable global state

Prefer passing dependencies explicitly to module-level mutable state; when it is unavoidable, keep it module-private (leading `_`) and expose it through functions. Module-level *constants* are fine and encouraged.

Source: Google Python Style Guide §2.5 Mutable Global State; this lane's `AGENTS.md` → Wiring model (the composition root is the one place that holds the graph).

### Avoid the power features

Do not reach for custom metaclasses, bytecode access, on-the-fly compilation, import hooks, `__del__`-based cleanup or `getattr` reflection when a straightforward construct will do — they are far harder to read, debug and maintain.

Source: Google Python Style Guide §2.19 Power Features.

### Use a decorator judiciously; avoid `staticmethod`, limit `classmethod`

Add a decorator only for a clear, documented advantage, and keep it free of external dependencies (it runs at import time). Write a module-level function instead of a `staticmethod`, and use `classmethod` only for a named constructor.

Source: Google Python Style Guide §2.17 Function and Method Decorators.

### Build a string with `join` or a buffer, never `+`/`+=` in a loop

Accumulating a string with `+` in a loop can be quadratic; append to a list and `"".join` it (or use `io.StringIO`) instead.

```python
# Reject — quadratic accumulation
table = "<table>"
for row in rows:
    table += render_row(row)

# Prefer — linear
parts = ["<table>"]
parts.extend(render_row(row) for row in rows)
table = "".join(parts)
```

Source: Google Python Style Guide §3.10 Strings.

## Exceptions

### Define domain exceptions; never raise a bare `Exception`

Raise a domain exception that inherits from a project base class, with a name ending in `Error` and no repetition; do not raise `Exception` / `RuntimeError` directly.

Source: Google Python Style Guide §2.4 Exceptions; this lane's `AGENTS.md` → Architecture. Ruff's bugbear catches a missing `from` on a re-raise (`B904`), not the exception's shape.

### Never use `assert` for validation or control flow

`assert` is stripped under `-O`, so it must not carry application logic; use it only in tests and for invariants the code does not depend on. Raise a real exception for a violated precondition.

Source: Google Python Style Guide §2.4 Exceptions.

### Keep the `try` body minimal and use `finally` for cleanup

A large `try` body hides the exception a real error raised; guard only the line that can raise, and put unconditional cleanup in `finally`.

Source: Google Python Style Guide §2.4 Exceptions.

## Modules and imports

### Put `from __future__ import annotations` at the top of every module

The scaffold's convention: on the scaffold's Python target the future import is what keeps annotations unevaluated.

Source: Google Python Style Guide §2.20 Modern Python: `from __future__` imports; this lane's `AGENTS.md` → Conventions. Ruff and mypy do not require it.

### Import the module, not the symbol

Import a module and reach its members as `module.member`, so every identifier's origin is visible; symbols from `typing`, `collections.abc` and `typing_extensions` are the standing exception.

```python
# Reject — the origin of `HTTPStatus` is not visible at the call site
from http import HTTPStatus

# Prefer — the module qualifies it
import http

http.HTTPStatus.OK
```

Source: Google Python Style Guide §2.2 Imports, and §2.2.4.1 Exemptions. Ruff's isort (`I`) orders imports; it does not require the module form.

### Guard an executable module with `if __name__ == "__main__"`

Put a script's work in a `main()` and call it under `if __name__ == "__main__"`, so importing the module (for tests or docs) does not run it.

Source: Google Python Style Guide §3.17 Main.

## Documentation

### Write a Google-style docstring for a non-obvious public function

Give a public, non-trivial or non-obvious function a docstring whose sections are the Google ones — `Args:`, `Returns:` (or `Yields:`), `Raises:` — and describe the contract, not the implementation. A trivial accessor needs no docstring.

Source: Google Python Style Guide §3.8.3 Functions and Methods (and §3.8.1 for the one-line summary). pydocstyle (`D`) is not in Ruff's select set.

## Async

### `async` all the way down; blocking work goes through `anyio.to_thread`

Keep the call graph async end to end, and offload a genuinely blocking call with `anyio.to_thread.run_sync` rather than calling it inline in a coroutine.

Source: AnyIO *Threads* (anyio.readthedocs.io/en/stable/threads.html); this lane's `AGENTS.md` → Architecture. Ruff's flake8-async flags some blocking calls in async functions, but not the choice to keep a layer synchronous or to route through `anyio`.

## Logging and time

### Take time from `IClock` and log through `get_logger`

Read the clock from the injected `IClock`, never `datetime.now()` inside logic, so tests can fix time; log with `get_logger(__name__)` and event-style keys (`_log.info("widgets.listed", count=n)`), never a bare `print`.

Source: this lane's `AGENTS.md` → Architecture; Google Python Style Guide §3.10.1 Logging (do not build a log message eagerly when the logger can do it).
