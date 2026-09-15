# Context compaction trace replay

deterministic local replay, not provider traffic

Decision-marker visibility is a synthetic coverage check, not task success. Raw evidence remains persisted in every strategy. No closed-loop real-model quality or provider cache/cost measured.

| Strategy | Cuts | Total estimated input | Final decision markers | Constraints visible | Receipt chars avoided |
|---|---:|---:|---:|---|---:|
| legacy-threshold | 57 | 3945360 | 13 | true | 0 |
| hysteresis-only | 6 | 4704261 | 16 | true | 0 |
| context-epochs | 3 | 4192714 | 71 | true | 4088530 |

Cost units in JSON are explicitly hypothetical, not provider-reported dollars or cache hits.
