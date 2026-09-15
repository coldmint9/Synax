# Prompt cache diagnostic report

Mode: local-fixture

NOT MEASURED: all token usage below is fixture data, not a real cache hit

Requests: 63; Native regressions: passed.

local HTTP/SDK overhead only

| Provider | Phase | Requests | Read coverage | Matched input | Cache read ratio |
|---|---|---:|---:|---:|---:|
| local-openai | cold | 7 | 1 | 70000 | 0 |
| local-openai | continuous | 13 | 1 | 130000 | 0.8 |
| local-openai | post-compaction | 1 | 1 | 10000 | 0.8 |
| local-openai-responses | cold | 7 | 1 | 70000 | 0 |
| local-openai-responses | continuous | 13 | 1 | 130000 | 0.8 |
| local-openai-responses | post-compaction | 1 | 1 | 10000 | 0.8 |
| local-anthropic | cold | 7 | 1 | 70000 | 0 |
| local-anthropic | continuous | 13 | 1 | 130000 | 0.8 |
| local-anthropic | post-compaction | 1 | 1 | 10000 | 0.8 |

Structured fingerprints, first differing blocks, compression phases and usage availability: report.json. No prompt bodies are included.
