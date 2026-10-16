# Coding standards — React lane

The React-idiom rules this scaffold's tooling — Biome (`biome.json`, `linter.rules.recommended: true`) and the TypeScript compiler (`tsc -b`) — does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails on is not restated here. The rules come from the official React documentation (react.dev) — the *Learn* section and the Hooks reference; each names the page and the section it derives from, and, where it matters, the Biome rule that is inactive.

The boundary this doc starts after: Biome's recommended rules already fail a Hook's dependency array (`useExhaustiveDependencies`), a Hook called outside a component (`useHookAtTopLevel`), an array-index key (`noArrayIndexKey`), `any` (`noExplicitAny`), a non-null assertion (`noNonNullAssertion`), an unused variable (`noUnusedVariables`), a `let` that could be `const` (`useConst`), `==` (`noDoubleEquals`), `debugger` (`noDebugger`) and a duplicated element id (`useUniqueElementIds`), and the formatter owns indent, quotes and line width. No rule about those belongs in this file. What is left is the set of *shapes* Biome has no rule for — where state lives, when an effect is the wrong tool, and how data flows.

## State

### Derive during render; never store derived state or sync it in an effect

When a value can be computed from existing props or state, compute it in the component body. Do not add a state variable and a `useEffect` that writes it — that costs an extra render pass and lets two state variables drift out of sync.

```tsx
// Reject — redundant state and an unnecessary effect
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${firstName} ${lastName}`), [firstName, lastName]);

// Prefer — calculated during rendering
const fullName = `${firstName} ${lastName}`;
```

Source: *You Might Not Need an Effect* → Updating state based on props or state; *Choosing the State Structure* → Avoid redundant state. `useExhaustiveDependencies` checks an effect's dependency array — it does not flag that the effect should not exist.

### Group state that always changes together, and forbid contradictory states

If two state variables always change together, merge them; if several variables can disagree, collapse them into one value that can hold only valid states.

```tsx
// Reject — two booleans that can contradict (both true)
const [isSending, setIsSending] = useState(false);
const [isSent, setIsSent] = useState(false);

// Prefer — one variable, three valid states, no impossible combination
const [status, setStatus] = useState<"typing" | "sending" | "sent">("typing");
```

Source: *Choosing the State Structure* → Group related state, and → Avoid contradictions in state.

### Store the identity, not a duplicate of the object

Keep the id (or the index) of a selected item in state, not a copy of the item; derive the item during render. A copied object is duplicated state that goes stale the moment the source list is edited.

```tsx
// Reject — the selected item is a second copy of a row in `items`
const [selectedItem, setSelectedItem] = useState(items[0]);

// Prefer — only the id is state; the item is found during render
const [selectedId, setSelectedId] = useState(0);
const selectedItem = items.find((item) => item.id === selectedId);
```

Source: *Choosing the State Structure* → Avoid duplication in state.

### Do not mirror a prop in state

A state variable initialized from a prop keeps only the first value and silently ignores later updates. Use the prop directly; when a *reset* on prop change is genuinely wanted, name the prop `initial…`/`default…` to say so.

```tsx
// Reject — `color` freezes at the first `messageColor` and never updates
const [color, setColor] = useState(messageColor);

// Prefer — read the prop
const color = messageColor;
```

Source: *Choosing the State Structure* → Don't mirror props in state.

### Keep state flat

Model related records as a map of id → record with child-id lists rather than a deep tree. Deeply nested state is awkward to update without copying the whole parent chain.

Source: *Choosing the State Structure* → Avoid deeply nested state.

### Replace state; never mutate it

Treat props, state and context as read-only during render — copy an object/array and change the copy. Mutating state in place makes a component impure and unpredictable. Mutating an object you *just* created inside the same render (local mutation) is fine.

```tsx
// Reject — mutates a preexisting array in place
items.push(next);

// Prefer — a new array
setItems([...items, next]);
```

Source: *Keeping Components Pure* → Side Effects: (un)intended consequences, and → Local mutation; *Extracting State Logic into a Reducer* → Writing reducers well ("update objects and arrays without mutations").

### Use the functional updater when the next state depends on the previous

State is a snapshot for the render, so `setCount(count + 1)` called several times in one handler sets the same value each time. Pass an updater function — `setCount((c) => c + 1)` — whenever the new value is computed from the old one.

Source: *State as a Snapshot* → Rendering takes a snapshot in time; *Queueing a Series of State Updates* → Updating the same state multiple times before the next render.

### Read state as the snapshot of the current render

A state variable's value is fixed for the whole render, even inside an async callback created there. Do not read it right after setting it and expect the new value — compute the next value into a local, or move the read into the next render.

Source: *State as a Snapshot* → State over time.

### Lift shared state up instead of synchronizing two state variables

When two components must agree on a value, hoist the state to their closest common parent and pass it down, or make the child fully controlled. Keeping two copies in sync — usually through an `onChange` effect — is the bug factory the lift removes.

Source: *Sharing State Between Components*; *You Might Not Need an Effect* → Notifying parent components about state changes.

### Reset a subtree with `key`, not an effect that clears state on a prop change

To reset all state when an identity prop changes, split the component and pass the identity as `key`; React resets the subtree for free. An effect that calls a setter on every prop change renders once with the stale value first and has to be repeated in every nested component.

```tsx
// Reject — resets one variable, after a stale render
useEffect(() => setComment(""), [userId]);

