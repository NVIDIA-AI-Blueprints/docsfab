{/* GENERATED:repository-text-index-settings start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Setting | Default | Behavior |
| --- | --- | --- |
| `DOCSFAB_REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES` | 8,388,608 bytes (8 MiB) | Largest tracked file the repository inventory reads into the text index that governed search matches literal text against. A larger file is left out by path and counted in LIMITATIONS. |
| `DOCSFAB_REPOSITORY_INVENTORY_TEXT_MAX_TOTAL_BYTES` | 536,870,912 bytes (512 MiB) | Bytes of tracked text the repository inventory holds for governed search, summed over files. Past it, files are left out by path and counted in LIMITATIONS. |
{/* GENERATED:repository-text-index-settings end */}
