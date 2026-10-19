# IA Clustering Patterns

Guidance for shaping a documentation tree before scaffolding files. Apply these patterns when you have raw input (a list of pages, topics, use cases) and need to decide which become siblings, which become children, and which need a new parent.

Restructuring after files exist is expensive — once a file lives at `docs/foo/bar/baz.md`, its URL, cross-links, and the user's bookmarks all carry the cost of every move. Cluster first.

---

## Heuristics

Run the proposed tree through these checks before generating any files. Each is a smell, not an absolute rule — if a check fires, decide explicitly whether to restructure or accept it.

### Promote a parent overview when peers cluster

**Rule**: ≥3 peer pages share the same Diataxis `content_type` (e.g., three "explanation" pages or four "how-to" pages under the same parent) → wrap them in a sub-overview.

**Why**: Peer pages of the same type read as a list, not as navigation. A parent overview gives the reader an entry point ("Concepts in this area") and lets the leaves shrink to specifics.

**Example**:

Before — three concepts as siblings of unrelated pages:

```
fuzzy-deduplication/
  about-fuzzy-deduplication.md   # explanation
  minhash-explained.md           # explanation
  jaccard-similarity.md          # explanation
  run-deduplication.md           # how-to
  benchmarks.md                  # reference
```

After — concepts grouped under a shared parent:

```
fuzzy-deduplication/
  overview.md                      # explanation (overview)
  concepts/
    overview.md                    # explanation (hub)
    minhash-explained.md
    jaccard-similarity.md
  run-deduplication.md           # how-to
  benchmarks.md                  # reference
```

### Split when a node holds too many children

**Rule**: ≥5 children at any single node → introduce a categorization layer.

**Why**: A long flat list under a heading reads as undifferentiated. Five is the rough threshold where readers stop scanning and start searching. Splitting forces you to name the categories — which usually surfaces a missing concept.

**Example**: a `reference/` section with `api`, `cli`, `env-vars`, `helm`, `metrics`, `performance`, `migration` (7 children). Group into `reference/api-and-cli/`, `reference/operations/` (env-vars, helm, metrics, performance), `reference/migration/`.

### Don't nest a single child

**Rule**: A directory with exactly one child page (and no `overview.md` of its own) → flatten the child up to the parent.

**Why**: `foo/bar/baz.md` where `bar/` only contains `baz.md` adds a directory for no information gain. The path gets longer, the URL gets uglier, and the reader navigates a step that exists only because someone scaffolded a folder out of habit.

**Exception**: leave the directory if you reasonably expect siblings to land there in the next iteration. Document that intent in `overview.md`.

### Decompose pages that hold multiple topics

**Rule**: A single file exceeds ~600 lines, **or** it has ≥4 H2 sections whose subtrees each exceed ~80 lines → propose `overview.md` + child pages, one per substantive H2 subtree.

**Why**: Long pages with several substantial sections almost always contain multiple jobs-to-be-done fused into one URL. Splitting forces each subtree to declare its own audience and Diataxis type; the parent becomes a real orientation page instead of a wall of mixed content. The cost compounds: long pages discourage cross-linking, hide deep anchors, and make every edit a merge-conflict surface.

**Example**:

Before — one 900-line page with five H2 sections:

```
fuzzy-deduplication.md     # overview + minhash + jaccard + banding + tuning + run
```

After — index + leaves, each H2 promoted to its own page:

```
fuzzy-deduplication/
  overview.md                # the overview (was the page's intro + headline content)
  minhash.md
  jaccard.md
  banding.md
  tuning.md
  run-deduplication.md
```

**Exception**: catalog-style reference pages (glossary, env-vars, helm-parameters, release-notes) are intentionally long lists. The lint schema marks them `mode: skip` so they don't false-positive.

`tpl-lint` surfaces this as an `info`-level `long_file` finding; `tpl-migrate-site` consumes the same heuristic to emit concrete split plans.

### Quadrant collisions need a tiebreaker

**Rule**: When two pages share both a `content_type` and a parent, they need a distinguishing axis: scope, audience, or workflow stage. If you can't name the axis, they should probably merge.

**Why**: Two siblings tagged `explanation` under the same parent compete for the reader's "where do I start?" attention. The site-map already flags this for `about-feature` + `concept` — same Diataxis quadrant, peers under a use-case. Either give them an explicit hierarchy (one is the parent overview for the other) or merge.

---

## Patterns

### Hub-and-spoke

**When**: A topic has one canonical entry and several specialized branches readers reach from there.

```
my-topic/
  overview.md          # the hub: orientation, when to use what, links to spokes
  basic-usage.md
  advanced-usage.md
  troubleshooting.md
```

**Use for**: feature areas, use-case sections, reference categories. The hub absorbs the "what is this and where do I go?" weight; spokes stay focused.

### Parent-index-with-leaves

**When**: A cluster of related leaves needs a shared overview but doesn't have meaningful sub-branching.

```
concepts/
  overview.md          # what concepts are in this section, why they matter
  minhash.md
  jaccard.md
  banding.md
```

**Use for**: concept clusters, glossary subsections, troubleshooting categories. Distinguishes from hub-and-spoke by depth — leaves are the same level of specificity.

For an About > Core Concepts implementation, keep the IA destination under
`about/core-concepts/`, but source the landing page from
`conceptual/overview` and each leaf from a suitable template in
`templates/conceptual/`. Template catalog organization does not dictate the
generated site's directory structure.

### Workflow-staged

**When**: Pages must be read in order (tutorial chapters, migration steps).

```
migrate-to-v2/
  overview.md          # overview + ordered list of steps
  01-prepare.md
  02-upgrade-deps.md
  03-update-config.md
  04-verify.md
```

**Use for**: tutorials, migration guides, multi-step setup. Numeric prefixes encode the order in the filename, so URL and disk order match.

### Faceted reference

**When**: A reference area has many entries that readers slice along multiple axes.

```
reference/
  overview.md          # entry points by facet
  by-resource/
    pods.md
    services.md
  by-task/
    deploy.md
    debug.md
```

**Use for**: API references, large config catalogs. Build the facets that match how readers actually search, not the underlying object model.

### When to flatten

Flat is right when:

- The section has two to four peers and no obvious sub-grouping. Don't invent categories to fill space.
- Readers arrive directly via search/links, not by browsing. A flat list has the lowest navigation cost.
- The section is short-lived (a release-notes page, a migration archive). Hierarchy is overhead that'll be deleted.

If you find yourself naming a sub-section "Other" or "Misc," flatten — that name is a confession that the cluster doesn't exist.

---

## Pre-scaffold checklist

Before running `site-scaffold.py`, walk the proposed tree and confirm:

- [ ] No node has ≥5 children without a categorization layer.
- [ ] No directory has exactly one child (unless you expect siblings soon).
- [ ] Every cluster of ≥3 same-content_type peers has a parent overview.
- [ ] Sibling pages with the same `content_type` have a clear distinguishing axis.
- [ ] No file exceeds ~600 lines or has ≥4 substantive H2 subtrees without being split into an index + children.
- [ ] Filenames are topic slugs, not template names (`fuzzy-deduplication.md`, not `feature.md`).
- [ ] Each `overview.md` will have a real job (orientation), not just exist because the directory does.

If any check fires, restructure now. Scaffolding is a one-way door for URLs.
