// The per-invocation chain context every command reads from `c.var.pact`.
// `connect` is the only place viem clients are built; tests hand the CLI a
// fake context through `createCli({ connect })`.
import os from "node:os";
import path from "node:path";

import type { ChainClient } from "@splits/pact-core/chain/client.ts";
import type { KVStorage } from "@splits/pact-core/chain/voucher.ts";
import {
  OFFERING_FACTORY_ADDRESS,
  OFFERING_FACTORY_DEPLOY_BLOCK,
} from "@splits/pact-core/generated/offering-contracts.ts";
import { isAddress } from "@splits/pact-core/validate.ts";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
} from "viem";
import type { Address, Hex, PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Env } from "#pact/env.ts";
import { fileLedgerStorage } from "#pact/ledger.ts";

export type { ChainClient };

export interface Sender {
  sendTransaction(tx: { to: Address; data: Hex; value: bigint }): Promise<Hex>;
}

export interface PactContext {
  chainId: number;
  rpcUrl: string;
  factory: Address;
  deployBlock: number;
  ledgerDir: string;
  ledger: KVStorage;
  client: ChainClient;
  // Key mode when both are set.
  account: PrivateKeyAccount | null;
  sender: Sender | null;
}

export function connect(env: Env): PactContext {
  const factory = env.PACT_FACTORY_ADDRESS
    ? getAddress(
        assertAddress(env.PACT_FACTORY_ADDRESS, "PACT_FACTORY_ADDRESS"),
      )
    : OFFERING_FACTORY_ADDRESS;
  const deployBlock =
    env.PACT_FACTORY_DEPLOY_BLOCK ??
    (factory === OFFERING_FACTORY_ADDRESS ? OFFERING_FACTORY_DEPLOY_BLOCK : 0);
  const chain = defineChain({
    id: env.PACT_CHAIN_ID,
    name: "PACT target chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.PACT_RPC_URL] } },
  });
  const transport = http(env.PACT_RPC_URL);
  const client = createPublicClient({
    chain,
    transport,
    batch: { multicall: true },
  });
  const account = env.PACT_PRIVATE_KEY
    ? privateKeyToAccount(env.PACT_PRIVATE_KEY as Hex)
    : null;
  const sender = account
    ? createWalletClient({ account, chain, transport })
    : null;
  const ledgerDir =
    env.PACT_LEDGER_DIR ?? path.join(os.homedir(), ".pact", "ledger");
  return {
    chainId: env.PACT_CHAIN_ID,
    rpcUrl: env.PACT_RPC_URL,
    factory,
    deployBlock,
    ledgerDir,
    ledger: fileLedgerStorage(ledgerDir, env.PACT_CHAIN_ID),
    client,
    account,
    sender,
  };
}

function assertAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not an address`);
  return value;
}
