# Coding standards — Kotlin lane

The Kotlin-idiom rules this scaffold's tooling — detekt, and the compiler under `allWarningsAsErrors` — does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails the build on is not restated here. The rules come from the Kotlin *Coding conventions* (kotlinlang.org/docs/coding-conventions.html), each from the section named under it.

## R1 — Prefer collection extension functions over imperative accumulation

Build a grouped or keyed structure with `groupBy` / `associateBy` / `mapValues` / `associate` rather than a `mutableMapOf` accumulated in a loop with `?:` and `.also`. The conventions state the general case — prefer higher-order functions (`filter`, `map`, …) to loops — and an imperative accumulator is a loop in disguise.

```kotlin
// Reject — imperative accumulation
val bySector = mutableMapOf<String, MutableList<Row>>()
for (row in rows) {
    val group = bySector[row.sector]
    if (group == null) {
        bySector[row.sector] = mutableListOf(row)
    } else {
        group.also { it.add(row) }
    }
}

// Prefer — the extension function states the shape
val bySector = rows.groupBy { it.sector }
```

**Why the tooling leaves it open.** detekt flags a redundant *existing* higher-order call, not a hand-rolled loop that should have been one, and its mutability rule fires on a `var` holding a mutable collection, not on a `val` map mutated in place.

Source: *Coding conventions* → Idiomatic use of language features → Loops.

## R2 — Reuse the `groupBy` key rather than re-deriving it from the group's elements

Once `groupBy` (or `associateBy`) has produced the key, use it; do not reach back into the group to recompute what the key already is (`group.first().sector`, `rows.first()`).

```kotlin
// Reject — re-derives the key from the group's first element
rows.groupBy { it.sector }.mapValues { (_, group) -> group.first().sector }

// Prefer — the key is already in hand
rows.groupBy { it.sector }.map { (sector, group) -> sector to group.size }
```

**Why the tooling leaves it open.** No lint relates a grouping key to its group's contents — it is a semantic duplication only a reader sees, and it is the **Duplicated Code** smell in the Fowler baseline as much as a Kotlin idiom.

## R3 — Prefer immutable collection interfaces and factories

Declare a collection that is not mutated with `List` / `Set` / `Map` (not `MutableList` / `HashSet`), and build it with `listOf` / `setOf` / `mapOf` (not `arrayListOf` / `hashSetOf`).

```kotlin
// Reject — a val built with a mutable factory
val allowed = arrayListOf("a")

// Prefer — the interface states it is not mutated
val allowed = listOf("a")
```

**Why the tooling leaves it open.** detekt's mutability rule catches only the `var`-of-mutable case, not the `val`-of-mutable-factory case.

Source: *Coding conventions* → Immutability.

## R4 — Prefer the expression form of `if` / `when` / `try`, and `when` over three-plus `if` branches

Use the expression form — `return if (x) foo() else bar()` rather than `if (x) return foo() else return bar()`, and a `when` or `try` that yields a value rather than assigning or returning from each branch. Reach for `when` with three or more options and `if` for a binary condition.

```kotlin
// Reject — a statement per branch
if (status == Status.OK) {
    return body
} else {
    return error
}

// Prefer — one expression
return if (status == Status.OK) body else error

// Reject — a when statement assigning in each branch
var label: String
when (status) {
    Status.OK -> label = "ok"
    Status.ERROR -> label = "error"
    else -> label = "unknown"
}

// Prefer — the expression form
val label = when (status) {
    Status.OK -> "ok"
    Status.ERROR -> "error"
    else -> "unknown"
}
```

**Why the tooling leaves it open.** `ExpressionBodySyntax` and `UseIfInsteadOfWhen` are both inactive in this scaffold's detekt config, so neither fires.

Source: *Coding conventions* → Conditional statements, and → `if` versus `when`.

## R5 — Prefer an expression body for a single-expression function

Write `fun foo() = 1` rather than `fun foo(): Int { return 1 }`.

**Why the tooling leaves it open.** `ExpressionBodySyntax` is inactive in this scaffold's detekt config.

Source: *Coding conventions* → Functions.

## R6 — Omit redundant constructs

Omit the `Unit` return type, and the curly braces around a simple interpolated string variable (`"$name"`, not `"${name}"`).

**Why the tooling leaves it open.** detekt covers semicolons only; the `Unit` and string-interpolation redundancies are not a detekt rule.

Source: *Coding conventions* → Avoid redundant constructs.
