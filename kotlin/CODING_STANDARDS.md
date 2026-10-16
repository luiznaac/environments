# Coding standards — Kotlin lane

The Kotlin-idiom rules this scaffold's tooling — detekt (`config/detekt/config.yml` and `format.yml`), and the compiler under `allWarningsAsErrors` — does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails the build on is not restated here. The rules come from the official Kotlin *Coding conventions* (kotlinlang.org/docs/coding-conventions.html) and *Idioms* (kotlinlang.org/docs/idioms.html); each names the section it derives from and, where it matters, the detekt rule that is inactive.

## Immutability

### Prefer immutable collection interfaces and factories

Declare a collection that is not mutated with `Collection` / `List` / `Set` / `Map` (not `MutableList` / `HashSet`), and build it with `listOf` / `setOf` / `mapOf` (not `arrayListOf` / `hashSetOf`).

```kotlin
// Reject — a val built with a mutable factory
val allowed = arrayListOf("a")

// Prefer — the interface states it is not mutated
val allowed = listOf("a")
```

Source: *Coding conventions* → Idiomatic use of language features → Immutability. `DoubleMutabilityForCollection` catches only the `var`-of-mutable case, not the `val`-of-mutable-factory case.

## Loops

### Prefer collection extension functions over imperative accumulation

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

Source: *Coding conventions* → Idiomatic use of language features → Loops. detekt flags a redundant *existing* higher-order call, not a hand-rolled loop that should have been one.

### Reuse the `groupBy` key rather than re-deriving it from the group's elements

Once `groupBy` (or `associateBy`) has produced the key, use it; do not reach back into the group to recompute what the key already is (`group.first().sector`, `rows.first()`).

```kotlin
// Reject — re-derives the key from the group's first element
rows.groupBy { it.sector }.mapValues { (_, group) -> group.first().sector }

// Prefer — the key is already in hand
rows.groupBy { it.sector }.map { (sector, group) -> sector to group.size }
```

Source: *Coding conventions* → Loops. No lint relates a grouping key to its group's contents — it is a semantic duplication only a reader sees, and the **Duplicated Code** smell in the Fowler baseline as much as a Kotlin idiom.

### Iterate an open-ended range with `..<`

Write `for (i in 0..<n)` rather than `for (i in 0..n - 1)`.

Source: *Coding conventions* → Idiomatic use of language features → Loops on ranges. detekt's `UntilInsteadOfRangeTo` is inactive in this scaffold's config.

### Prefer a `for` loop to a bare `forEach`

Reach for higher-order functions over loops, with one exception: for a plain iteration, prefer a regular `for` loop to `forEach`. Keep `forEach` for a nullable receiver or as part of a longer call chain.

Source: *Coding conventions* → Loops.

## Conditional statements

### Prefer the expression form of `if` / `when` / `try`

Use the expression form — `return if (x) foo() else bar()` rather than `if (x) return foo() else return bar()`, and a `when` or `try` that yields a value rather than assigning or returning from each branch.

```kotlin
// Reject — a statement per branch
if (status == Status.OK) {
    return body
} else {
    return error
}

// Prefer — one expression
return if (status == Status.OK) body else error
```

Source: *Coding conventions* → Idiomatic use of language features → Conditional statements. `ExpressionBodySyntax` and `UseIfInsteadOfWhen` are both inactive in this scaffold's detekt config.

### Prefer `if` for a binary condition, `when` for three or more options

Use `if` for a two-way branch and `when` once there are three or more options.

Source: *Coding conventions* → Idiomatic use of language features → `if` versus `when`. `UseIfInsteadOfWhen` is inactive.

### Test a nullable Boolean against `true` / `false`

When a `Boolean?` drives a condition, compare it explicitly (`if (value == true)`, `if (value == false)`) rather than leaning on truthiness.

Source: *Coding conventions* → Idiomatic use of language features → Nullable Boolean values in conditions. detekt's `NullableBooleanCheck` is inactive.

## Functions

### Prefer an expression body for a single-expression function

Write `fun foo() = 1` rather than `fun foo(): Int { return 1 }`.

Source: *Coding conventions* → Formatting → Functions, and → Expression bodies. `ExpressionBodySyntax` is inactive in this scaffold's detekt config.

### Prefer default parameter values to overloaded functions

Give a parameter a default rather than adding an overload that only supplies it: `fun foo(a: String = "a")`, not `fun foo() = foo("a")` plus `fun foo(a: String)`.

Source: *Coding conventions* → Idiomatic use of language features → Default parameter values. detekt's `MethodOverloading` is inactive.

### Use named arguments for same-typed and `Boolean` parameters

Use named arguments when a call takes several parameters of the same primitive type, or a `Boolean`, unless the meaning is unmistakable from context.

```kotlin
drawSquare(x = 10, y = 10, width = 100, height = 100, fill = true)
```

Source: *Coding conventions* → Idiomatic use of language features → Named arguments. detekt's `NamedArguments` is inactive.

### Prefer a property to a no-argument function when it is cheap and stable

Make a no-argument accessor a property when the computation does not throw, is cheap (or cached), and returns the same result while the object's state is unchanged.

