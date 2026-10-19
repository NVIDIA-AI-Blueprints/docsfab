---
title: "Host a DocsFab Review Report"
description: "Serve a retained review report and understand its local access boundary."
status: draft
content.type: how-to
---

Serve a retained review report and understand its local access boundary.

## Host a Review Report

A succeeded `review-documentation` run can retain a generated HTML report
under the operator state directory. Serve retained reports only when an
operator has chosen the appropriate network boundary:

```bash
docsfab reports serve --state-dir '/absolute/operator/state' --port 8787
docsfab runs show <run-id> --state-dir '/absolute/operator/state'
```

The HTML route is `/reports/<run-id>/`. The default listen address is
`127.0.0.1:8787`. Binding to `0.0.0.0` exposes the server beyond the
loopback interface and requires an operator decision. Serving a report
does not publish documentation or grant write, repository, or merge
authority. For the reviewer procedure, refer to
[Review Merge Request Impact in DocsFab](../workflows/review-merge-request-impact.md). For exact
flags, refer to
[Runtime CLI and Configuration in DocsFab](../reference/status-and-configuration/runtime-cli-and-configuration.md).
