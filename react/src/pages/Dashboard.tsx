import { useHealth } from "../api/queries.ts";
import { Panel } from "../components/Panel.tsx";
import { formatHealthStatus } from "../lib/format.ts";

// The health-check vertical slice: usecase -> gateway/client -> TanStack Query -> this page. Keep
// this working end-to-end — it's the reference example for "how do I wire a new API call through
// every layer", the frontend equivalent of the health check in the kotlin/python scaffolds.
export function Dashboard() {
  const { data, isLoading, error } = useHealth();

  if (isLoading) return <Panel title="Health">Loading…</Panel>;
  if (error) return <Panel title="Health">Error: {(error as Error).message}</Panel>;

  return (
    <Panel title="Health">
      <ul className="space-y-1 text-sm">
        {data?.map((check) => (
          <li key={check.name} className="flex justify-between">
            <span>{check.name}</span>
            <span className={check.is_healthy ? "text-emerald-400" : "text-rose-400"}>
              {formatHealthStatus(check.is_healthy)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
