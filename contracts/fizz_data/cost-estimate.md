# Cost Estimate

Model: **opus** ($15.00/M input, $75.00/M output)
Mode: **automatic**
Selected contracts: **2**
Selected functions: **19** — scale 0.7x (small)

| Stage                              | Count | Input    | Output  | Cost     |
|------------------------------------|-------|----------|---------|----------|
| Protocol Analyzer (conditional)    |     1 |      35k |    5.6k |    $0.94 |
| Discovery agents                   |     5 |     280k |     42k |    $7.35 |
| Synthesizer                        |     1 |      35k |    8.4k |    $1.16 |
| Implementers                       |     2 |      84k |     21k |    $2.83 |
| Report Writer                      |     1 |      21k |    5.6k |    $0.73 |
| Orchestrator overhead              |     1 |     175k |     28k |    $4.72 |
| TOTAL                              |       |     630k |  110.6k |   $17.75 |

**Estimated total: $17.75** — expected range $12.42 – $26.62

These numbers are Anthropic list-price estimates for the subagents and a rough orchestrator overhead share. Actual cost varies with: coverage-iteration cycles (Step 8), re-runs after compile errors, handler complexity, whether x-ray skipped the Protocol Analyzer, and prompt-cache hit rate. Treat this as a ballpark, not a commitment.
