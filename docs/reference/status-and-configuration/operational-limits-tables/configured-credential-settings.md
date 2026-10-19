{/* GENERATED:configured-credential-settings start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Setting | Default | Behavior |
| --- | --- | --- |
| `DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_CHARS` | 12 characters | Shortest configured credential value the exact-match screens compare. You can lower it to 8 to compare shorter values, or raise it to 64 to compare fewer. |
| `DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_FRAGMENT_CHARS` | 16 characters | Shortest piece of a configured credential that matches, so a truncated echo is still found. You can raise it to 64 so that only longer pieces match. |
| `DOCSFAB_SECRETS_CONFIGURED_CREDENTIAL_MIN_DISTINCT_CHARS` | 5 distinct characters | Fewest distinct characters a configured value, or a piece of one, needs to be compared. You can lower it to 1, which turns the rule off, or raise it to 16. |
{/* GENERATED:configured-credential-settings end */}
