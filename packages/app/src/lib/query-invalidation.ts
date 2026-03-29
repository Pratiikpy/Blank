import { QueryClient } from "@tanstack/react-query";

let queryClientRef: QueryClient | null = null;

export function setQueryClient(client: QueryClient) {
  queryClientRef = client;
}

export function invalidateBalanceQueries() {
  queryClientRef?.invalidateQueries({ queryKey: ["readContract"] });
}

export function invalidateAllQueries() {
  queryClientRef?.invalidateQueries();
}
