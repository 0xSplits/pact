# Open-Sourcing Checklist

Research notes, 2026-08-24. Question: what should change in this repo before
`0xSplits/pact` is flipped from private to public? Every repo claim cites a
`path:line` or a git command; every external claim cites an official source.

## Summary

The repo is in better shape than most private-to-public flips: an MIT
`LICENSE` is committed, `.env` is gitignored, no live API key, RPC URL with a
key, private key, or mnemonic was found in the working tree or in any commit
reachable from `main`, and CI needs no repository secrets. The items that
matter are (1) a license conflict — the app is MIT but ships an AGPL-3.0
file (`contracts/src/vendor/ERC1155.sol`) that `PactToken` inherits, and the
test tree mislabels a solmate-derived file as `Unlicense`; (2) the security
posture — contracts hold real USDC on Base mainnet, the code references an
audit whose findings are not in the repo, and there is no `SECURITY.md`;
(3) a one-line personal note (`rooh@splits.org`, work-style remarks) on an
unpushed local branch that must not be pushed; (4) housekeeping — stale
package name/description, no `repository` field, absolute local paths in
checked-in fuzz notes, and no branch protection.

Commands run for the secret sweep are listed at the end.

---

## Must fix before public

### 1. Resolve the AGPL / MIT license conflict in the contracts

**Evidence.**

- `LICENSE:1-3` — MIT, "Copyright (c) 2026 Splits". `package.json:6` —
  `"license": "MIT"`.
