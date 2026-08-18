# Repository instructions

These instructions apply to every change in this repository.

## Pull request readiness

Do not describe a change as ready for review, open a non-draft pull request, or
request review until `npm run validate` passes from a clean checkout.

If a required check cannot run, treat the pull request as blocked. State the
exact command and failure, and keep the pull request in draft. Do not substitute
typechecking or unit tests for browser coverage.

Before publishing a pull request:

1. Review the complete diff against its base branch.
2. List every changed user flow and decide explicitly how each is covered.
3. Review `tests/**/*.spec.ts` whenever a page, wallet interaction, route, or
   chain-backed UI behavior changes. Update Playwright coverage when behavior,
   required inputs, enabled states, navigation, or transaction flow changes.
4. Run `npm run validate` and report the result accurately.
5. After opening the pull request, inspect every required CI job. Fix failures
   before calling the pull request ready.

The E2E impact check fails when flow-sensitive frontend files change without a
Playwright spec change. If existing coverage is genuinely sufficient, explain
why in the PR template's `E2E impact override` field. This is an auditable
exception, not a way to skip running E2E.

## Solidity changes

Contract changes should also hold up under the stateful fuzz suite
(`contracts/test/fizz/`, specs in `PROPERTIES.md`) — run
`FOUNDRY_PROFILE=fuzz medusa fuzz --config medusa.json` from `contracts/`;
see docs/testing.md.

## Publishing changes

Stage only files that belong to the change. Inspect staged and unstaged diffs
before committing. Preserve unrelated work in mixed worktrees.
