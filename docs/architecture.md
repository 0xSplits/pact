# Architecture

PACT raises small onchain rounds by selling a slice of a project's cap table
along a bonding curve, for USDC on Base. It is a static web app plus a set
of contracts; the chain is the only backend. This document names the
components and walks a raise through them. The layers are specified in
the [contract specification](../contracts/docs/contracts.md) and
[app design](app.md).

## Vocabulary

One term per concept, used consistently across all three documents.

- **issuer** — the party raising money; the offering's owner.
- **founders** — the accounts holding the units minted at creation and not
  offered for sale.
- **offering** — one raise: an escrow of units, a price curve, and a
  lifecycle.
- **units** — the 1,000 shares of a project's cap table; one unit is 0.1%
  ownership.
- **buyer** — anyone purchasing units, publicly or through an allocation.
- **allocation** — a private grant of purchasing power, authorized by an
  issuer-signed voucher and carried by an allocation link.
- **treasury** — the address that receives proceeds and returned units.
- **minimum** — the raise threshold that unlocks withdrawal and makes the
  raise permanently successful.

## Components

**`OfferingFactory`** deploys one `Offering` + `PactToken` pair per raise,
in one transaction. It keeps no registry; its creation events are the only
feed of existing offerings. The app pins a single factory deployment at
build time, with interfaces generated from the contract build and checked
in. A new factory deployment therefore starts with empty listings; offerings
created through an old factory keep working onchain but no longer appear in
the app.

**`Offering`** escrows the for-sale units, prices them along a linear curve
in two tranches — public up to an issuer-adjustable cap, private via
allocations — holds the deposited USDC, and runs the lifecycle: Funding,
then Closed or Failed.

**`PactToken`** is the cap table: an ERC-1155 with 1,000 units of a single
token id. It is a liquid split, so units are live claims on revenue sent to
the project. Its metadata is fully onchain — wallets render the project
without a server.

**The app** is four static pages: `/` lists offerings, `/create` is the
issuer's form, `/status` is the issuer's dashboard, `/buy` is the purchase
page. Pages read the chain over the app's own Base RPC connection; the
connected wallet only switches chains and signs. State travels in the URL:
the offering's address as a query parameter, and an allocation's secret in
the URL fragment, which never leaves the browser.

## A raise, end to end

1. The issuer fills in `/create` and signs one transaction. The factory
   deploys the pair; the token mints founder units to the founders and the
   for-sale units into the offering's escrow.
2. The offering appears on `/` — the app scans the factory's creation and
   purchase events, caching per device and scanning only the delta on later
   visits.
3. Buyers purchase on `/buy`. Public buys are permissionless up to the
   public cap. Private buys go through allocation links: the issuer signs a
   voucher off `/status`, shares the link, and the claimer's purchase is
   authorized by the voucher plus the link key in the fragment. All buys
   price off the same curve.
4. Once the minimum is met, the raise is permanently successful. Anyone may
   trigger a withdrawal; proceeds can only ever reach the treasury.
5. The issuer closes the offering: the sale ends, remaining proceeds are
   withdrawn, and unsold units return to the treasury. The cap table is now
   founders plus buyers, and revenue distributions can begin.
6. If instead the close date passes with the minimum never met, anyone may
   mark the offering failed. Buyers reclaim their deposits themselves —
   refunding returns their units to escrow — and anyone may then sweep the
   escrowed units back to the treasury, reverting the cap table to the
   founders.

## Sources of truth

Three stores, in strict order of authority:

1. **The offering** holds the state of the raise: units sold and remaining,
   money raised and withdrawn, the minimum, the close date, and the
   lifecycle state. It is always authoritative.
2. **The cap-table token** holds ownership, reconstructed from transfer
   events and confirmed by balance reads.
3. **Browser storage** is display convenience only: the per-device event
   cache and the issuer's ledger of unclaimed allocation links. A corrupt
   or missing cache triggers a full rescan — never wrong data — and live
   reads always beat anything cached.

## Trust model

Buyers trust the issuer reputationally, not trustlessly. The minimum is a
coordination signal — "this raise proceeds only if enough others join" —
not a guarantee against a dishonest issuer.

What the contracts do guarantee: deposits can be stolen by no one, and are
refundable if the raise fails; proceeds can only ever reach the treasury;
the advertised public tranche is always deliverable; and an allocation link
is the sole capability needed to claim its allocation, unusable by anyone
who intercepts a claim in flight. The
[contract specification](../contracts/docs/contracts.md) states these
guarantees precisely, along with the trade-offs the design accepts.
