# App Design

The app is the static half of the system: a multi-page site that renders
and transacts against the contracts, holding nothing durable of its own.
Vocabulary is defined in the [architecture document](architecture.md);
the mechanisms it renders are specified in the
[contract specification](../contracts/docs/contracts.md).

## Static pages, state in the URL

The app is four pages — home, create, status, and buy — each a separate
static page with its own small application. There is no client-side
router and no shared shell; state travels in the URL.

The offering's contract address is the record id. The status and buy pages
carry it as a query parameter, which static hosting serves without
rewrites. An allocation link is the buy page's URL plus a fragment holding
the link key — fragments never leave the browser, so the secret is not in
any request, log, or referrer.

Home lists offerings and explains PACT. Create is the issuer's form; it
submits the creation transaction, waits for the creation event, seeds the
local cache from the decoded event, and only then redirects to the status
page. Status is the issuer's
dashboard: offering state, lifecycle actions, allocations, and the cap
table. Buy is the purchase page for both tranches.

## Data

Reads never go through the wallet. The app has its own connection to Base,
so every page renders without a wallet connected and keeps rendering when
the wallet sits on another chain. Pages read the offering on load and poll
while visible, and a live read always beats anything cached.

Listings have no registry to query, so the home page discovers offerings
by scanning the factory's creation and purchase events. Providers cap how
much history one log request may cover, so the scan proceeds in chunks,
and each device caches the results along with the last block scanned —
later visits scan only the delta. A corrupt or missing cache triggers a
full rescan.

The issuer's unclaimed allocation links exist nowhere but the issuer's own
browser storage. That loss semantic is deliberate: losing the ledger loses
only unclaimed links, which cost nothing to re-issue, while claims are
onchain events and survive everywhere. Nothing durable lives in the
browser.

## Wallets

The wallet's job is to switch chains and sign; everything else is the
app's. Wallet discovery lists only wallets the browser actually has. A
purchase batches the USDC approval and the buy into one confirmation when
the wallet supports batching, and falls back to two prompts when it does
not.

The app's own RPC credentials never enter a wallet: any chain metadata
handed to a wallet points at the public endpoint, so a keyed URL cannot
leak through wallet configuration.

All styling is compiled at build time; the app ships no runtime styling
dependency.
