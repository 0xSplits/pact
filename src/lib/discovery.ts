// The agent-facing discovery surfaces (/llms.txt and /.well-known/pact.json),
// built from the generated contract pin so no hand-copied address can drift.
// Framework-free: scripts/generate-discovery.ts renders these at build time
// and the unit test pins the shape.
import {
  BASE_CHAIN_ID,
  BASE_USDC_ADDRESS,
  USDC_DECIMALS,
} from "#lib/chain/chain.ts";
import { OG_SITE_ORIGIN } from "#lib/og.ts";

export interface DiscoveryInputs {
  factoryAddress: string;
  factoryDeployBlock: number;
  repository: string;
  origin?: string;
}

const DESCRIPTION =
  "Small onchain rounds: sell a slice of a project's cap table (ERC-1155 liquid split, 1000 units = 100%) along a linear bonding curve, in USDC on Base.";

export function wellKnownManifest({
  factoryAddress,
  factoryDeployBlock,
  repository,
  origin = OG_SITE_ORIGIN,
}: DiscoveryInputs) {
  return {
    $comment:
      "PACT protocol manifest. Own convention (no standard mandates this shape); schemaVersion bumps on any incompatible change. Stable fetch target for agents: everything here is static and only changes on redeploy. Generated from src/generated/offering-contracts.ts.",
    schemaVersion: 1,
    name: "PACT",
    description: DESCRIPTION,
    chainId: BASE_CHAIN_ID,
    contracts: {
      offeringFactory: {
        address: factoryAddress,
        deployBlock: factoryDeployBlock,
        verified: `https://basescan.org/address/${factoryAddress}#code`,
      },
      usdc: { address: BASE_USDC_ADDRESS, decimals: USDC_DECIMALS },
    },
    abis: `${repository}/blob/main/src/generated/offering-contracts.ts`,
    docs: {
      index: `${origin}/llms.txt`,
      architecture: `${origin}/docs/architecture.md`,
      contracts: `${origin}/docs/contracts.md`,
      integrate: `${origin}/docs/integrate.md`,
    },
    repository,
    app: origin,
    skill: {
      source: `${repository}/tree/main/skills/pact`,
      install: "npx skills add 0xSplits/pact",
    },
  };
}

export function llmsTxt({
  factoryAddress,
  factoryDeployBlock,
  repository,
  origin = OG_SITE_ORIGIN,
}: DiscoveryInputs): string {
  return `# PACT

> PACT raises small onchain rounds by selling a slice of a project's cap table (a liquid-split ERC-1155, 1000 units = 100%) along a linear bonding curve, in USDC on Base mainnet (chain id ${BASE_CHAIN_ID}). Fully serverless: a static site with the chain as the only backend. Factory: ${factoryAddress} (deployed at block ${factoryDeployBlock}; listings are OfferingCreated scans from there).

All contract interaction is direct onchain calls; there is no HTTP API. Machine-readable protocol facts (addresses, deploy block, ABI pointers) are at ${origin}/.well-known/pact.json. The app pages below are JavaScript apps; the markdown docs are the readable sources.

## Docs

- [Integration guide](${origin}/docs/integrate.md): create an offering, read status, approve + buyPublic, withdraw/refund, from any language
- [Architecture](${origin}/docs/architecture.md): system overview, vocabulary, components, a raise walked end to end
- [Contract specification](${origin}/docs/contracts.md): full onchain behavior, Offering lifecycle, tranches, vouchers, refunds, PactToken

## Contracts

- [OfferingFactory on Basescan](https://basescan.org/address/${factoryAddress}#code): verified source + ABI; deploys a per-raise Offering + PactToken pair
- [Source repository](${repository}): contracts (Foundry) and app in one repo; ABIs checked in at src/generated/offering-contracts.ts
- USDC (Base): ${BASE_USDC_ADDRESS}, ${USDC_DECIMALS} decimals

## Tools for agents

- [Skill](${repository}/tree/main/skills/pact): the protocol model, lifecycle, safety rails, and cast/Foundry recipes for every read and write; install with \`npx skills add 0xSplits/pact\`
- [Well-known manifest](${origin}/.well-known/pact.json): single stable fetch target for chain id, addresses, and pointers

## App

- [Home](${origin}/): live offerings list
- [Create](${origin}/create): deploy a new offering
- [Status](${origin}/status): issuer dashboard for one offering (?offering=0x…)
- [Buy](${origin}/buy): public buys and private voucher claims (?offering=0x…)
- [Terms](${origin}/terms): the offering's terms; with &tx=0x… renders the executed receipt for one purchase
`;
}
