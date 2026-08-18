# Coverage Targets

Fuzz profile: via_ir required (stack too deep), optimizer_runs=0 — coverage deflated ~10%, targets adjusted (ir-no-opt column).

| Contract | Role | Target |
|---|---|---|
| Offering | Core protocol logic (escrow, curve, tranches, lifecycle) | 70%+ |
| PactToken | Core cap table (custom split/operator logic) | 70%+ |
| OfferingFactory | One-shot deployer, exercised only in setup() | 40%+ |
| vendor/ERC1155, vendor/LiquidSplit | Vendored bases — coverage inherited from callers | n/a |

Known unreachable-by-design paths:

- `Offering.initialize` revert branches (NotFactory/AlreadyInitialized) — factory-only, one-shot in setup.
- `OfferingFactory.createOffering` validation reverts — constructor-time config errors, harness deploys one valid offering.
- `Offering.rescue` USDC/pactToken revert branch — handler always passes the stray token (rescuing USDC is guard-tested by the unit suite).
- ERC-1271 owner-signature path in `buyPrivate` — harness owners are EOAs (smart-wallet owners covered by unit tests).

## Cycle 1 — 2026-08-18

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|
| Offering | Core | 70% | 86% (167/193) | ✅ |
| PactToken | Core | 70% | 70% (17/24) | ✅ |
| OfferingFactory | Setup-only | 40% | 91% (22/24) | ✅ |
| vendor/ERC1155 | Inherited | n/a | 74% | — |
| vendor/LiquidSplit | Inherited | n/a | 88% | — |

All targets met; PactToken's uncovered lines are the view-only `uri()` metadata builder.

## Final campaign — 2026-08-18

| Contract | Role | Target | Hit | Status |
|---|---|---|---|---|
| Offering | Core | 70% | 92% (179/193) | ✅ |
| PactToken | Core | 70% | 91% (22/24) | ✅ |
| OfferingFactory | Setup-only | 40% | 91% (22/24) | ✅ |
| vendor/ERC1155 | Inherited | n/a | 74% | — |
| vendor/LiquidSplit | Inherited | n/a | 93% | — |

Result: 72/74 property tests pass. The 2 failures are the EXPLORATORY, deliberately-falsifiable properties GL-19 (public-tranche starvation) and GL-20 (cap-table collapse) — leads for human review, not confirmed protocol bugs. Harness note: the FizzUSDC token gates `mint`/`transfer` to contract callers so Medusa cannot fabricate untracked USDC by fuzzing the mock directly (that had produced false conservation violations in an earlier cycle).
