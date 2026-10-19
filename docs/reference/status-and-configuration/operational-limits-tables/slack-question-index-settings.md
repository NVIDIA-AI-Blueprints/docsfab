{/* GENERATED:slack-question-index-settings start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Setting | Default | Behavior |
| --- | --- | --- |
| `DOCSFAB_LIVE_AGENT_ASK_INDEX_PAGES` | 6 pages | Pages a Slack question without `target=` may approve from the project's documentation index. The answer names them and, when more pages matched, how many. |
| `DOCSFAB_LIVE_AGENT_ASK_INDEX_PAGE_TEXT_BYTES` | 32,768 bytes (32 KiB) | Bytes of one approved page a Slack question without `target=` passes to the model. A longer page is cut at the bound, and the evidence and the answer say so. |
| `DOCSFAB_LIVE_AGENT_ASK_INDEX_TEXT_BYTES` | 98,304 bytes (96 KiB) | Bytes of approved page text one Slack question without `target=` passes to the model, shared across its pages. Each page gets its whole text or an equal share; a page cut short is marked in the answer. |
{/* GENERATED:slack-question-index-settings end */}