// Prefer — the whole subtree resets when the key changes
<Profile key={userId} userId={userId} />;
```

Source: *You Might Not Need an Effect* → Resetting all state when a prop changes; *Preserving and Resetting State* → Option 2: Resetting state with a key.

## Effects

### Event logic belongs in the event handler, not in an effect

Code that runs because the user *did* something belongs in the handler for that event; an effect is for code that runs because the component was *displayed* (synchronizing with an external system). An effect that reacts to an event-shaped state change re-fires on unrelated remounts and refresh.

Source: *You Might Not Need an Effect* → Sharing logic between event handlers, and → Sending a POST request.

### An effect is for synchronizing with an external system — nothing else

Before writing an effect, ask why the code must run: only "because the component was displayed" justifies one. Transforming data for rendering, and responding to a user interaction, are the two common cases that never need an effect.

Source: *You Might Not Need an Effect* → How to remove unnecessary Effects.

### Do not chain effects that adjust state only to trigger each other

A chain of effects where each sets state to fire the next re-renders the tree between every `set` and is rigid under new requirements. Calculate what you can during render and do the rest in the one event handler that caused it.

Source: *You Might Not Need an Effect* → Chains of computations.

### Subscribe to an external store with `useSyncExternalStore`, not an effect

For data that changes outside React (a browser API, a third-party widget), `useSyncExternalStore` is the purpose-built hook; a manual subscribe/unsubscribe effect is the hand-rolled version it replaces.

Source: *You Might Not Need an Effect* → Subscribing to an external store; `useSyncExternalStore` reference.

### Give a data-fetching effect a cleanup that ignores stale responses

A fetch keyed on props/state races: a slower earlier response can land after a later one and show the wrong data. Return a cleanup that flips an `ignore` flag so only the last request's response is applied — or, better, move the fetch into a custom hook or the query layer.

Source: *You Might Not Need an Effect* → Fetching data.

## Render purity

### Keep render pure

A component's render must compute JSX and nothing else — same props and state, same output; no mutation of props/state/external objects, no I/O, no logging side effects. Side effects go in event handlers, or in an effect as a last resort. This is the premise every other rule here rests on.

Source: *Keeping Components Pure* → Purity: Components as formulas, and → Where you can cause side effects.

## Composition

### Compose with `children` (or a prop) instead of drilling props through intermediates

When an intermediate component only forwards a prop it does not use, pass the rendered element as `children` (or as a prop) from the parent that owns it. Prop drilling couples the intermediate to data it never touches; composition keeps each component's interface about what it actually renders. Reach for the JSX spread (`{...props}`) only in the rare component that genuinely forwards everything.

Source: *Passing Props to a Component* → Passing JSX as children, and → Forwarding props with the JSX spread syntax.

### Declare components at module scope; never define one inside another

A component declared in another component's body is a new function type on every render, so React unmounts and remounts its subtree — losing its state — each pass. Declare it at module scope and pass the varying data as props.

Source: *Preserving and Resetting State* → Different components at the same position reset state.

## Component identity and keys

### Give each list item a stable identity key

A key must identify the item, not its position: use the record's own id, not the array index. `noArrayIndexKey` flags the index key, but a non-identity key such as `Math.random()` or a derived value still silently resets the wrong item's state.

Source: *Preserving and Resetting State* → Option 2: Resetting state with a key; *Rendering Lists* → Keeping list items in order with key.

## Hooks and reuse

### Extract shared stateful logic into a custom Hook named `use…`

When two components duplicate the same state-and-effect logic, move it into a function whose name starts with `use` and a capital. Custom Hooks share *logic*, not state — each call gets its own state — so lift the state itself when it must be shared. Do not prefix a function that calls no Hooks with `use`.

```tsx
// Reject — the same subscribe/unsubscribe effect copy-pasted into two components
// Prefer — one hook both components call
function useOnlineStatus(): boolean { /* useState + useEffect here */ }
```

Source: *Reusing Logic with Custom Hooks* → Custom Hooks: Sharing logic between components, → Hook names always start with use, and → Custom Hooks let you share stateful logic, not state itself.

### Reach for `useReducer` when state updates spread across many handlers

When several event handlers each carry a slice of the update logic, move it into one pure reducer that takes the state and an action and returns the next state; handlers then only dispatch what happened. A reducer is pure, testable in isolation, and keeps the "how" out of the component.

Source: *Extracting State Logic into a Reducer* → Consolidate state logic with a reducer, and → Writing reducers well.

## Refs

### Use a ref for a value that does not drive rendering; do not read or write it during render

Keep a value in a ref when it must survive re-renders but changing it should *not* re-render (a timer id, a DOM node, an object you pass to an external API). Reading or writing `ref.current` during render makes the output unpredictable — if the value is shown on screen, it belongs in state.

Source: *Referencing Values with Refs* → Differences between refs and state, and → Best practices for refs.

## Performance

### Memoize only a measured, expensive, pure calculation

Wrap a calculation in `useMemo` only when it is genuinely expensive (roughly, it loops over thousands of items) and pure — it runs during render. Caching a cheap calculation adds code and a dependency array for no gain; measure before memoizing.

Source: *You Might Not Need an Effect* → Caching expensive calculations.

## Data fetching

### Fetch through the typed client and the query layer, never a raw `useEffect`

Every call goes typed function in `api/client.ts` → hook in `api/queries.ts` → consumed from a `pages/` component; `fetch` is never called from a component. The query layer owns caching, deduping, retries and race handling that a hand-rolled effect would have to reimplement (see this lane's `AGENTS.md`).

Source: this lane's `AGENTS.md` → Layout; *You Might Not Need an Effect* → Fetching data.
