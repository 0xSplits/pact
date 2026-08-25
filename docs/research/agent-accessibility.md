# Making PACT Agent-Accessible

Research notes, 2026-08-19. Question: how can AI agents (acting for humans)
(a) do everything a human can do with PACT — create, buy public/private,
withdraw, refund, issue vouchers, read status — and (b) discover PACT when
working on onchain fundraising / cap-table problems. Every claim links to a
primary source (spec, first-party docs, or source code).

## Executive summary

An important baseline: **PACT is already agent-usable**. The contracts are
Basescan-verified ([contracts/README.md](../../contracts/README.md#deployment)), the full ABIs are
checked into the repo (`src/generated/offering-contracts.ts`), and every
action is a plain contract call — an agent with `cast` or viem and a funded
key can do everything a human can today, and computer-use agents can drive
the existing browser UI. The gap is _packaging_ (so agents don't have to
reverse-engineer the flows) and _discovery_ (so agents find PACT at all).

Ranked by value-per-effort, real today first:

1. **Docs + verified source as the agent surface** (near-zero effort, real
   today). Verified source with NatSpec on Basescan/Sourcify is fetchable by
   any agent with web access; the repo's `docs/` already explain every flow.
   Polish: verify per-offering `Offering`/`PactToken` instances (not just the
   factory) and richen NatSpec — that text is what an agent reads.
2. **`llms.txt` + agent page on pact.splits.org** (hours, real-ish today).
   The format is trivial for a static Vite site (drop files in `public/`).
   Publishing-side adoption is broad (Anthropic, OpenAI publish one); no
   major agent runtime documents _automatically_ fetching it, but agents
   with fetch tools do follow it when a site advertises it. Cheap enough
   that weak fetch-side adoption doesn't matter.
3. **A PACT Agent Skill** (a day, real today in Claude Code / Claude apps).
   A `SKILL.md` teaching the ABI, curve math, voucher format, and lifecycle,
   installable via a plugin marketplace (`/plugin marketplace add`).
   Discovery is the weak point — skills reach people who already found PACT.
4. **A PACT MCP server as an npm package (stdio)** (days, real today across
   Claude, OpenAI, and most agent runtimes). The strongest full-capability
   surface: tools wrap the framework-free `src/lib/chain/*` modules the
   frontend already uses. Publish to the official MCP registry for
   discovery. A _remote_ (streamable-HTTP) server would break PACT's
   "no server" posture unless hosted as a Vercel function.
5. **AgentKit action provider** (days, real but narrower audience). Plugs
   PACT into the Coinbase agent stack (CDP/Privy/viem wallets, LangChain /
   Vercel AI SDK / MCP adapters) that USDC-on-Base agents already use.
6. **x402** — not applicable directly (PACT has no API to charge for), but
   it is primary evidence that agents transacting USDC on Base at scale are
   real, i.e. PACT's payment rail is the one agents already hold.
7. **ERC-8004** — Draft; registers _agents_, not protocols. Not a PACT
   discovery surface today. Watch, don't build.
8. **OpenAPI** — describes HTTP APIs; PACT has none and shouldn't grow one
   for this. The ABI + a well-known JSON manifest is the serverless
   equivalent.

---

## 1. Model Context Protocol (MCP)

**What it is / status.** MCP is a JSON-RPC 2.0 protocol connecting LLM apps
(hosts/clients) to servers exposing **tools**, **resources**, and
**prompts**. The current spec revision is **2026-07-28**, with a stateless
core ("Stateless, self-contained requests. Per-request capability
negotiation") — [spec](https://modelcontextprotocol.io/specification/2026-07-28).
Two standard transports: **stdio** (newline-delimited JSON-RPC over a
client-launched subprocess) and **streamable HTTP** (each message an HTTP
POST to a single endpoint; replies as JSON or request-scoped SSE) —
[transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports).
Maturity is high and multi-vendor: Anthropic donated MCP to the **Agentic AI
Foundation** under the Linux Foundation, co-founded with Block and OpenAI,
supported by Google, Microsoft, AWS, Cloudflare
([announcement](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)),
and OpenAI supports MCP servers in ChatGPT/Codex and via the Responses API's
MCP tool ([OpenAI docs](https://developers.openai.com/api/docs/mcp)). The
TypeScript SDK is at **v2**, implementing the 2026-07-28 spec, packages
`@modelcontextprotocol/server` / `client`, `registerTool()` with Zod-v4 /
Standard Schema input schemas, `StdioServerTransport` plus streamable-HTTP
middleware for Express/Fastify/Hono —
[typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).

**What a PACT MCP server would be.** A thin npm package whose tools import
the framework-free modules the frontend already uses (`src/lib/chain/curve.ts`,
`voucher.ts`, `offerings.ts`, `routes.ts` — all run under Node today via the
unit tests, and `offerings.ts`/`voucher.ts` take injectable `getLogs`/
`storage`, so a file-backed store replaces localStorage):

- Read tools (no key needed, public Base RPC): `list_offerings`
  (`OfferingCreated` scan from the pinned factory), `offering_status`
  (multicall of `state`/`raised`/`unitsSold`/`minMet`/…), `quote_buy`
  (curve math), `cap_table` (PactToken event scan + `balanceOf`).
- Write tools: `create_offering`, `buy_public`, `buy_private` (decodes the
  voucher URL fragment), `withdraw`, `close_and_withdraw`, `mark_failed`,
  `refund`, `sweep_failed_units`, `set_public_units`, `cancel_allocation`.
- `issue_voucher` is special: it needs the **owner's EIP-712 signature**
  over the allocation struct plus a fresh link key ([docs/onchain.md](../onchain.md)),
  so it either signs with a configured owner key or returns the typed-data
  payload for an external wallet to sign.

**Signing: two modes, support both.**

- _Agent-holds-key_: env-provided private key → viem local account
  (`privateKeyToAccount` + `createWalletClient`) signs transactions and
  EIP-712 typed data headlessly — [viem local accounts](https://viem.sh/docs/accounts/local).
- _Human-signs_: write tools return the unsigned call (`to`, `data`,
  `value`, chainId) — or the EIP-712 payload for vouchers — for the user's
  own wallet to sign. MCP has no wallet-signing primitive; the spec's
  security model in fact expects a human in the loop ("Hosts must obtain
  explicit user consent before invoking any tool" —
  [spec, Security](https://modelcontextprotocol.io/specification/2026-07-28#security-and-trust--safety)).
  Wallet-owning agent frameworks (AgentKit, §5) cover the autonomous case.

**Hosting.** PACT is a static site; there is nothing to run a remote MCP
server on. The fit is a **stdio server distributed on npm**, which users add
with `claude mcp add --transport stdio pact -- npx -y <pkg>` or a committed
project-scope `.mcp.json` — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
This is the standard local-server pattern (the docs' own example: `npx -y
airtable-mcp-server`). A remote streamable-HTTP server would require Vercel
functions — a deliberate departure from "no server code, no rewrites"
([docs/architecture.md](../architecture.md)); only worth it for the
remote-only surfaces (Claude.ai connectors, ChatGPT developer mode, both of
which take a server URL).

**Effort/tradeoff.** Days of work, mostly re-exporting existing modules;
serves every MCP-speaking runtime (Claude Code/Desktop, OpenAI, many
others). Highest-value build item on the list.

## 2. Agent Skills / Claude Code plugins

**What it is / status.** Agent Skills are directories with a `SKILL.md`
(YAML frontmatter: required `name` ≤64 chars and `description` ≤1024 chars;
optional `license`, `compatibility`, `metadata`, experimental
`allowed-tools`) plus optional `scripts/`, `references/`, `assets/`. Agents
load them progressively: ~100-token metadata at startup, body on
activation, referenced files on demand —
[agentskills.io specification](https://agentskills.io/specification).
Anthropic runs an official skills repo installable as a plugin marketplace
(`/plugin marketplace add anthropics/skills`) —
[anthropics/skills](https://github.com/anthropics/skills). Distribution is
via plugin marketplaces: a git repo with `.claude-plugin/marketplace.json`
naming plugins and sources — [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).
There is also an MCP working group standardizing **Skills over MCP**
(skills discovered/consumed through MCP servers) — currently an extension
proposal, not shipped behavior —
[working group](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp).

**What a PACT skill would contain.** A `pact` skill whose body teaches: the
factory address + deploy block, the ABI location (or bundled ABI in
`references/`), the two-tranche model and curve math, the voucher
URL-fragment format and EIP-712 structs (pinned by
`tests/fixtures/voucher-golden.json`), lifecycle rules (when `withdraw` /
`markFailed` / `refund` are callable), and worked `cast` / viem examples.
Much of this is a condensation of [docs/onchain.md](../onchain.md). Ship it
in-repo (`.claude/skills/` works for contributors today) and in a small
marketplace repo for outsiders.

**Effort/tradeoff.** A day. Real today in Claude Code / Claude apps / the
Skills API, and the spec is product-neutral so other runtimes are adopting
it. Weakness: skills are _capability packaging_, not discovery — the user
must already know about PACT to install it. Pairs naturally with the MCP
server (one plugin can bundle the skill + the MCP server config).

## 3. llms.txt

**What it is.** A proposal by Jeremy Howard (published 2024-09-03, updated
through 2026-08-10): a markdown file at `/llms.txt` with a required H1, a
blockquote summary, optional prose, then H2-delimited link lists
(`[name](url): notes`) — [llmstxt.org](https://llmstxt.org/).

**Adoption, honestly.** Publishing-side adoption is real: Anthropic serves
one ([platform.claude.com/llms.txt](https://platform.claude.com/llms.txt) —
an H1 + link-list index of 567 docs pages, plus `llms-full.txt`), and
llmstxt.org claims thousands of sites, auto-generation by Mintlify, and a
Lighthouse audit ([llmstxt.org](https://llmstxt.org/) — their claim).
Fetch-side: **no major agent runtime documents automatically fetching
llms.txt** — I found no primary source from Anthropic, OpenAI, or Google
saying their agents request it unprompted. What does happen: doc sites
embed an in-page pointer ("Fetch the complete documentation index at
…/llms.txt") that agents' fetch tools surface and follow — observable on
[modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2026-07-28)
and Claude Code's own docs. So it works when the agent is already reading
your site; it is not a beacon.

**For PACT.** Two static files in `public/` (zero build change):

- `/llms.txt`: H1 "PACT", blockquote (what it is: onchain cap-table raises,
  USDC on Base, factory address), link list → the four routes, the GitHub
  repo, Basescan factory page, and markdown copies of docs.
- Optionally serve `docs/*.md` (or an `llms-full.txt` concatenation) so the
  links resolve to markdown, not HTML shells — the HTML pages are empty
  mount points until JS runs, so markdown targets matter more for PACT than
  for a server-rendered site.

**Effort/tradeoff.** An hour or two. Worth it purely because the cost is
negligible and the failure mode is "ignored file".

## 4. OpenAPI / machine-readable action descriptions

OpenAPI describes **HTTP APIs** ("a standard, language-agnostic interface
to HTTP APIs" — [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)).
PACT has no HTTP API — "There is no server, no database, and no API"
([docs/architecture.md](../architecture.md)) — so a meaningful OpenAPI doc
would require building the backend PACT deliberately doesn't have.
Anti-goal; skip.

The serverless equivalent already exists in pieces:

- **The ABI is the machine-readable action description.** The [Solidity
  Contract ABI spec](https://docs.soliditylang.org/en/latest/abi-spec.html)
  is exactly the "OpenAPI of contracts": function names, typed inputs,
  state mutability, events. PACT's are checked in
  (`src/generated/offering-contracts.ts`) and served by
  Basescan/Sourcify for the verified contracts (§5).
- **NatSpec is the description field.** The [NatSpec format](https://docs.soliditylang.org/en/latest/natspec-format.html)
  (`@notice`/`@dev`/`@param`) is published with verified source — the one
  place where "docs" live at the same address as the "API".
- A small **well-known JSON** on pact.splits.org (e.g.
  `/.well-known/pact.json`: chainId 8453, factory address, deploy block,
  USDC address, links to ABI + docs + llms.txt) is a one-file, zero-server
  manifest. No standard mandates this shape — mark it as convention, not
  spec — but it gives agents a single stable fetch target and costs a
  static file.

## 5. Onchain agent standards

**ERC-8004 "Trustless Agents".** Status **Draft** (Standards Track: ERC,
created 2025-08-13). Defines three registries — Identity (ERC-721 agent
IDs), Reputation (feedback signals), Validation (re-execution/ZK/TEE
verification) — [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004). It
registers _agents_, not protocols: PACT would appear only as something
agents interact with, not as a registrable entity. Draft status + no
mainnet canon → not actionable for PACT; revisit if it reaches Review/Final
with real deployments.

**x402.** An open payments standard using HTTP 402: server replies 402 with
payment requirements, client signs a payment payload (the "exact" scheme on
EVM rides EIP-3009 `transferWithAuthorization`, USDC's native gasless
transfer), a facilitator verifies and settles —
[coinbase/x402](https://github.com/coinbase/x402). Now stewarded by an
x402 Foundation with AWS, Cloudflare, Stripe, Vercel, Alchemy listed as
supporters; the site reports ~75M transactions/$24M volume in a recent
30-day window (first-party claim) — [x402.org](https://www.x402.org/).
_Relevance to PACT_: x402 monetizes API requests; PACT sells tokens via
contract calls, so there is nothing to wrap in a 402. The real signal is
ecosystem alignment: the standard's primary rail is stablecoins on EVM
chains — the agents it has produced already hold **USDC on Base**, which is
exactly what `buyPublic` costs. PACT needs zero changes to be payable by
this population.

**Coinbase AgentKit.** Open-source toolkit giving agents wallets + onchain
actions; wallet providers are **CDP** (server wallets), **Privy**, and
**viem**; framework adapters include LangChain, Vercel AI SDK, and
`@coinbase/agentkit-model-context-protocol` (an MCP adapter); custom
"action providers" are the extension point (50+ TS actions shipped, with a
generator script) — [coinbase/agentkit](https://github.com/coinbase/agentkit),
[AgentKit docs](https://docs.cdp.coinbase.com/agent-kit/welcome). A PACT
action provider (buy/status/refund against the pinned factory) is the
autonomous-wallet counterpart to the human-signs MCP mode: agents built on
AgentKit hold their own CDP/viem wallet and can transact without a browser.
Moderate effort; audience is narrower than MCP but is precisely
"USDC-on-Base agents".

**Verified source as an agent surface.** Yes, and PACT half-has it. Sourcify
verification publishes source, **ABI and NatSpec** plus `storageLayout` via
a public API, with exact/partial match semantics, and shares data through
the Verifier Alliance — [docs.sourcify.dev](https://docs.sourcify.dev/docs/intro/).
Etherscan's API (`getabi`, contract endpoints) serves the same for
Basescan-verified contracts; the V2 API covers Base as chainid 8453 (paid
tier for API access) — [docs.etherscan.io](https://docs.etherscan.io/supported-chains).
The factory is already Basescan-verified ([contracts/README.md](../../contracts/README.md#deployment)).
Gap: the factory-deployed `Offering`/`PactToken` instances — an agent
inspecting a specific offering address should hit verified source too
(Basescan "similar match" usually covers clones, but explicit Sourcify
verification of the implementation is cheap insurance). NatSpec on the
public entry points (`buyPublic`, `refund`, `createOffering`) is the
docstring agents actually see there.

## 6. Discovery — how agents find protocols today

What is real, with sources:

- **Web search + site fetch.** The dominant path. Agents answering
  "raise a small onchain round" search the web; PACT's discoverability is
  ordinary content: the site, the GitHub repo, docs that name the problem
  in plain words. llms.txt (§3) makes the site legible once landed on.
- **Verified contracts on explorers.** Real for _inspection_ (agent has an
  address → gets source/ABI/NatSpec, §5); weak for _finding_ PACT from a
  problem statement — explorers aren't queried by use-case.
- **Official MCP registry.** Live at `registry.modelcontextprotocol.io`,
  **preview** since September 2025 with the v0.1 API frozen 2025-10-24 (GA
  planned); publish via `mcp-publisher` with namespace ownership proved by
  GitHub OAuth or DNS/HTTP challenge; designed to feed subregistries and
  clients — [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry).
  Publishing a PACT server there is the one _structured_ discovery channel
  that exists today.
- **Anthropic's connectors directory.** [claude.ai/directory](https://claude.ai/directory)
  catalogs 75+ MCP connectors across Claude products; submission goes
  through Claude.ai admin settings; directory servers are addable in
  Claude Code via `claude mcp add` — [Connectors directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq),
  [Claude Code MCP docs](https://code.claude.com/docs/en/mcp). Note: it
  lists **remote** servers, so PACT would need the hosted-HTTP variant to
  appear here.
- **Plugin marketplaces / anthropics/skills.** Any git repo with
  `.claude-plugin/marketplace.json` is a marketplace
  ([docs](https://code.claude.com/docs/en/plugin-marketplaces));
  Claude Code can even suggest plugins from per-plugin `relevance` signals
  ([plugin relevance](https://code.claude.com/docs/en/plugin-relevance)) —
  that suggestion mechanism is the closest thing to _push_ discovery, but
  only within marketplaces the user already added.
- **Speculative:** ERC-8004 registries (§5), "Skills over MCP" (§2), and
  any notion of agents crawling onchain metadata for protocol discovery —
  no primary evidence of production use for any of these.

Honest ranking: search-findable docs > MCP registry entry > marketplaces >
everything onchain.

## 7. Wallet/signing patterns for agents

- **EIP-1193** ([spec](https://eips.ethereum.org/EIPS/eip-1193)) is the
  browser-wallet provider interface — it's how PACT's UI signs today (via
  wagmi) and how a _browser-driving_ agent signs: the human's wallet
  extension still prompts. Computer-use agents get human-in-the-loop
  signing for free through the existing UI; no PACT work needed.
- **Headless viem** is the primary-source pattern for key-holding agents:
  `privateKeyToAccount` → `createWalletClient({ account, chain, transport })`,
  which signs transactions and EIP-712 typed data "before broadcasting …
  over JSON-RPC" with no wallet extension —
  [viem local accounts](https://viem.sh/docs/accounts/local). PACT's
  own e2e suite already exercises this shape (mocked EIP-1193 over a local
  key against anvil), and wagmi's actions sit on viem, so the MCP server
  can share `onchain.ts` logic or use viem directly.
- **CDP server wallets** (via AgentKit, §5) are the managed-custody variant
  of the same thing — likely the most common real agent wallet on Base
  given the x402/AgentKit footprint.
- **EIP-5792 Wallet Call API** is **Final** — `wallet_sendCalls` /
  `wallet_getCallsStatus` batch approve+buy in one prompt
  ([EIP-5792](https://eips.ethereum.org/EIPS/eip-5792)); PACT already uses
  it in the UI ([docs/architecture.md](../architecture.md)).
- **Session keys / delegated permissions**: ERC-7715 ("Request Permissions
  from Wallets", `wallet_requestExecutionPermissions`) is **Draft**
  ([EIP-7715](https://eips.ethereum.org/EIPS/eip-7715)), building on
  ERC-7710 delegation. I found no primary-source evidence of production
  agent runtimes using 4337 session keys against arbitrary dapps in 2026 —
  treat as speculative; design nothing around it.

Practical consequence for PACT: support exactly two signing modes
everywhere (unsigned-payload-out for human wallets; viem local account /
AgentKit wallet for autonomous agents) and let EIP-712 voucher issuance
work in both (sign locally, or emit the typed-data payload).

## Concrete shortlist

1. Verify `Offering` + `PactToken` implementations on Sourcify/Basescan and
   audit NatSpec on public entry points. (~hours)
2. Add `public/llms.txt` (+ markdown doc mirrors) and
   `public/.well-known/pact.json` to the static site. (~hours)
3. Write the `pact` skill; ship in-repo and as a tiny plugin marketplace.
   (~1 day)
4. Build `pact-mcp` (npm, stdio, TS SDK v2) wrapping `src/lib/chain/*`,
   with dual signing modes; publish to the official MCP registry. (~days)
5. Optional, audience-driven: AgentKit action provider; hosted
   streamable-HTTP MCP (requires accepting a Vercel function) to qualify
   for the Anthropic connectors directory.
