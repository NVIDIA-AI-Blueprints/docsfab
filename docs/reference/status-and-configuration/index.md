---
title: DocsFab Status and Configuration Reference
description: Look up DocsFab implementation boundaries, runtime commands, configuration, and model-profile approval state.
status: draft
---

Use Reference to look up command syntax, field meanings, supported values, and execution contracts. Procedures live in [Configure DocsFab](../../configure/index.md), [Workflows](../../workflows/index.md), and [Manage DocsFab](../../manage/index.md).

## Find a Reference Topic

Choose the contract or lookup area you need:

| Area | Topics |
| --- | --- |
| Current capability and platform coverage | [Implementation Status](implementation-status.md), [Support Matrix](../support-matrix.md), [Generator Capabilities](generator-capabilities.md) |
| CLI and configuration | [Command Reference](runtime-cli-and-configuration.md), [Project Configuration](project-configuration.md), [Host Environment Variables](environment-variables.md), [Human Output and JSON](human-output-and-json.md) |
| Models and routes | [Installed Compositions](execution-compositions.md), [Profile Fields](model-profile-fields.md), [Setting Precedence](model-settings.md), [Endpoint Compatibility](endpoint-compatibility.md), [Approval Evidence](model-profile-approval.md) |
| Execution behavior | [Execution Budgets](execution-budgets.md), [Tool Results](tool-result-limits.md), [Retries](provider-retries.md), [Answer Continuation](answer-continuation.md), [Read Loops](read-loop-supervision.md), [Live Agent](live-agent.md) |
| Runs and failures | [Run Index](query-failures-across-runs.md), [Diagnosis](diagnose-failed-runs.md), [Retry Evidence](retry-evidence.md), [Stop Classes](stop-classes.md), [Error Envelope](operator-error-envelope.md) |
| Source and document contracts | [Tracked Source Evidence](source-evidence.md), [Request Interpretation](request-interpretation.md), [Document Validation](document-validation.md) |
| Storage and limits | [Operational Limits](operational-limits.md), [Artifact Sizes](artifact-limits.md), [Recovery State](recovery-and-migration.md) |

## Source-of-Truth Order

Use the installed executable for exact command help, checked-in schemas for record shape, and implementation plus tests for current behavior. A passing check or preview does not establish release approval.
