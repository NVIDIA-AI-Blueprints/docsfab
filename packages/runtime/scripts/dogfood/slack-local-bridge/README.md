# Slack → local `docsfab` invoke (non-product dogfood)

**This is not product runtime.** It was a temporary host-side bridge for
starting a named `docsfab run` through a public Slack Request URL.
Investigation #293 and MR !176 **keep** this bridge as **non-product**.
The host now has a product Socket Mode
adapter over the durable job spine. Do not configure a new Request URL
or ship this bridge as a deployment default. If it is running, follow
[Teardown](#teardown-do-not-leave-this-on).

Chat text is **not** a write grant. The bridge never passes `--allow-write`
or `publish` from Slack, even if the message asks for them.

Status compared to the operator-channel plan: the freeze on !176 keeps
this bridge only as non-product dogfood evidence. The replacement lives
in `packages/host/src/channels/slack/` and uses Socket Mode, protected
credential handles, an exact empty-default route map, and the shared
host spine.

## What it does

1. Accepts a Slack slash command (or `--text` for local smoke).
2. Allows only **workflow names** and **repository roots** from a host
   allowlist file.
3. Plans `docsfab run <workflow> --repo <path>` (optional `--revision`,
   `--json`).
4. **Dry-run (default):** prints argv and does **not** spawn `docsfab`.
5. **Host `--execute` only:** spawns `docsfab` on this machine. Slack text
   cannot turn execute on.

## Historical Setup

Use these steps only to reproduce or remove the dogfood bridge. Do not
use them for a new DocsFab deployment.

1. Copy the example allowlist to a **host-private** path (not this git
   tree):

   ```bash
   cp scripts/dogfood/slack-local-bridge/allowlist.example.json \
     "$DOCSFAB_CONFIG_ROOT/slack-bridge-allowlist.json"
   ```

   Edit `workflows` and `repoRoots`. Roots must be absolute directories
   that exist on the operator machine.

2. Create a Slack app with a slash command (for example `/docsfab`).
   Request URL:

   `https://<your-tunnel>/slack/commands`

   Use a local tunnel (Cloudflare Tunnel, ngrok) to `127.0.0.1:8787`.
   Store the **signing secret** in the environment only:

   ```bash
   export SLACK_SIGNING_SECRET=  # from Slack app credentials; never commit
   ```

3. Start the bridge (dry-run default):

   ```bash
   node scripts/dogfood/slack-local-bridge/cli.mjs \
     --allowlist "$DOCSFAB_CONFIG_ROOT/slack-bridge-allowlist.json" \
     --serve --port 8787
   ```

4. Optional: actually invoke DocsFab on this host (still **without**
   `--allow-write`):

   ```bash
   node scripts/dogfood/slack-local-bridge/cli.mjs \
     --allowlist "$DOCSFAB_CONFIG_ROOT/slack-bridge-allowlist.json" \
     --serve --port 8787 --execute
   ```

   Requires `docsfab` on `PATH`, or `DOCSFAB_BIN=/path/to/docsfab`. The
   operator machine must already have model credentials provisioned.
   Those credentials never go into Slack, git, or run records via this
   script.

Slash text examples (command `/docsfab`, text field below):

```text
run review-documentation --repo /absolute/path/to/allowed/repository
run readiness --repo /absolute/path/to/allowed/repository --revision HEAD
```

## Allowlist

`allowlist.example.json` shape:

```json
{
  "workflows": ["review-documentation", "readiness", "release-documentation-readiness"],
  "repoRoots": ["/absolute/path/to/an/allowed/repository"]
}
```

- Unknown workflow names are refused.
- Paths that are relative, contain `..`, escape via symlink, or sit
  outside every `repoRoots` entry are refused.
- Prefer read-only catalog names (`review-documentation`, `readiness`, …). Write-capable
  workflows still cannot receive `--allow-write` from this bridge.

`allowlist.json` next to this README is gitignored. Prefer a path under
`DOCSFAB_CONFIG_ROOT` so host roots never land in the repository.

## Threat notes

| Claim | Reality |
| --- | --- |
| “Please run with `--allow-write`” in Slack | **Refused.** Chat ≠ write authorization. |
| `publish` / `--execute` / `auto` in slash text | **Refused.** |
| Anyone in the workspace | Slack signing secret verifies the *app*. Who may type is still a host/Slack-app concern; this is dogfood, not Phase B authz. |
| Tunnel URL | Treat as a credentialed ingress. Bind the Node server to `127.0.0.1`. |
| Allowlist file | Contains host paths. Keep it off git. |
| Model / Slack tokens | Environment only. Never in prompts, fixtures, or this tree. |
| Execute response delivery | Only `https://hooks.slack.com/` URLs are accepted. Completion and invoke-error notifications refuse all redirects. A redirect or network failure drops that notification without retrying; the bridge stays available and logs a fixed diagnostic without the response URL, command output, or error details. Check host connectivity and the Slack response URL before a later invocation. |

Two-phase mutation is unchanged: writes still need an explicit host/CLI
`--allow-write` outside this bridge. Product inbound kickoff now uses
the host Socket Mode adapter, not this script.

## Dry-run

Default mode prints argv and exits without spawning DocsFab:

```bash
node scripts/dogfood/slack-local-bridge/cli.mjs \
  --allowlist /path/to/allowlist.json \
  --text "run review-documentation --repo /absolute/path/to/allowed/repository"
```

Expected: a `DRY-RUN (not executed)` line plus `docsfab run review-documentation --repo …`.

## Teardown (do not leave this on)

1. Stop the Node process.
2. Clear the slash-command Request URL (or disable/delete the Slack app).
3. Rotate the Slack signing secret; unset `SLACK_SIGNING_SECRET`.
4. Delete the host allowlist file.
5. Do **not** add this directory to Blueprint / Brev compose, `package.json`
   scripts, or product `src/`.
6. Use the host Socket Mode adapter for product Slack input.

## Manual smoke checklist (MR)

Run from the repository root (no Slack app required):

```bash
node packages/runtime/scripts/dogfood/slack-local-bridge/test.mjs
```

These checks include signed host-execute requests using a synthetic executable
and loopback HTTP servers. Native fetch exercises direct delivery, redirects,
and network failure for both completion and invoke-error notifications; no
Slack or model requests are made.

Operator checklist when a Slack app is provisioned:

- [ ] Dry-run unknown workflow → refused
- [ ] Dry-run path outside allowlist → refused
- [ ] Slash text containing `--allow-write` → refused
- [ ] Valid `run review-documentation --repo <allowlisted>` → argv printed, not executed
  unless the **host** process was started with `--execute`
- [ ] No secrets, tokens, or host allowlists committed

## Out of scope

Product job spine, Pi harness, roadmap mutation authorities, root
`package.json`, and megafiles (`src/workflow-execution/runner.ts`,
`src/harness/pi.ts`).
