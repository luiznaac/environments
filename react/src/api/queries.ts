import { useQuery } from "@tanstack/react-query";
import { api } from "./client.ts";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.getHealth,
  });
}
