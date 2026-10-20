---
title: "Preview the DocsFab Documentation Site"
description: "Preview this repository's Fern documentation locally or inspect its merge-request Review App. CI publication remains a separate operation."
status: draft
content.type: how-to
---

Preview this repository's Fern documentation locally or inspect its merge-request Review App. CI publication remains a separate operation.

## Prerequisites

Use a DocsFab source checkout with Fern available. CI previews require the configured Fern project and pipeline access.

## Steps

Complete the following steps for the selected task.

1. Run `make fern-dev` from the repository root and open the printed loopback URL.
2. Inspect the navigation, page rendering, and links. For an MR preview, open its Review App after its documentation pipeline succeeds.
3. Check the pipeline or publication job for the exact revision before describing a site as published.

## Delivery Paths

The following paths have separate triggers and authority boundaries:

| Path | Trigger | Current boundary |
| --- | --- | --- |
| Local preview | A maintainer runs `fern docs dev`. | Renders the working tree on a loopback URL. |
| Merge-request Review App | A merge-request pipeline includes relevant documentation, Fern, profile, README, or CI changes. | Creates an MR-scoped preview through the Fern preview component. The preview is deleted when the source branch is deleted, and otherwise expires three weeks after its last deployment. |
| Default-branch build | Any push to `main`, including merges that touch no documentation. | Republishes `main` to a fixed URL through the Fern main component. Republishing is idempotent, and running unconditionally means a build skipped by a failed pipeline is retried on the next merge. The build is not torn down and does not expire. It is not a product release record. |
| Tagged publication job | A pushed Git tag matches SemVer, including an optional prerelease suffix. | Invokes the Fern publish component. The job does not supply product release approval by itself. |

All three CI paths use NVIDIA Fern components pinned to version `0.24.0` in the
repository snapshot for this reference.

The default-branch build is hosted on Fern preview infrastructure, so its URL is
durable rather than permanent; Fern controls retention. Treat the tagged
publication job as the authoritative published site.

## Evidence Sources

Use the checked-in [Fern navigation](../../fern/docs.yml) for routes and
the documentation CI definition for the current preview and publication
triggers. The running review app or publication job remains the evidence for
a particular execution.

## Release Boundary

A valid pipeline configuration or successful preview is not a canonical
product release record. Release notes, support claims, and public-release
status require the separate governance and release evidence defined by the
project. A tag-job definition also does not prove that a particular tag was
authorized or published successfully.
