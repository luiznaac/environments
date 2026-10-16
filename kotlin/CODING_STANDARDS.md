# Coding standards — Kotlin lane

The Kotlin-idiom rules the scaffold's tooling (detekt, the compiler with `allWarningsAsErrors`) does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails the build on is not restated here.

## R1 — Prefer collection extension functions over imperative accumulation

Build a grouped or keyed structure with `groupBy` / `associateBy` / `mapValues` / `associate` rather than a `mutableMapOf` accumulated in a loop with `?:` and `.also`. The imperative accumulator is a loop in disguise, and the Kotlin conventions prefer higher-order functions to loops.

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

## R2 — Reuse the `groupBy` key rather than re-deriving it from the group's elements

Once `groupBy` (or `associateBy`) has produced the key, use it; do not reach back into the group to recompute what the key already is (`group.first().sector`, `rows.first()`).

```kotlin
// Reject — re-derives the key from the group's first element
rows.groupBy { it.sector }.mapValues { (_, group) -> group.first().sector }

// Prefer — the key is already in hand
rows.groupBy { it.sector }.map { (sector, group) -> sector to group.size }
```

## R3 — Prefer immutable collection interfaces and factories

Declare a collection that is not mutated with `List` / `Set` / `Map` (not `MutableList` / `HashSet`), and build it with `listOf` / `setOf` / `mapOf` (not `arrayListOf` / `hashSetOf`).

```kotlin
// Reject — a val holding a mutable factory
val allowed = arrayListOf("a")

// Prefer — the interface states it is not mutated
val allowed = listOf("a")
```

## R4 — Prefer the expression form of `if` / `when` / `try`, and `when` over three-plus `if` branches

Write `return if (x) foo() else bar()` rather than `if (x) return foo() else return bar()`, and likewise use the expression form of `when` and `try` (a `when` or `try` that yields a value) rather than assigning or returning from each branch. Use `when` for three or more options and `if` for a binary condition.

```kotlin
// Reject
if (status == Status.OK) {
    return body
} else {
    return error
}

// Prefer
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

## R5 — Prefer an expression body for a single-expression function

Write `fun foo() = 1` rather than `fun foo(): Int { return 1 }`.

## R6 — Omit redundant constructs

Omit the `Unit` return type, and omit the curly braces around a simple interpolated string variable (`"$name"`, not `"${name}"`).