Source: *Coding conventions* → Idiomatic use of language features → Functions vs properties.

### Use extension functions liberally, with narrow visibility

Every time a function works primarily on an object, consider making it an extension function with that object as receiver; keep its visibility as narrow as makes sense (local, member, or private top-level).

Source: *Coding conventions* → Idiomatic use of language features → Extension functions.

### Declare `infix` only for symmetric, non-mutating operations

Declare `infix` only when the two operands play a similar role (`and`, `to`, `zip`), and never on a function that mutates its receiver.

Source: *Coding conventions* → Idiomatic use of language features → Infix functions.

### Give a factory function a distinct name

Name a factory function for what makes it special (`fromPolar`), not the class name; use the class name only when it carries no special semantics.

Source: *Coding conventions* → Idiomatic use of language features → Factory functions. detekt's `MemberNameEqualsClassName` covers only a class *member* named like its class, not a top-level factory.

### Avoid overusing or nesting scope functions

`let` / `run` / `with` / `apply` / `also` are concise but easy to overuse: do not nest them, and be careful chaining them — the current context object and the meaning of `this` / `it` become hard to follow.

Source: *Coding conventions* → Idiomatic use of language features → Scope functions, and *Scope functions* (kotlinlang.org/docs/scope-functions.html). `NestedScopeFunctions` and `AlsoCouldBeApply` are inactive.

## Types

### Model a value type as a `data class`

Give a type that is defined by its data `data class` semantics (`equals` / `hashCode` / `toString` / `copy`) rather than a hand-written class.

Source: *Idioms* → Data classes. detekt's `UseDataClass` is inactive.

### Alias a functional or parameterized type used more than once

Give a functional type or a parameterized type used in several places a `typealias` (`typealias PersonIndex = Map<String, Person>`).

Source: *Coding conventions* → Idiomatic use of language features → Type aliases.

## Lambdas

### Use `it` in short, non-nested lambdas; declare parameters explicitly when nested

In a short, non-nested lambda use the implicit `it`; in a nested lambda with parameters, declare them explicitly.

Source: *Coding conventions* → Idiomatic use of language features → Lambda parameters. `ExplicitItLambdaParameter` only stops you *declaring* `it` explicitly; the nested-lambda half is unenforced.

### Avoid multiple labeled returns in a lambda

Restructure a lambda to a single exit point rather than using several labeled returns, and never label-return its last statement.

Source: *Coding conventions* → Idiomatic use of language features → Returns in a lambda. `ReturnCount` excludes returns from a lambda.

## Strings

### Prefer interpolated strings to concatenation, and multiline strings to `\n`

Prefer an interpolated string to `+` concatenation, and a multiline string to embedded `\n` escapes.

Source: *Coding conventions* → Idiomatic use of language features → Strings. The formatter only strips redundant braces inside an interpolation — it does not choose interpolation over concatenation.

### Use `trimIndent` / `trimMargin` to keep multiline-string indentation

Use `trimIndent` when the result needs no internal indentation, and `trimMargin` when it does.

Source: *Coding conventions* → Idiomatic use of language features → Strings.

## Naming

### Acronym case

For a two-letter acronym, capitalize both letters (`IOStream`); for a longer one, capitalize only the first letter (`XmlFormatter`, `HttpInputStream`).

Source: *Coding conventions* → Naming rules → Choose good names. The detekt naming patterns check shape, not acronym case.

### Name by purpose; avoid `Manager` / `Wrapper`

A class name is usually a noun phrase (`PersonReader`), a function name a verb phrase (`readPersons`), and the name should signal mutation (`sort` mutates in place, `sorted` returns a copy). Avoid meaningless words such as `Manager` or `Wrapper`.

Source: *Coding conventions* → Naming rules → Choose good names. detekt's `ForbiddenClassName` is inactive.

### Underscore-prefix a backing property

When a private implementation property backs a public one, prefix the private one with an underscore (`_elementList` behind `elementList`).

Source: *Coding conventions* → Naming rules → Names for backing properties. `VariableNaming` allows an optional underscore but does not require the pairing.

## Source organization

### Name a file after what it contains

Name a single-type file after the type; otherwise choose a name describing the file's contents and avoid meaningless words such as `Util`.

Source: *Coding conventions* → Source code organization → Source file names. `MatchingDeclarationName` only checks single-declaration files.

### Class layout

Order a class's contents: property declarations and initializer blocks, secondary constructors, method declarations, then the companion object. Do not sort methods alphabetically or by visibility; put related declarations together so the class reads top to bottom. Put nested classes next to their use.

Source: *Coding conventions* → Source code organization → Class layout. detekt's `ClassOrdering` is inactive.

### Keep overloads together

Put overloads next to each other in a class, and keep an interface's implementing members in the interface's order.

Source: *Coding conventions* → Source code organization → Overload layout, and → Interface implementation layout.

## Documentation

### Prefer KDoc prose over `@param` / `@return`

Fold the description of parameters and return values into the KDoc prose, linking parameters where they are mentioned; reserve `@param` / `@return` for a description too long to fit the flow.

Source: *Coding conventions* → Documentation comments. `KdocWrapping` and the `UndocumentedPublic*` rules are inactive.
