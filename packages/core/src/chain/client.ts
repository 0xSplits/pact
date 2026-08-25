// The read seam every core function takes: the slice of a viem public client
// the chain layer needs. The app hands in wagmi's public client, the CLI its
// own viem client, tests a fake; none of them reach the chain any other way.
import type { PublicClient } from "viem";

export type ChainClient = Pick<
  PublicClient,
  | "readContract"
  | "call"
  | "getLogs"
  | "getChainId"
  | "getBlockNumber"
  | "waitForTransactionReceipt"
  | "verifyTypedData"
>;
