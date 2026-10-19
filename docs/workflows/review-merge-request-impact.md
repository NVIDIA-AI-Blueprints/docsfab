---
title: Review Merge Request Impact in DocsFab
description: Run a local review or configure hosted automatic review notes on merge requests.
status: draft
content.type: how_to
---

You can review a merge request revision locally or use DocsFab's hosted GitLab
pilot, which runs an automatic documentation review and posts a note to an
existing merge request. The local path gives you a retained HTML report. The
hosted path requires an activated project and operator-managed GitLab, model,
identity, and authority configuration. For more information, refer to
[About DocsFab Workflows](index.md).

Choose [Local Review](#before-you-start) when you want to run a review from a
checkout. Choose [Hosted Automatic Review](#use-hosted-automatic-review) when
you are onboarding a GitLab project to the operated DocsFab host. Repository
owners do not need to install the local CLI for hosted onboarding.

On October 09, 2026, the hosted review pilot delivered one review note for a
frozen merge-request head. This proves one real review-to-note journey. It does
not prove webhook intake or broad project coverage. Hosted quality validation
remains an open follow-up.

The job is the standalone comprehensive stack: documentation audit, lint,
technical verification, peer review, audience understanding, and quality
evaluation. Refer to the
[review-documentation contract](../reference/workflow-contracts/review-documentation.md)
for scope rules and evidence boundaries.

## Before You Start

Complete the steps in [Install DocsFab](../get-started/installation.md). Prepare a local
checkout of the merge-request source revision, or know the full Git ref you
pass to `--revision`.

Run the offline readiness check and inspect the catalog:

```bash
cd /absolute/path/to/input-repository

docsfab doctor
docsfab list
```

Expected result: Doctor reports ready conditions. `docsfab list` includes
`review-documentation`.

This local path does not require write authorization. A live `run` needs the
runtime model profile. Hosted notes require separate host configuration. Refer to
[GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md).

## Steps

<Steps>
  <Step title="Pin the merge-request revision">
    Pin the merge-request revision. Check out that source revision, or pass
    `--revision` with that ref. The review binds the frozen revision. It does
    not review uncommitted work.

    Expected result: `git rev-parse HEAD` or the `--revision` value identifies
    the merge-request source you intend to review.
  </Step>
  <Step title="Run the read-only review">
    Run the read-only review.

    ```bash
    docsfab run review-documentation --repo /absolute/path/to/input-repository
    ```

    Pass `--revision <ref>` when HEAD is not the merge-request revision.

    Expected result: The job produces findings and quality evidence without
    a write grant. It does not edit files, open a merge request, or merge.
  </Step>
  <Step title="Optional: focus named pages">
    Focus the review on named pages. An explicit `--context-path` takes
    precedence over paths mentioned in the instruction.

    ```bash
    docsfab run review-documentation \
      --repo /absolute/path/to/input-repository \
      --context-path docs/get-started/installation.md
    ```

    Expected result: Missing or unrecognized targets stop the run before
    inference. Supporting source reads do not expand the reviewed set.
  </Step>
  <Step title="Inspect the saved run">
    Inspect the saved run.

    ```bash
    docsfab runs show <run-id>
    ```

    Expected result: The record names `review-documentation`, the frozen
    revision, and the retained report location when a report exists. Audience
    `insufficient-evidence` remains visible. It does not become a single
    readiness score.
  </Step>
  <Step title="Serve the retained HTML report">
    Serve the retained HTML report from the same operator state directory.

    ```bash
    docsfab reports serve --state-dir '/absolute/operator/state' --port 8787
    ```

    Run the foreground server in a separate terminal from `runs show`. The
    HTML route is `/reports/<run-id>/`. The default listen address is
    `127.0.0.1:8787`. Binding to `0.0.0.0` exposes the server beyond loopback
    and requires an operator decision.

    Expected result: `GET /reports/<run-id>/` returns the HTML review page.
    Serving a report does not publish documentation or grant write, repository,
    or merge authority.
  </Step>
</Steps>

For machine consumers, add `--json` and read the single JSON object on
stdout. Do not scrape the human footer or skill Markdown. Refer to
[Runner Quickstart](../get-started/runner-quickstart.md) for the findings
projection contract.

## Use Hosted Automatic Review

The hosted pilot watches merge-request open and update events through the
activated project's configured GitLab change source. It runs
`review-documentation` against the observed head and reconciles one bot-owned
summary note on that existing merge request. A changed head starts a review
bound to the new revision; a stale result cannot be posted as current. A
project can use polling or webhook intake, but webhook delivery requires its
own configured ingress and verification.

### What You Supply

The repository owner supplies these project facts to the DocsFab operator:

- The canonical GitLab project identity, its intended polling or webhook
  intake mode, and an approved repository source.
- The registered canon and input manifest that define documentation scope,
  plus the frozen Product Reference Model context used by review.
- The DocsFab Review grant and GitLab principal mappings for merge-request
  actors whose events should run `review-documentation`.
- The approved model execution profile and model credential, plus the bot's
  numeric GitLab user ID and a separate protected note credential.
- The project owner who will approve activation and the people who can verify
  a note on a real merge request.

Do not send credential values in chat or commit them to the repository. Keep
these credential roles separate:

- The GitLab checkout key and pinned `known_hosts` allow the host to fetch the
  approved repository source.
- Poll mode uses a GitLab `read_api` token to observe merge-request changes.
  Webhook mode uses a verification secret instead and requires separately
  configured ingress.
- The model credential supports the approved execution profile.
- The GitLab note credential allows the configured bot to create or update
  its summary note on the project. The pilot configuration uses an `api`
  scoped token with Reporter access or higher.

The operator stages these values through protected host procedures. The
deployment host also needs its supported Linux environment, PostgreSQL
service, persistent state, and connectivity to the approved model provider.
The operator follows the organization's approved host deployment procedures
and uses its supported activation contract.

### Operator Setup

The operator confirms that the host runs a reviewed release with the hosted
GitLab review-summary persistence upgrade. The operator handles host
installation and persistence changes through the approved deployment
procedures. These are separate from project onboarding; there is no one-command
project onboarding installer.

The operator and project owner then:

1. Prepare the supported activation input, identity mappings, repository
   grants, frozen context, and model policy. Select only the
   `review-documentation` workflow and its read-only composition. Do not apply
   the full pilot workflow selection, which also enables write workflows and
   product-feedback reconciliation. Check the supported activation fields and
   package requirements against the host activation contract. The checked-in
   example contains placeholders, expired dates, and an
   offline-fixture composition, so it is not ready to run.
2. Stage the source, model, and note credentials in the protected credential
   directory. Poll mode uses a read-only `read_api` source token. Webhook mode
   uses a webhook secret instead. The note credential is separate and is
   bound to the configured bot identity and `create-or-update-summary-note`
   access.
3. Set the project's standing repository grant to `review` and install the
   workflow and identity policies. Open/update events are eligible only when
   the observed GitLab actor maps to a principal allowed to run
   `review-documentation`; a poll observer mapping alone does not admit every
   author's merge request.
4. Create and verify the root-sealed activation package for the exact sealed
   release. The host operator applies it through the approved deployment
   procedure. If the project is already active, ask the operator to apply the
   registry correction for the hosted summary policy and credential.
5. Inspect host health and delivery logs, then use a real merge request to
   confirm that the note names the exact current source head and bot identity.
   Keep the merge-request URL, run identity, note identity, and observed head
   as deployment evidence. A refusal or a local fixture test does not satisfy
   this acceptance check.

The `review` grant permits the governed review-note operation. It does not
grant source-branch updates, merge, approval, publication, or release
authority. Refer to
[GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md)
for the delivery boundary. The host operator follows the supported activation
contract when applying the project policy.

### Troubleshoot Hosted Review

If the host refuses because the grant or note policy is missing, expired, or
does not name the configured bot, ask the operator to correct the project
policy through the approved activation procedure and verify it before
retrying. Do not widen the grant to `contribute` to make a review note work.

If the head changed during review, the note is refused as stale. Let the new
head event start a fresh review; do not replay the old result against the new
head. If no actor mapping admits the event, add only an approved principal and
workflow mapping, then generate a new event by updating the merge request.

If the note reports incomplete coverage or a quality gap, use the retained run
and quality evidence to identify missing sources or checks. Do not interpret a
posted note as proof that every review dimension passed. Ask the host operator
to inspect the journey health check's `notes7d` and `noteRefusals7d` values. A
delivered note proves the projection completed, not that the quality gap is
resolved.

## Troubleshooting

If doctor reports blocked readiness, follow the printed next command. Refer
to
[Doctor Reports Blocked Readiness](../troubleshooting.md#doctor-reports-blocked-readiness).

If the report URL is unreachable, keep `docsfab reports serve` running from
the same state directory as the run. Refer to
[The Review Report Page Does Not Load](../troubleshooting.md#the-review-report-page-does-not-load).

If you expected a hosted bot note but did not receive one, check project
activation, actor mapping, the Review grant, note credential expiry, and the
observed head. Refer to
[GitLab Host Mailbox in DocsFab](../reference/knowledge-and-delivery/delivery/gitlab-host-notification.md).

If the review stops because named targets are missing at the frozen
revision, correct the paths and start a new run. Do not retry with a
broader write grant.

## Related

<CardGroup cols={2}>
  <Card
    title="Review Documentation Contract"
    href="/reference/workflow-contracts/review-documentation"
  >
    [Review Documentation Contract](../reference/workflow-contracts/review-documentation.md)
  </Card>
  <Card
    title="Baseline Documentation Health in DocsFab"
    href="/workflows/baseline-documentation-health"
  >
    [Baseline Documentation Health in DocsFab](baseline-documentation-health.md)
  </Card>
  <Card
    title="Update Documentation Beside a Change in DocsFab"
    href="/workflows/update-documentation-beside-a-change"
  >
    [Update Documentation Beside a Change in DocsFab](update-documentation-beside-a-change.md)
  </Card>
  <Card
    title="Runner Quickstart"
    href="/get-started/runner-quickstart"
  >
    [Runner Quickstart](../get-started/runner-quickstart.md)
  </Card>
  <Card
    title="Run a Documentation Workflow in DocsFab"
    href="/workflows/run-a-documentation-workflow"
  >
    [Run a Documentation Workflow in DocsFab](run-a-documentation-workflow.md)
  </Card>
  <Card
    title="Troubleshooting DocsFab"
    href="/troubleshooting"
  >
    [Troubleshooting DocsFab](../troubleshooting.md)
  </Card>
</CardGroup>
