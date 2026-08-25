# CLI vs MCP for PACT's Agent Tool Surface

Research notes, 2026-08-24. Question: should the agent-facing tool surface
planned in `.scratch/agent-accessibility/spec.md` §4 (`@splits/pact-mcp`, a
stdio MCP server with 25 tools) be a CLI instead of, or in addition to, an
MCP server? Anchored on [wevm/incur](https://github.com/wevm/incur). Every
claim links to a primary source (source code, first-party docs, or the
authors' own posts); secondary write-ups were used only to locate them.
Inferences are marked as such.

## Executive summary

- **incur's thesis**: a CLI is the cheapest tool surface for an agent when
  it (a) declares schemas for args/options/env/output, (b) emits compact
  structured output, and (c) auto-installs its own discovery layer (skill
  files, MCP registration, `--llms` manifest). The framework's own model of a
  20-command CLI puts a session at 6,747 tokens of upfront MCP schema versus
  805 for its skill-based discovery, and about 3.1x cheaper overall
  ([README, "Session savings"](https://github.com/wevm/incur#session-savings)).
- **One package can be both, cheaply**: incur serves the same command table
  as argv commands, as an MCP stdio server (`--mcp`), and as an HTTP handler
  with `/mcp`
  ([src/Mcp.ts](https://github.com/wevm/incur/blob/main/src/Mcp.ts),
  [README "Serve CLIs as APIs"](https://github.com/wevm/incur#serve-clis-as-apis)).
  The marginal cost of the second transport is an adapter over one schema
  table, not a second product.
- **Anthropic's first-party guidance is now explicitly CLI-first for
  external services**: "CLI tools are the most context-efficient way to
  interact with external services… Claude is also effective at learning CLI
  tools it doesn't already know. Try prompts like `Use 'foo-cli-tool --help'
to learn about foo tool`"
  ([Claude Code best practices, "Use CLI tools"](https://code.claude.com/docs/en/best-practices#use-cli-tools)).
  MCP's stated role is "connect to external services" where "the connection
  and authentication [are] handled by the server"
  ([Extend Claude Code, "MCP vs Skill"](https://code.claude.com/docs/en/features-overview#compare-similar-features)).
- **Host support is the deciding constraint, and it cuts both ways**: every
  terminal harness that can spawn a stdio MCP server can also run a shell
  command (Claude Code, Codex CLI, Gemini CLI, Cursor, opencode). Browser
  hosts (claude.ai, ChatGPT) can do _neither_ — they only reach remote HTTP
  MCP — so PACT's serverless posture already excludes them regardless of
  CLI-vs-MCP (§4).
- **Recommendation**: build the package as a CLI (`pact <command>`) whose
  command table is also served over MCP stdio (`pact mcp`). Keep the
  registry listing, keep the skill, and make the skill teach the CLI first
  with the MCP config as the fallback. Spec deltas in §6.

---

## 1. wevm/incur

**What it is.** "CLI framework for agents and humans", created 2026-02-26,
603 stars, last push 2026-08-16, v0.5.1; authors jxom (73 commits) and tmm
(58) — the viem/wagmi maintainers
([repo](https://github.com/wevm/incur),
[contributors](https://github.com/wevm/incur/graphs/contributors)).
Announcement: "Introducing incur – the CLI framework built for agents and
humans. Automatic discovery for agents enabling a guided experience for
humans, without compromising tokens & context windows. » npx incur skills
add" ([@wevm_dev](https://x.com/wevm_dev/status/2027462075740819963)). I found
no long-form post by jxom or awkweb beyond the README and the
[mintlify docs](https://wevm-incur.mintlify.app/), which restate the README.

**Thesis (from the README).** "Agents can only use your CLI if they know it
exists" ([Agent discovery](https://github.com/wevm/incur#agent-discovery)),
"Agents fail when they guess at argument formats or misinterpret output
structure" ([Well-formed I/O](https://github.com/wevm/incur#well-formed-io)),
and "Every token an agent spends reading CLI output is a token it can't spend
reasoning" ([TOON output](https://github.com/wevm/incur#toon-output)). The
framework's answer is a schema-declared command tree with three generated
discovery surfaces.

**What it generates.** Not a CLI from an OpenAPI spec primarily; the core is
`Cli.create('name', { args: z.object(...), options, env, output, run })`
([Usage](https://github.com/wevm/incur#usage)). From that single table it
derives:

- `--help` text, `--schema` (JSON Schema per command), `--llms` (compact
  Markdown/JSON manifest) ([Global options](https://github.com/wevm/incur#global-options)).
- `my-cli skills add`: generates `SKILL.md` files split by command group and
  installs them into every detected agent's skills directory (Claude Code,
  Codex, Cursor, Gemini CLI, Copilot, opencode, Amp, Windsurf, Cline, Roo,
  Kilo, Continue, Kimi) ([src/internal/agents.ts](https://github.com/wevm/incur/blob/main/src/internal/agents.ts),
  [src/SyncSkills.ts](https://github.com/wevm/incur/blob/main/src/SyncSkills.ts)).
- `my-cli mcp add`: registers `<runner> <pkg> --mcp` as a stdio server via
  `npx add-mcp` plus a direct write for Amp
  ([src/SyncMcp.ts](https://github.com/wevm/incur/blob/main/src/SyncMcp.ts)).
- `--mcp`: starts a stdio MCP server exposing every command as a tool, built
  on `@modelcontextprotocol/server` (pinned at `2.0.0-alpha.4`), lazily
  imported so plain runs don't pay for the SDK
  ([src/Mcp.ts](https://github.com/wevm/incur/blob/main/src/Mcp.ts),
  [package.json](https://github.com/wevm/incur/blob/main/package.json)).
- OpenAPI is an _input_ option: mount any fetch handler and pass a spec to
  generate typed subcommands ([OpenAPI](https://github.com/wevm/incur#openapi));
  remote MCP endpoints can likewise be mounted as command groups
  ([MCP command sources](https://github.com/wevm/incur#mcp-command-sources)).
  Inversely, `cli.fetch` serves the CLI as HTTP with `/openapi.json` and a
  `/mcp` endpoint that uses progressive discovery (`search_tools`,
  `get_tool_details`, `call_read_tool`/write gate) so "command schemas [stay]
  out of `tools/list`" ([MCP over HTTP](https://github.com/wevm/incur#mcp-over-http)).

**How agents invoke it.** As a shell command. `c.agent` is `true` when stdout
is not a TTY, and output defaults to TOON with `--format json|yaml|md|jsonl`
([Agent detection](https://github.com/wevm/incur#agent-detection)). CLIs can
return "call-to-actions" — suggested next commands appended to output so the
agent chains steps "without extra prompting"
([Call-to-actions](https://github.com/wevm/incur#call-to-actions)).
`--token-limit`/`--token-offset` paginate output by tokens
([Token pagination](https://github.com/wevm/incur#token-pagination)).

**Auth/signing.** Nothing crypto-specific. Auth is a schema'd `env` (e.g.
`DEPLOY_TOKEN: z.string()`), middleware (`requireAuth` returning
`c.error({ code: 'AUTH' })`), and OpenAPI `security` schemes turned into
credential options ([Well-formed I/O](https://github.com/wevm/incur#well-formed-io),
[Middleware](https://github.com/wevm/incur#middleware),
[src/Openapi.ts `Config.security`](https://github.com/wevm/incur/blob/main/src/Openapi.ts)).
For PACT this means the framework is neutral on unsigned-vs-key mode; that
stays in PACT's command handlers either way.

**What it says about MCP.** MCP is treated as one of three discovery
channels, not the enemy: "Most CLIs expose tools via MCP or a single
monolithic skill file. incur combines on-demand skill loading with TOON
output to cut token usage across the entire session." The Quickprompt labels
skills "recommended – lighter on tokens" and offers `mcp add` as the
alternative ([Quickprompt](https://github.com/wevm/incur#quickprompt)). The
session model (20-command CLI, 5 calls):

|               | MCP + JSON | One Skill + JSON | incur   |
| ------------- | ---------- | ---------------- | ------- |
| Session start | 6,747      | 624              | 805     |
| Discovery     | 0          | 11,489           | 387     |
| Invocation x5 | 110        | 65               | 65      |
| Response x5   | 10,940     | 10,800           | 5,790   |
| Cost          | $0.0325    | $0.0410          | $0.0131 |

([Session savings](https://github.com/wevm/incur#session-savings); method in
[bench/measure.ts](https://github.com/wevm/incur/blob/main/bench/measure.ts),
which counts MCP cost as the JSON Schema of every tool with `js-tiktoken`.)
Caveat, inference: the "MCP + JSON" column assumes all schemas are injected
every turn. Claude Code's tool search now defers MCP schemas by default
(§3.1), so the 6,747 figure overstates Claude Code specifically; it still
holds for hosts without deferral.

---

## 2. First-party positions on CLI vs MCP

**MCP spec, stated purpose.** "MCP is an open protocol that enables seamless
integration between LLM applications and external data sources and tools…
MCP takes some inspiration from the Language Server Protocol." Features:
Resources, Prompts, Tools; transports stdio and streamable HTTP
([spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)).
The spec's own security section frames tools as "arbitrary code execution"
requiring host consent per invocation — the same trust posture a bash tool
already has. A "Skills over MCP" working group (leads from Nordstrom and
Anthropic) is standardising skill delivery through MCP Resources, evidence
that MCP is converging on the progressive-disclosure pattern skills and CLIs
already have ([charter](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp)).

**Anthropic, "Code execution with MCP".** Loading all tool definitions
upfront and routing intermediate results through the model is the problem;
presenting servers as code in a filesystem the agent explores cuts one
example "from 150,000 tokens to 2,000 tokens—a time and cost saving of
98.7%" ([engineering post](https://www.anthropic.com/engineering/code-execution-with-mcp)).
The mechanism (agent reads a file tree, writes code that calls tools,
filters locally) is what a CLI plus a shell already is.

**Anthropic, "Equipping agents for the real world with Agent Skills".**
Skills bundle instructions and scripts; "Claude can run this script without
loading either the script or the PDF into context. And because code is
deterministic, this workflow is consistent and repeatable." Skills are
positioned to "complement Model Context Protocol (MCP) servers"
([engineering post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)).

**Claude Code docs, explicit ranking.** "CLI tools are the most
context-efficient way to interact with external services. If you use GitHub,
install the `gh` CLI… Claude is also effective at learning CLI tools it
doesn't already know" ([best practices](https://code.claude.com/docs/en/best-practices#use-cli-tools)).
The extension guide's trigger for MCP is "You keep copying data from a
browser tab Claude can't see"; the MCP-vs-skill comparison says MCP is for
when "the connection and authentication [are] handled by the server"
([features overview](https://code.claude.com/docs/en/features-overview)).
Skills can pre-approve a bundled script with
`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)` so it "runs
without prompting" ([skills reference](https://code.claude.com/docs/en/skills#frontmatter-reference)).

**Infracost (first-party engineering post, CLI vendor).** Redesigning their
CLI for agents (`--llm` flag routing through TOON, predicate-pushdown flags
like `--filter`, `--addresses-only`) took one benchmark from 207,017 to
81,697 output tokens and hard questions from 0/6 to 6/6 correct; the post
never considers MCP because "the subprocess invocations happen inside
someone else's harness"
([infracost.io](https://www.infracost.io/resources/blog/we-cut-claude-s-token-usage-79-by-redesigning-our-cli-for-agents)).

**Third-party evals (first-party for their own numbers, otherwise
secondary).** Arize ran Opus 4.6 on 25 GitHub tasks x 5 trials against the
official GitHub MCP server vs two `gh`-teaching skills: correctness equal
(0.83 across arms), tier-4 MCP cost about 6x and latency about 5x higher,
and MCP "frequently escaping to bash". Their conclusion: "MCP plus the
command line"; use MCP for "remote, proprietary tools requiring OAuth and
state management" ([arize.com](https://arize.com/blog/mcp-vs-cli-skills-for-agents-what-our-eval-found-and-which-you-should-use/)).
Scalekit's benchmark (Sonnet 4, 5 GitHub tasks): "MCP uses 1.3x to 80x more
tokens than CLI, primarily due to tool schema overhead", both at 100%
completion ([github.com/scalekit-inc/mcp-vs-cli-benchmark](https://github.com/scalekit-inc/mcp-vs-cli-benchmark)).
Both compare against `gh`, which is in training data; PACT's CLI would not
be, so expect the gap to be smaller (inference).

**OpenAI, Vercel, Cloudflare.** I found no first-party post from any of them
arguing CLI-over-MCP or vice versa. OpenAI's docs treat Codex MCP and skills
as separate features ([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
Vercel's `vercel mcp` command only configures local clients to point at
their _remote_ MCP; it does not expose the CLI's commands as tools
([vercel.com/docs/cli/mcp](https://vercel.com/docs/cli/mcp)).

---

## 3. Concrete tradeoffs

### 3.1 Context cost

- **MCP schemas.** Claude Code defers MCP tool definitions by default ("Only
  tool names and server instructions load at session start"); the `auto`
  mode threshold is 10% of the context window; output is capped at 25,000
  tokens (`MAX_MCP_OUTPUT_TOKENS`) with a warning at 10,000
  ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search)).
  Deferral needs a first-party API and a Claude 4.5+ model; proxies,
  Bedrock, and Foundry fall back to upfront loading (same page). opencode
  warns plainly: "MCP servers add to your context, so you want to be careful
  with which ones you enable" ([opencode docs](https://opencode.ai/docs/mcp-servers/)).
  Cursor and Gemini CLI docs state no deferral or limits
  ([Cursor](https://cursor.com/docs/context/mcp), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)).
  Inference: 25 PACT tools with USDC/units/address fields is on the order of
  5–8k tokens of schema (incur's 20-command model gives 6,747), free on
  Claude Code with tool search and paid every turn elsewhere.
- **CLI.** Costs nothing until the agent runs `pact --help` (a few hundred
  tokens) or a skill loads. Skill descriptions cost about 1.5k characters
  max per skill in the listing; the body loads on use and "stays in context
  across turns, so every line is a recurring token cost"
  ([skills reference](https://code.claude.com/docs/en/skills)).
  incur's `--llms` and per-group skill split exist to keep the discovery
  step at hundreds of tokens ([Session savings](https://github.com/wevm/incur#session-savings)).
- **Output.** Same either way; the CLI can additionally support `--format`
  and filtering so the agent asks for less (incur's `--filter-output`,
  Infracost's predicate pushdown).

### 3.2 Discoverability

- **MCP registry**: `server.json` + `mcp-publisher`, searchable via
  `registry.modelcontextprotocol.io`, consumed by host UIs (spec §6 already
  covers this). Nothing equivalent for CLIs beyond npm search and awesome
  lists.
- **CLI/skill**: `npx skills add`, `--help`, and incur's `skills add` which
  writes skill files into 13 agents' directories
  ([agents.ts](https://github.com/wevm/incur/blob/main/src/internal/agents.ts)).
  Claude Code's own advice for unknown CLIs is `--help`
  ([best practices](https://code.claude.com/docs/en/best-practices#use-cli-tools)).
- Net: the registry is the only _catalog_ that agents' host UIs browse; a
  CLI needs the skill (already planned) to be found. Keeping the MCP entry
  costs one `server.json` whose `args` point at the same package.

### 3.3 Composability

- A CLI composes with shell: `pact quote --units 50 | jq`, loops over
  offerings, `claude -p ... --allowedTools "Bash(pact *)"` for fan-out
  ([non-interactive mode](https://code.claude.com/docs/en/best-practices#run-non-interactive-mode)),
  subagents with `Bash` only, and hooks (a `PreToolUse` hook can block
  `pact buy-*` without `--dry-run` — "Put guardrails in hooks",
  [features overview](https://code.claude.com/docs/en/features-overview)).
- MCP tools compose only through the model's context unless the host does
  code-execution-with-MCP, which is exactly the pattern Anthropic's post
  describes as a workaround ([code execution](https://www.anthropic.com/engineering/code-execution-with-mcp)).

### 3.4 Signing / unsigned-tx flows

- **CLI shape**: `pact buy-public --offering 0x… --units 10` prints the
  ordered `[{to,data,value,chainId,description}]` array to stdout as JSON,
  exit 0; preflight failure prints the decoded revert to stderr, exit non-zero;
  key mode (`PACT_PRIVATE_KEY`) sends and prints decoded events. Chaining
  into a signer is a pipe (`| cast send --json`, or into a wallet CLI). This
  is the same envelope the spec already defines for MCP results, so the
  unsigned/key/dry-run semantics carry over unchanged (spec §4.2).
- **MCP shape**: identical JSON in `content[0].text` (or `structuredContent`),
  errors as `isError`. No advantage for signing; the host has no wallet
  either way. The one thing MCP has that a CLI lacks is **elicitation**
  (server-initiated user prompts, [spec](https://modelcontextprotocol.io/specification/2026-07-28)),
  which could ask "confirm sending 12.5 USDC?" — but the spec already
  decided unsigned mode _is_ the confirmation affordance (§4.3), so this is
  unused.
- Secrets: both read `PACT_PRIVATE_KEY` from env; a CLI additionally can
  take `--dry-run` per call from a permission rule (`Bash(pact * --dry-run)`)
  whereas MCP permission rules match tool names only.

### 3.5 Testing

- CLI: spawn the binary, assert stdout JSON and exit code; no protocol
  client needed. The spec's e2e plan (SDK `Client` + `StdioClientTransport`
  from the `npm pack` tarball, §4.5) still works for the MCP adapter, but
  the bulk of scenario coverage can move to plain `execFile`, which is
  simpler and also exercises the human path.
- incur tests both surfaces from one command map
  ([src/Mcp.test.ts](https://github.com/wevm/incur/blob/main/src/Mcp.test.ts),
  [src/e2e.test.ts](https://github.com/wevm/incur/blob/main/src/e2e.test.ts)).

### 3.6 Host support

| Host                        | Shell / local binary                                 | stdio MCP                                              | Remote HTTP MCP      | Source                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | yes (Bash tool)                                      | yes                                                    | yes                  | [mcp docs](https://code.claude.com/docs/en/mcp)                                                                                                                                                               |
| Codex CLI                   | yes                                                  | yes (`codex mcp add … -- npx …`)                       | yes                  | [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)                                                                                                                                            |
| Gemini CLI                  | yes ("Execute shell commands")                       | yes                                                    | yes (SSE/HTTP)       | [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)                                                                                                                                                    |
| Cursor                      | yes (agent terminal)                                 | yes                                                    | yes                  | [Cursor](https://cursor.com/docs/context/mcp)                                                                                                                                                                 |
| opencode                    | yes                                                  | yes (`type: local`)                                    | yes (`type: remote`) | [opencode](https://opencode.ai/docs/mcp-servers/)                                                                                                                                                             |
| Claude Desktop              | no                                                   | yes (`claude_desktop_config.json`, desktop extensions) | yes                  | [support article](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)                                                                                    |
| claude.ai / Cowork / mobile | sandbox code only, package-manager egress by default | no ("aren't available in Cowork or claude.ai")         | yes                  | [same](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), [sandbox](https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude) |
| ChatGPT web                 | no                                                   | no ("remote MCP-backed tools supplied by plugins")     | yes                  | [ChatGPT MCP](https://learn.chatgpt.com/docs/extend/mcp)                                                                                                                                                      |

Reading: every host that can run a stdio MCP server from npm can also run
`npx pact …` in a shell, except Claude Desktop, which has no shell tool but
does run local stdio servers. Browser hosts need remote HTTP, which the
spec's serverless decision rules out. So a CLI loses only Claude Desktop
unless the package also speaks stdio MCP — which is the "both" option.
Inference: claude.ai's sandbox can `npm install` on Free/Pro/Max, so a
research agent there could in principle run `npx pact get-offering` if the
package exists on npm and RPC egress is allowed; the default "package
managers only" egress would block the RPC call, so treat this as unreliable.

---

## 4. One package, both surfaces

- **incur** is the cleanest example: one command map, `serve()` dispatches
  argv, `--mcp` runs `Mcp.serve(name, version, commands)` over the same map,
  and `cli.fetch` adds HTTP + `/mcp`
  ([src/Cli.ts](https://github.com/wevm/incur/blob/main/src/Cli.ts),
  [src/Mcp.ts](https://github.com/wevm/incur/blob/main/src/Mcp.ts)). Tool
  names are the command path joined (`<group>_<tool>`), input schema is
  args+options merged ([bench/measure.ts `buildToolSchema`](https://github.com/wevm/incur/blob/main/bench/measure.ts)).
  Per-command `mcp: false` or `annotations` opt commands out or tag them
  ([SyncSkills.ts `rootCommand.mcp`](https://github.com/wevm/incur/blob/main/src/SyncSkills.ts)).
- **GitHub** ships two separate products: `gh` (CLI) and
  `github-mcp-server` (Go, stdio via Docker/binary or remote, ~20 toolsets
  with `--toolsets` to limit context)
  ([github/github-mcp-server](https://github.com/github/github-mcp-server)).
  Two codebases, two release trains; the eval literature above treats `gh`
  as the cheaper surface.
- **Stripe** likewise: `stripe` CLI and `@stripe/mcp` / `mcp.stripe.com` are
  separate ([npm @stripe/mcp](https://www.npmjs.com/package/@stripe/mcp)).
- **Playwright**: `@playwright/mcp` is a separate package from the
  `playwright` CLI ([playwright.dev](https://playwright.dev/docs/getting-started-mcp)).
- **Vercel**: `vercel mcp` configures clients for the remote server; the
  CLI's commands are not themselves tools ([docs](https://vercel.com/docs/cli/mcp)).

Cost of doing both, from the incur design: one schema table (already
required for MCP), plus an argv adapter. Node's `util.parseArgs` covers
flags; the tool `inputSchema` (Zod) validates the parsed object either way.
The MCP adapter is the ~40 lines `registerTools` in incur's `Mcp.ts`. The
real cost is _discipline_: tool names, option names, and output envelopes
must stay identical across both, so the skill and README describe one
contract. Adopting incur itself would buy the skill generator, TOON, CTAs,
and 13-agent install for free but pins `@modelcontextprotocol/server`
`2.0.0-alpha.4` and a 0.x framework with two maintainers
([package.json](https://github.com/wevm/incur/blob/main/package.json)); see §6.

---

## 5. Decision rubric

Questions, and what each answer implies:

1. **Can the target hosts run a shell?** If any priority host cannot
   (Claude Desktop, browser hosts), you need MCP for that host — stdio for
   Desktop, remote HTTP for browsers. If all can, a CLI is sufficient and
   cheaper.
2. **Is the tool in the model's training data?** If yes (`gh`, `cast`), the
   CLI is nearly free. If no, you need a discovery artifact regardless:
   skill or `--help` for CLI, schemas for MCP. PACT: no; a skill is already
   planned, so the CLI rides it.
3. **Does the server hold state or credentials the host shouldn't see
   (OAuth, sessions, connection pools)?** MCP's stated strength
   ([features overview](https://code.claude.com/docs/en/features-overview)).
   PACT: no — stateless RPC reads, an env-var key at most, a file ledger.
4. **Do you need server→user interaction (elicitation, progress, sampling)?**
   MCP only. PACT: no; unsigned mode replaces confirmation.
5. **Will agents chain or batch calls?** Shell composition favours CLI;
   spec §4.2 already batches approve+buy inside one call, so chaining is
   modest, but `list_offerings | get_offering` loops and `claude -p` fan-out
   are real.
6. **How many tools, and do hosts defer schemas?** Above roughly 15–20
   tools, upfront MCP schemas are a visible per-turn tax on hosts without
   tool search. PACT: 25 tools.
7. **Do you need a catalog listing?** The MCP registry is the only one host
   UIs browse. Keep a `server.json` if yes; it can point at the same npm
   package.
8. **Who tests it, and how?** `execFile` + exit codes is simpler than an
   MCP client harness; the e2e can cover the CLI broadly and the MCP adapter
   with one smoke test.

Applied to PACT's audiences:

- **Human-driven assistants that sign** (Claude Code, Cursor, Codex with a
  browser wallet elsewhere): all have shells. CLI unsigned output pasted or
  piped to a signer. CLI wins on context and on permission rules
  (`Bash(pact * --dry-run)`).
- **Autonomous key-holding agents** (headless loops, `claude -p`, custom
  harnesses): shells by definition; env-var key mode is identical in both.
  CLI wins on composability and on hooks as guardrails.
- **Research agents** (claude.ai, ChatGPT, web-fetch bots): neither surface
  reaches them without a hosted endpoint. Their surface is `llms.txt`,
  `docs/*.md`, and verified source (spec §2–3). CLI-vs-MCP is moot here.
- **Claude Desktop users**: the one audience that needs stdio MCP and cannot
  run a CLI. Small for a Base fundraising prototype (inference), but the
  `--mcp`/`pact mcp` adapter covers it at near-zero cost.

Constraints check: serverless — both are local npm binaries, fine.
Unsigned-by-default — a JSON-to-stdout contract, fine. 25 tools — argues
for CLI. Registry listing — keep via `server.json` pointing at `pact mcp`.
Paired skill — the skill becomes the CLI's discovery layer, which is the
incur pattern exactly.

---

## Implications for PACT

**Recommendation: build the CLI as the primary artifact and serve the same
command table over MCP stdio from the same binary.** Not MCP-only, and not
CLI-only.

Why not MCP-only (the current spec): every host that would run
`npx @splits/pact-mcp` can run `npx pact`; Anthropic's own docs rank CLIs
as "the most context-efficient way to interact with external services"; the
25-tool schema is a per-turn tax on hosts without deferral; nothing in PACT
needs MCP-only features (server-held auth, elicitation); and shell
composition, `claude -p` fan-out, and hook-based guardrails all favour a
binary. Why not CLI-only: Claude Desktop and the registry listing are cheap
to keep, and the adapter is small once the command table exists.

What changes in `.scratch/agent-accessibility/spec.md` §4 (and knock-ons):

1. **§4.1 packaging**: package `@splits/pact` (or keep `@splits/pact-mcp`
   with bin `pact`; naming is the user's call), `bin: { pact }`. Subcommand
   `pact mcp` (or `--mcp`) starts the stdio server; `server.json` `args`
   become `["-y", "@splits/pact@latest", "mcp"]`. `mcpName` unchanged.
   Add `--dry-run`, `--format json` (default when stdout is not a TTY),
   `--help`, `--schema`. Keep env-only config for RPC/key/ledger; allow the
   same values as flags only if the human path needs them (inference: it
   doesn't; skip).
2. **§4.2 tool surface**: define the 25 commands once as
   `{ name, description, input: zod, run }`; derive argv parsing
   (`util.parseArgs`, stdlib) and `registerTool` from that table. Command
   names are the tool names with `_`→`-` (`buy-public` / `buy_public`).
   Output envelope identical on both: JSON to stdout, exit 0; decoded revert
   or validation error to stderr, exit 1; `isError` on MCP.
3. **§4.3 guardrails**: unchanged; they live in `run`, shared. Add one line:
   the CLI exit code is non-zero whenever nothing was sent, so shell
   pipelines stop on preflight failure.
4. **§4.5 testing**: e2e scenarios drive `execFile('pact', …)`; one MCP smoke
   test (`tools/list` = 25, one `get_config` call) through
   `StdioClientTransport`. Manual pre-publish adds `pact --help` and
   `pact mcp` listing in `/mcp`.
5. **§5 skill**: SKILL.md's execution pointer becomes "run `pact --help`;
   commands print JSON" with the MCP snippet demoted to "for hosts without a
   shell (Claude Desktop)". Add
   `allowed-tools: Bash(pact * --dry-run) Bash(pact get-*) Bash(pact quote *)`
   so reads and dry-runs run without prompts in Claude Code
   ([skills reference](https://code.claude.com/docs/en/skills#frontmatter-reference)).
   Consider generating the command reference section from `pact --llms`-style
   output at publish time, alongside the existing `onchain-recipes.md`
   generation.
6. **§6 versioning**: the semver contract now covers command names, flags,
   and stdout shape as well as MCP tool schemas; they are one table, so one
   rule.
7. **§3 discovery**: `llms.txt` "Tools for agents" lists `npx pact --help`
   first, MCP config second.
8. **Framework choice**: incur is the reference design and would give the
   skill generator, per-agent install, TOON, and CTAs for free, but it is
   0.5.x with an alpha MCP SDK dependency. Reasonable either way; the
   hand-rolled version is one table plus two small adapters and keeps PACT
   on the stable `@modelcontextprotocol/sdk` already in the spec. Revisit if
   incur reaches 1.0 or if the skill generator becomes a maintenance burden.

Not changed: serverless posture, unsigned default, guardrails, the ledger,
the registry listing, the skill's knowledge layer, the AgentKit deferral.
