---
name: pact
description: What PACT is and how to act on it safely. Raise or buy into small onchain rounds that sell cap-table units along a USDC bonding curve on Base, using the pact CLI (or its MCP server) for every read and write.
---

# PACT

PACT sells a slice of a project's cap table, a liquid-split ERC-1155 with
1000 units (1 unit = 0.1%), along a linear bonding curve, in USDC on Base
mainnet. There is no server: the `Offering` contract is the whole backend.
This skill is the knowledge; execution is `pact --help` (the command
skills installed beside this one describe each command).

## Hard facts

- Chain: Base mainnet, chain id 8453.
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals.
- Factory, deploy block, and pointers: `pact config`, or
  https://pact.splits.org/.well-known/pact.json. Every offering is a
  child of that factory; nothing else is a PACT offering.
- Docs: https://pact.splits.org/llms.txt indexes the architecture,
  contract specification, and integration guide.

## Model

- **Offering** = escrow of the for-sale units + a price curve + a
  lifecycle. Created by the factory together with its **PactToken**.
- **Two tranches, one curve.** `publicUnits` are buyable by anyone
  (`buy public`); the rest only through owner-signed allocation links
  (`buy private`). Both price off the same `unitsSold` position.
- **Curve.** Unit `n` costs `priceStart + priceSlope * n`; a batch is the
  sum of consecutive unit prices. `offering quote` returns the exact cost.
- **Minimum.** Once `raised >= raiseMin`, `minMet` latches forever: no
  refunds, withdrawals open, the round is successful.
- **Close date.** Buys stop after it only while the minimum is unmet.

## Lifecycle and what is callable

| Phase  | Condition                                                    | Callable                                                                                    |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| live   | `state == 0` and (`minMet` or now <= closeDate)              | `buy public`, `buy private`, `voucher issue`, `admin *`; `funds withdraw` once `minMet`     |
| limbo  | `state == 0`, `!minMet`, past closeDate                      | `fail mark` (anyone)                                                                        |
| closed | `state == 2` (only via `funds close`, owner, needs `minMet`) | `funds distribute`, `funds withdraw` if anything is left                                    |
| failed | `state == 1`                                                 | `fail refund` (buyer), `fail refund-all` (owner), `fail sweep` (anyone), `funds distribute` |

`offering get` reports `phase` with these names.

## Vouchers in one paragraph

The owner signs an EIP-712 `Voucher` endorsing a throwaway link key; the
link (URL fragment) carries that key. At claim time the key signs the
buyer's address, so an intercepted claim cannot be redirected. One-shot,
capped in USDC, no expiry; cancelling or rotating ownership revokes.
Details and the ledger merge rule: `references/vouchers.md`.

## Safety rails (always)

1. `offering quote` before any buy; pass `--max-cost` from that quote.
2. Buys are two transactions: `USDC.approve(offering, maxCost)` where
   `maxCost` defaults to the quote, then the buy. Never approve more, never approve an address that
   `pact` refuses (it verifies the factory scan first).
3. Check `phase` before writes; the table above says what can succeed.
4. Every write simulates first and returns the decoded revert instead of
   sending. A non-zero exit means nothing was sent.
5. Without `PACT_PRIVATE_KEY` writes return unsigned transactions. Relay
   them with `--format json` and sign in order; `--dry-run` forces this
   even with a key.
6. Names passed with `--name` are emitted onchain forever.

## Executing

- Shell available: `npx @splits/pact --help`, then the command skills.
- No shell (MCP-only host): the same table as tools, named
  `<group>_<command>` (`offering_quote`, `buy_public`), from
  `npx -y @splits/pact@latest --mcp`.
- Direct contract calls from another language:
  `references/onchain-recipes.md`.