- `contracts/src/vendor/ERC1155.sol:1` — `SPDX-License-Identifier: AGPL-3.0-only`,
  vendored from solmate with one local modification (`:4-8`). Upstream
  confirms the license: solmate's `LICENSE` says "Depends on the file, see
  SPDX-License-Identifier" and `src/tokens/ERC1155.sol` is
  `AGPL-3.0-only` (https://raw.githubusercontent.com/transmissions11/solmate/main/src/tokens/ERC1155.sol).
- `contracts/src/PactToken.sol:7` — `import {ERC1155} from "./vendor/ERC1155.sol"`,
  so the cap-table contract is a derivative of the AGPL file.
- `contracts/src/vendor/ISplitMain.sol:1` — `GPL-3.0-or-later`, copied from
  the GPL-3.0 splits-contracts repo (`:4-6`; upstream LICENSE is GPLv3,
  https://github.com/0xSplits/splits-contracts/blob/main/LICENSE). An
  interface file is a thin case, but the header is what readers see.
- `contracts/src/vendor/LiquidSplit.sol:1` — MIT; upstream
  splits-liquid-template is MIT, "Copyright (c) 2022 0xSplits"
  (https://github.com/0xSplits/splits-liquid-template/blob/main/LICENSE).
- The GNU FAQ on combining GPL-family code with a permissively licensed
  program: "the terms of the GPL apply to the entire combination" and a
  larger work that incorporates GPL-covered code "would have to be licensed
  as a whole under the GNU GPL" (https://www.gnu.org/licenses/gpl-faq.html,
  "GPLIncompatibleLibs" / "IfLibraryIsGPL").

**Why it matters.** Publishing `PactToken` as MIT while it inherits an
AGPL-3.0-only base is a mislabel: a downstream user reading the root
`LICENSE` would believe they can use the contracts under MIT terms. Note the
same solmate base is what upstream splits-liquid-template builds LS1155 on
(`ERC1155.sol:4-6`), so 0xSplits has been here before.

**Recommended change** (pick one; a Splits legal/eng decision):

- (a) Swap the base for a permissively licensed ERC-1155 (solady is already
  a dependency and MIT: `node_modules/solady/package.json:3`; OpenZeppelin is
  MIT). This is the only option that keeps the whole repo MIT. The one local
  modification (`isApprovedForAll` virtual over an internal mapping,
  `ERC1155.sol:6-8`) is small enough to re-apply.
- (b) Keep solmate and state the split honestly: root `LICENSE` stays MIT
  for the app and original contracts, add a `contracts/src/vendor/LICENSE.AGPL-3.0`
  (full text — the AGPL requires the license text to accompany the code)
  and a "Licensing" section in `README.md` and `contracts/README.md`
  saying `PactToken` is AGPL-3.0-only because of its base. The SPDX
  guidance is to let per-file identifiers carry the truth and use explicit
  expressions rather than ambiguous "X/Y" labels
  (https://spdx.dev/learn/handling-license-info/).

Either way, keep the vendor headers byte-identical (`contracts/foundry.toml:14-15`
already excludes them from `forge fmt`).

### 2. Fix the mislabeled test-utility headers

**Evidence.**

- `contracts/test/fizz/utils/StringUtils.sol:1` — `Unlicense`, but `:5-6`
  says "@author Solmate (…LibString.sol)" and "Modified from Solady". Solmate's
  `LibString.sol` is currently MIT
  (https://raw.githubusercontent.com/transmissions11/solmate/main/src/utils/LibString.sol)
  and Solady is MIT, so `Unlicense` (public-domain dedication) is a header
  the vendoring author had no standing to apply.
- `contracts/test/fizz/utils/PropertiesAsserts.sol:1` and `Hevm.sol:1` —
  `Unlicense`, "Modified from Crytic (…crytic/properties…)". Upstream
  crytic/properties is AGPL-3.0 (https://github.com/crytic/properties/blob/main/LICENSE).
- `contracts/test/fizz/utils/DecimalPrinter.sol:1` — `UNLICENSED` (all
  rights reserved), which contradicts the MIT root license for a file
  Splits presumably wrote.
- `contracts/test/fizz/utils/EnumerableSet.sol:1-2` — MIT, OpenZeppelin v5;
  fine, attribution present.

**Recommended change.** Set `StringUtils.sol` to `MIT`, `DecimalPrinter.sol`
to `MIT`, and either (a) rewrite `PropertiesAsserts.sol`/`Hevm.sol` from
scratch (they are small assertion helpers and a cheatcode interface) or (b)
label them `AGPL-3.0-only` with an attribution line. Test-only code does not
ship in the deployed bytecode, but it ships in the repo, and a public repo is
where license scanners look.

### 3. Do not push the `teaching-workspace` branch; prune stale local branches before anyone mirrors

**Evidence.**

- `git log --all -S'rooh@splits.org'` → one hit: commit `473419c` ("Add
  teaching workspace for learning the PACT codebase"), file `NOTES.md`,
  which contains the line "Rooh is a Splits employee (rooh@splits.org).
  Strong on JS/React/Node …" plus notes on working style.
- `git branch -a --contains 473419c` → only `teaching-workspace` (local).
  `git ls-remote --heads origin` → only `main` and
  `worktree/green-meadow-fa2b`. The commit is **not** on GitHub.
- The local checkout also carries ~50 stale `remotes/origin/*` refs (Linear
  branch names like `feature/pe-8542-…`) that no longer exist on the remote
  (`gh api repos/0xSplits/pact/branches` returns two names). They are
  harmless on GitHub, but a `git push --all` or `--mirror` from this machine
  would publish all of them.

**Recommended change.** Delete `teaching-workspace` locally
(`git branch -D teaching-workspace`) or keep it strictly local; run
`git remote prune origin`; delete `worktree/green-meadow-fa2b` on the remote
if it is finished. Never `push --mirror` this clone.

### 4. Add `SECURITY.md` with a disclosure path and the audit status

**Evidence.**

- No `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`,
  issue templates, or `dependabot.yml` exist (`ls` of repo root and
  `.github/`; only `.github/pull_request_template.md` and
  `.github/workflows/ci.yml` are present).
- The contracts are live on Base mainnet: `contracts/README.md:62-65`
  ("The live pin is the v2 `OfferingFactory` at
  `0xE07b04A47945DC6BEF217660F772b4D411Cd57fC` … deploy block 49935597"),
  mirrored at `src/generated/offering-contracts.ts:2-4`.
- The code cites audit findings by ID but the report is not in the repo:
  `PROPERTIES.md:96` ("audit-M-3"), `:106` ("audit M-6"), `:118` ("audit
  Finding 2"), `contracts/test/fizz/Base.sol:184` ("audit H-4"),
  `contracts/src/vendor/LiquidSplit.sol:15-16` ("audit Finding 4"),
  `src/pages/create-app.tsx:188` ("audit M-5"). The findings live in the
  gitignored `x-ray/audit.md` (`.gitignore:16-17`; `x-ray/audit.md:1-3` — a
  "12-agent parallelized Solidity audit (opus)", i.e. an automated internal
  review, not a third-party audit) and in closed PR #54 ("add comments",
  `gh pr view 54`; addressed by commit `55e7c97`).
- Existing status wording: `README.md:11-13` ("unaudited beyond a first
  review … Use at your own risk"), `src/pages/home-app.tsx:82`
  ("Experimental and unaudited — use with caution."), `README.md:122-123`
  ("still need broader real-world testing before public use"),
  `CLAUDE.md:7` ("Prototype").
- GitHub surfaces a root `SECURITY.md` under the repo's Security tab and
  counts it toward the community profile
  (https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository,
  https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories).

**Recommended change.** Add `SECURITY.md` with: a private disclosure
channel (email or GitHub private vulnerability reporting), the in-scope
contracts and the live factory address, an explicit statement that the
contracts have had an internal automated review plus a peer review and no
third-party audit, no bug bounty (or whatever is true), and a pointer to
`PROPERTIES.md` / the fuzz suite. Then either commit a redacted copy of the
review the code cites (so "audit H-4" resolves to something a reader can
open) or reword those references to describe the finding rather than cite
an ID that does not exist publicly.

### 5. Turn on the free public-repo protections before the flip

**Evidence.** `gh api repos/0xSplits/pact --jq .security_and_analysis` →
`secret_scanning: disabled`, `secret_scanning_push_protection: disabled`,
`code_security: disabled`, `dependabot_security_updates: enabled`.
`gh api repos/0xSplits/pact/branches/main/protection` → 404 "Branch not
protected". Making a repo public means "Actions history and logs will be
visible to everyone" and "Anyone can fork your repository"
(https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility);
secret scanning "runs automatically for free" on public repos and covers
"your entire Git history on all branches"
(https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning).

**Recommended change.** Enable secret scanning + push protection, add a
branch protection (or ruleset) on `main` requiring the four CI jobs in
`.github/workflows/ci.yml:14-73` and PR review, and consider
`.github/CODEOWNERS` for `contracts/` so contract changes always route to a
named reviewer.

---

## Should fix

### 6. `package.json` metadata is stale for a public repo

**Evidence.** `package.json:2` — `"name": "splits-pact"` (README title
`README.md:1` matches; the GitHub repo is `0xSplits/pact`, `git remote -v`).
`package.json:4` — description says "a slice of a 0xSplits Liquid Split",
whereas the current model is a custom `PactToken` (`CLAUDE.md:7`,
`contracts/README.md:13-16`). No `repository`, `homepage`, or `bugs` field.
`"private": true` (`:7`) is correct — npm refuses to publish
(https://docs.npmjs.com/cli/v10/configuring-npm/package-json) — and stays.

**Recommended change.** Rename to `pact` (or `@0xsplits/pact`), fix the
description, add `"repository": "github:0xSplits/pact"` and `"homepage":
"https://pact.splits.org"`. Regenerate `package-lock.json:2,8` with
`npm install` so the name matches.

### 7. Strip absolute local paths from checked-in fuzz notes

**Evidence.** `contracts/fizz_data/property-plan.md:7` —
"`/Users/rooh/work/pact/PROPERTIES.md`". The corpus/coverage output that also
contains `/Users/rooh/…` (`contracts/fizz_data/corpus_medusa/coverage/lcov.info`)
is gitignored (`contracts/.gitignore:11-18`) and is not tracked.

**Recommended change.** Replace with the relative `../PROPERTIES.md`.

### 8. Write a short `CONTRIBUTING.md` and point `AGENTS.md`/`CLAUDE.md` at it

**Evidence.** `AGENTS.md:1-45` and `CLAUDE.md` already contain the real
contribution rules (run `npm run validate`, update Playwright specs, fill the
PR template's `E2E impact override`), but a first-time contributor from a
fork does not know to read files named for AI agents.
`.github/pull_request_template.md:1-27` presumes those rules.

**Recommended change.** A one-page `CONTRIBUTING.md` that lists the toolchain
(Node 22.20 per `.nvmrc`, Foundry, Playwright, optionally Medusa), the
`npm run validate` gate, and the branch/commit conventions; have `AGENTS.md`
link to it rather than duplicate. Both `CLAUDE.md` and `AGENTS.md` are fine
to keep public; nothing in them is sensitive (checked by
`git grep -niE 'splits\.org|linear|slack|discord|notion|sentry|grafana'`).

### 9. Make the CI-from-fork story explicit

**Evidence.** `.github/workflows/ci.yml` uses no `secrets.*` — the only
`env:` values are `github.event.pull_request.base.sha` and the PR body
(`:25-27`), and the e2e job runs against a local anvil (`tests/e2e-setup.ts:1-4`).
`.env.example:1-4` documents `VITE_ALCHEMY_API_KEY` and
`VITE_WALLETCONNECT_PROJECT_ID` as optional; `README.md:73-82` says none are
required. GitHub withholds secrets from fork-triggered workflows anyway
("With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner
when a workflow is triggered from a forked repository",
https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions).

**Recommended change.** Nothing to fix in the workflow. Add one line to
`CONTRIBUTING.md`: "CI needs no secrets and runs fully on fork PRs." The
`deploy:factory` script (`package.json:35`) requires a funded key and
`ETHERSCAN_API_KEY` (`contracts/foundry.toml:18`, `contracts/README.md:61-62`)
supplied by the operator's environment only; the pattern is correct.

### 10. Document the deployed addresses in one place, with the right caveat

**Evidence.** The factory address and deploy block appear in
`README.md:91-93`, `contracts/README.md:62-65`, and
`src/generated/offering-contracts.ts:2-4` (regeneration preserves them,
`scripts/export-contracts.ts:19-25`). Other hardcoded addresses are all
canonical, not secrets: Base USDC `contracts/src/Offering.sol:191` and
`src/lib/chain/chain.ts:31`; SplitMain `contracts/script/Deploy.s.sol:10`;
CREATE2 salt `Deploy.s.sol:12`. The fuzz configs pin the Echidna/Medusa
default deployer (`contracts/echidna.yaml:9-12`, `contracts/medusa.json:21-23`).
`docs/research/agent-accessibility.md:14` links a `docs/deployment.md` that
no longer exists.

**Recommended change.** Add a `## Deployments` table (network, contract,
address, block, verification link) to `README.md` and have
`contracts/README.md` link to it; fix the dead `docs/deployment.md` link if
the research note is kept.

### 11. Decide what happens to `docs/research/` and `.scratch/`

**Evidence.** Both are untracked (`git status`). `docs/research/` holds two
long internal research notes (`agent-accessibility.md`,
`pact-mcp-repo-structure.md`) plus this file; `.scratch/agent-accessibility/`
holds drafts. An earlier research note was deliberately dropped from a PR
(`git log --oneline -- docs/research/as-assertions-audit.md` → `203d64b
docs: drop research notes from the PR`).

**Recommended change.** Either commit `docs/research/` intentionally (they
read fine publicly) or add `docs/research/` and `.scratch/` to `.gitignore`
so they cannot leak in a later `git add -A`.

---

## Nice to have

### 12. Community files GitHub's profile checks for

`CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/` (a bug report template that
asks for offering address + tx hash would save triage time), and
`.github/dependabot.yml` for npm and GitHub Actions
(https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories).

### 13. NatSpec author lines and copyright

`contracts/src/Offering.sol:31` — `@author Splits`. Consistent with
`LICENSE:3`. No change needed; noted so nobody "fixes" it to a person.

### 14. Test data names

`src/lib/chain/voucher.test.ts:109` uses `buyerName: "Abram"` — a
collaborator's first name in a fixture. Harmless; swap for a neutral name if
you prefer fixtures not to name people. The golden fixture keys
(`tests/fixtures/voucher-golden.json:5,7`) are `0x…01` / `0x…02` and the
e2e accounts come from anvil's defaults (`tests/e2e-setup.ts`), so no real
key material is present.

### 15. Commit author metadata

`git log --format='%an <%ae>' | sort | uniq -c` → 49 commits from
`Rooh Afza <96720500+r0ohafza@users.noreply.github.com>`, 8 from
`Abram <abramdawson@users.noreply.github.com>`. Both already use GitHub
noreply addresses; nothing to rewrite.

---

## Git-history remediation

**None required.** No secret was found in any commit reachable from `main`
or in any branch on the remote. The one personal-data hit (`rooh@splits.org`
in `NOTES.md`) is on an unpushed local branch — see item 3; deleting the
branch locally is enough, no history rewrite is needed.

Commands run (from the repo root, `git rev-list --count HEAD` = 57 on
`main`):

```sh
# every added/removed line, all refs, common secret shapes
git log -p --all | grep -nEi '(alchemy\.com/v2/[A-Za-z0-9_-]{10,}|infura\.io/v3/[a-f0-9]{20,}|0x[a-fA-F0-9]{64}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|PRIVATE_KEY *= *[^ ]|MNEMONIC|api[_-]?key *[:=] *[\"'"'"']?[A-Za-z0-9_-]{16,}|VITE_ALCHEMY_API_KEY *= *[^ ]|vercel_token|xox[bp]-)'
#   → only the golden-fixture signatures (tests/fixtures/voucher-golden.json,
#     deterministic keys 0x…01/0x…02) and the templated Alchemy URL in
#     src/lib/chain/chain.ts:27 (`${ALCHEMY_API_KEY}`, no literal key)

# keyed RPC URLs / literal env values across every ref
git grep -nEi 'alchemy\.com/v2/|infura\.io|VITE_ALCHEMY_API_KEY=[A-Za-z]' $(git rev-list --all)
#   → only the templated URL above

# .env / key / keystore files ever added
git log --all --name-only --format= | sort -u | grep -Ei 'env|secret|key|broadcast|\.pem|keystore'
#   → .env.example only (its history is two empty placeholders)

# e-mail addresses in any diff
git log -p --all | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' | sort | uniq -c
#   → GitHub noreply addresses, git@github.com, and one rooh@splits.org (item 3)

git log --all -S'rooh@splits.org' --name-only   # → 473419c NOTES.md
git branch -a --contains 473419c               # → teaching-workspace (local only)
git ls-remote --heads origin                   # → main, worktree/green-meadow-fa2b
```

`gitleaks`/`trufflehog` are not installed on this machine; running
`gitleaks git .` before the flip is a cheap second opinion, and GitHub's own
secret scanning will re-scan the full history once the repo is public. If it
finds something this sweep missed, the documented remedy is
`git filter-repo --sensitive-data-removal …` followed by a force push and a
GitHub Support request to purge cached views; data already in forks or
clones cannot be recalled
(https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
