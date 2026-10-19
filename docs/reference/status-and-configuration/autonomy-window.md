---
title: "Autonomy Authorization Window in DocsFab"
description: "Look up the configured and requested authorization windows for an autonomous cycle."
status: draft
content.type: reference
---

Look up the configured and requested authorization windows for an autonomous cycle.

`docsfab auto --once` admits a requested authorization window at
`autonomy.authorizationWindowMs` and refuses one millisecond over that
bound. The persisted cycle record stores requested and effective window
milliseconds. DocsFab never silently shortens a requested window. When
confirmation omits a window, the default is
`autonomy.authorizationWindowDefaultMs`. Hosts may shrink the maximum
with `DOCSFAB_AUTONOMY_AUTHORIZATION_WINDOW_MS` and the default with
`DOCSFAB_AUTONOMY_AUTHORIZATION_WINDOW_DEFAULT_MS`. Startup refuses when
the effective default is above the effective maximum.
