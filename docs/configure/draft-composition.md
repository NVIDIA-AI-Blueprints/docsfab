---
title: "Draft a Composition Record in DocsFab"
description: "Prepare a composition record from a measured route verdict. Drafting does not install or merge a registry record."
status: draft
content.type: how-to
---

Prepare a composition record from a measured route verdict. Drafting does not install or merge a registry record.

## Prerequisites

[Probe the exact model route](probe-model-route.md) and retain its request-policy verdict. Registry changes require their own authorized repository change.

## Steps

Use the command and checks below.

## Draft a Composition Record

Run the draft command with the measured verdict:

```bash
docsfab profile draft --route nvidia-inference-api \
  --model MODEL_ID --verdict harness-compatible --json
```

Draft does not spend and does not write `composition-registry.json`. It prints
a composition-shaped record plus reseal instructions. Paste the record in an
authorized follow-up change, then reseal from `packages/runtime`:

```bash
node --import tsx scripts/reseal-composition-digests.mts
npm run check:composition-digests
```

That command runs `scripts/reseal-composition-digests.mts` from
`packages/runtime`. The draft command never reseals the installed registry
itself.

## Authoritative Sources

The following sources define the behavior this page describes:

- [Profile probe implementation](../../packages/runtime/src/cli/profile-probe.ts)
- [Endpoint compatibility checks](../../packages/runtime/src/profile/endpoint-compatibility.ts)
- [Probe stack](../../packages/runtime/src/profile/probe-core.js)
- [Profile draft implementation](../../packages/runtime/src/cli/profile-draft.ts)
- [Reseal composition digests](../../packages/runtime/scripts/reseal-composition-digests.mts)
