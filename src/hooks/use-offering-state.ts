import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Address } from "viem";

import { getOfferingState } from "#lib/chain/onchain.ts";
import type { OfferingState } from "#lib/chain/onchain.ts";
import { errMsg } from "#lib/format.ts";

const POLL_MS = 15000;

export type OfferingSnapshot =
  | null
  | { status: "loading" }
  | ({ status: "loaded" } & OfferingState)
  | { status: "error"; error: string };

const stateKey = (offeringAddress?: Address | null, buyer?: Address | null) => [
  "offering-state",
  offeringAddress || null,
  buyer ? String(buyer).toLowerCase() : null,
];

// Live offering snapshot: loads immediately, then re-reads the contract on an
// interval while the tab is visible and whenever the window regains focus, so
// other buyers' purchases show up without a manual reload — react-query
// pauses interval refetches in hidden tabs, refetches on focus, and keeps the
// last good snapshot on screen through in-flight or failed background polls.
//
// Returns { offering, refresh }:
//   offering: null | { status: 'loading' } | { status: 'loaded', ...state } | { status: 'error', error }
//   refresh: invalidates the query (used after transactions)
export function useOfferingState({
  offeringAddress,
  buyer,
}: {
  offeringAddress?: Address | null;
  buyer?: Address | null;
} = {}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: stateKey(offeringAddress, buyer),
    enabled: !!offeringAddress,
    queryFn: () =>
      getOfferingState({
        offeringAddress: offeringAddress!,
        buyer: buyer ?? null,
      }),
    refetchInterval: POLL_MS,
  });

  const refresh = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: stateKey(offeringAddress, buyer),
      }),
    [queryClient, offeringAddress, buyer],
  );

  const offering: OfferingSnapshot = !offeringAddress
    ? null
    : query.data
      ? { status: "loaded", ...query.data }
      : query.isError
        ? {
            status: "error",
            error: errMsg(
              query.error,
              "Could not read onchain offering state.",
            ),
          }
        : { status: "loading" };
  return { offering, refresh };
}
