# Coding standards — React lane

The React-idiom rules the scaffold's tooling (Biome, `tsc`) does **not** enforce. The `code-review` Standards axis reads this file; a rule the tooling already fails on is not restated here. The gaps are the *shapes* Biome has no rule for — where state lives, when an effect is the wrong tool, and how data flows.

## R1 — Derive during render; never store derived state or sync it in an effect

When a value can be computed from existing props or state, compute it in the component body. Do not add a state variable and a `useEffect` that writes it — that costs an extra render pass and lets two state variables drift out of sync.

```tsx
// Reject — redundant state and an unnecessary effect
const [fullName, setFullName] = useState("");
useEffect(() => setFullName(`${firstName} ${lastName}`), [firstName, lastName]);

// Prefer — calculated during rendering
const fullName = `${firstName} ${lastName}`;
```

## R2 — Event logic belongs in the event handler, not in an effect

Code that runs because the user *did* something belongs in the handler for that event; an effect is for code that runs because the component was *displayed* (synchronizing with an external system). An effect that reacts to an event-shaped state change re-fires on unrelated remounts and refresh.

## R3 — Reset a subtree with `key`, not an effect that clears state on a prop change

To reset all state when an identity prop changes, split the component and pass the identity as `key`; React resets the subtree for free. An effect that calls a setter on every prop change renders once with the stale value first and has to be repeated in every nested component.

## R4 — Lift shared state up instead of synchronizing two state variables

When two components must agree on a value, hoist the state to their closest common parent and pass it down, or make the child fully controlled. Keeping two copies in sync (often through an `onChange` effect) is the bug factory the lift removes.

## R5 — Keep render pure

A component's render must compute JSX and nothing else — no mutation of props/state/external objects, no I/O, no logging side effects. Side effects go in event handlers or effects. This is the premise every other rule here rests on.

## R6 — Compose with `children` (and props) instead of drilling props through intermediates

When an intermediate component only forwards a prop it does not use, pass the rendered element as `children` (or as a prop) from the parent that owns it. Prop drilling couples the intermediate to data it never touches; composition keeps each component's interface about what it actually renders.

## R7 — Do not define a component inside another component

A component declared in another component's body is a new function type on every render, so React unmounts and remounts its subtree (losing state) each pass. Declare it at module scope and pass the varying data as props.

## R8 — Subscribe to an external store with `useSyncExternalStore`, not an effect

For data that changes outside React (a browser API, a third-party widget), `useSyncExternalStore` is the purpose-built hook; a manual subscribe/unsubscribe effect is the hand-rolled version it replaces. Data fetching belongs in a custom hook or the scaffold's TanStack Query, never a raw `useEffect` (see this lane's `AGENTS.md` for the data-fetching rule).
