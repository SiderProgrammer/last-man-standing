# Cost Estimate

Model: **sonnet** ($3.00/M input, $15.00/M output)
Mode: **automatic**
Selected contracts: **14**
Selected functions: **64** — scale 1.4x (large)

| Stage                              | Count | Input    | Output  | Cost     |
|------------------------------------|-------|----------|---------|----------|
| Protocol Analyzer (conditional)    |     1 |      70k |   11.2k |    $0.38 |
| Discovery agents                   |     5 |     560k |     84k |    $2.94 |
| Synthesizer                        |     1 |      70k |   16.8k |    $0.46 |
| Implementers                       |     2 |     168k |     42k |    $1.13 |
| Report Writer                      |     1 |      42k |   11.2k |    $0.29 |
| Orchestrator overhead              |     1 |     350k |     56k |    $1.89 |
| TOTAL                              |       |    1260k |  221.2k |    $7.10 |

**Estimated total: $7.10** — expected range $4.97 – $10.65

These numbers are Anthropic list-price estimates for the subagents and a rough orchestrator overhead share. Actual cost varies with: coverage-iteration cycles (Step 8), re-runs after compile errors, handler complexity, whether x-ray skipped the Protocol Analyzer, and prompt-cache hit rate. Treat this as a ballpark, not a commitment.
