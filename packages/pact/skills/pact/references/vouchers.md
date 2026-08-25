# Vouchers: issuer mechanics

A private allocation is two EIP-712 signatures under the offering's domain
(`name "PACT"`, `version "1"`, `chainId`, `verifyingContract = offering`):

1. `Voucher(bytes32 allocationId, string buyerName, uint256 amountCapUsdc, address linkKey)`,
   signed by the offering owner (EOA or ERC-1271 contract wallet). The
   `linkKey` is a throwaway key generated per allocation;
   `allocationId = keccak256(linkKey)`.
2. `Claim(bytes32 allocationId, address buyer)`, signed by the link key at
   claim time, binding the claim to the caller.

The claim link is `https://pact.splits.org/buy?offering=<offering>#<fragment>`
where the fragment is base64url JSON `{v:1, a: allocationId, n: buyerName,
c: amountCapUsdc, s: ownerSig, k: linkPrivateKey}`. The link is the sole
capability: whoever holds it can claim, so share it privately.

## With the CLI

- Key mode (`PACT_PRIVATE_KEY` is the owner): `pact voucher issue <offering> --name Ada --cap 2500`
  signs and prints the link.
- Unsigned: `voucher issue` prints the typed data plus a `draft`; have the
  owner sign the typed data (`eth_signTypedData_v4`), then
  `pact voucher complete <draft> <signature>` verifies it (ERC-1271 aware)
  and prints the link.
- `voucher list <offering>` / `voucher get <offering> <id>` show ledger rows
  with the onchain `consumed` flag; `voucher cancel` revokes onchain and
  marks the ledger row.
- Claiming: `pact buy private "<link>" <units>`; the cost must not exceed
  the cap, and the units must fit the private tranche
  (`availablePrivateUnits` from `offering quote`).

## Ledger

Unclaimed links exist nowhere but the issuer's ledger (claims are `Bought`
events and survive). The CLI keeps a bare `AllocationLedgerRow[]` JSON
file per offering at `<PACT_LEDGER_DIR>/<chainId>/<offering>.json`
(default `~/.pact/ledger`), the same shape the web app stores in
localStorage. Rows: `{allocationId, name, amountCapUsd, link, createdAt,
revokedAt?}`.

Merge rule when combining ledgers from two machines (or the browser):
union by `allocationId`; a row with `revokedAt` set beats one without.
Order-independent and idempotent. The CLI applies it on every write, so
concurrent writers never drop a revocation.

## Revocation

- `voucher cancel` consumes the id onchain; the voucher can never be used.
- Transferring ownership invalidates every outstanding voucher (they
  verify against the live owner). Ownership returning to a previous owner
  revives that owner's unclaimed vouchers; cancel explicitly when it
  matters.
