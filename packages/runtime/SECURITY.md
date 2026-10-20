# Security

DocsFab is an early release, not a multi-tenant service. Do not expose it to untrusted requesters or give it broad organization credentials.

## Current controls

- Use a dedicated test repository and least-privilege, manually provisioned credentials.
- Run read-only workflows first.
- Review all file changes before committing or pushing them.
- Keep model and SCM credentials in the runtime environment, never in repository files or prompts.
- Treat owner-private `.docsfab/runs` records and `live-agent` session files
  as potentially sensitive operator state.

## Reporting a vulnerability

Report suspected DocsFab product vulnerabilities privately to the project
maintainers (or your organization's security intake for this repository). Do
not open a public issue with exploit details, credentials, or raw run
artifacts. For product trust boundaries and governing decisions, see
[the public Security and Trust page](../../docs/about/security.md) and
[docs/about/security-threat-model.md](docs/about/security-threat-model.md).

## License headers and secret-scanning ownership

Contributors and reviewers need a crisp split between what **DocsFab CI / local
checks** enforce and what **organizational GitLab CI, secret scanning, and
license policy** own. This section is policy clarity only (epic #269); it does
not add a new scanner product.

### DocsFab CI and local `npm run check`

DocsFab's merge bar and local `npm run check` own product-contract and
dependency hygiene for this repository, including (as of this writing):

- Contract-dialect island checks (`security:contract-dialects`)
- Reviewed dependency-exception drift (`security:dependencies`)
- Soft-dependency package boundaries (`check:soft-deps`)
- Exception hygiene, CI-heavy manifest checks, TypeScript, and the Vitest suite

Those gates do **not** replace org secret scanning or license-header
enforcement for committed repository history. Product workspace export and
confined tool boundaries (below) are DocsFab runtime controls for what the
model may observe; they are not a substitute for organizational
credential-in-history policy.

When CONTRIBUTING lands (#271 / MR !169), treat that page as the contributor
entry for the merge-bar command graph; keep this section as the ownership
split for license and secret scanning.

### Organizational secret scanning and license expectations (`D-04`)

[GitLab and organizational CI own committed-repository credential
enforcement](docs/about/security-threat-model.md) (`D-04`). Follow your org's
secret scanning, license-header / SPDX / contribution-license requirements,
and any required SECURITY or legal intake for third-party notices. Do not
assume a clean DocsFab `npm run check` means the tree is free of committed
secrets or license defects.

### What DocsFab deliberately does not own (`D-08`)

Per threat-model decisions [`D-04` /
`D-08`](docs/about/security-threat-model.md):

- Do **not** rebuild repository secret scanning as a DocsFab workflow
  eligibility gate.
- Generic token scanning must **not** gate patch capture or publication
  (`D-08`).

Standalone or historical scan fields may remain readable for compatibility;
they grant no authority to allow or deny governed workflows. See the
[controls removed from product authority](docs/about/security-threat-model.md)
section in the threat model.

## Repository export and credential boundaries

DocsFab does not use a whole-repository token scan to grant or deny workflow,
write, patch-capture, or publication authority. Decisions `D-04` and `D-08`
assign committed-repository credential enforcement to organizational GitLab and
continuous integration. The standalone repository scan remains an advisory
diagnostic and grants no product authority.

Bounded workflows export tracked regular files while omitting `.git`, ignored
and untracked files, common credential paths, dependencies, build output, and
unsafe links. A narrower credential check examines an exact model message or
tool result before it crosses the model boundary. That check cannot classify
all personal, proprietary, export-controlled, or otherwise confidential data.
The operator must select a provider and repository scope appropriate for the
data.

## Pi filesystem-tool boundary

Workflow and live-agent sessions treat the selected repository as untrusted
input when Pi resolves resources. The loader ignores its `.pi/settings.json`
and project resource/package declarations, while retaining the operator-owned
Pi agent directory and DocsFab assets explicitly supplied by the host. A target
repository can provide its root `AGENTS.md` as repository guidance, but it
cannot add Pi package hooks or other ambient resources to a DocsFab session.

DocsFab replaces Pi's built-in `read`, `grep`, `find`, `ls`, `edit`, and
`write` definitions with same-named confined definitions. Every tool rejects
NUL, home-relative, absolute, and parent
traversal paths before Pi resolves them. Filesystem operations then re-check
the canonical target: existing targets must resolve inside the disposable
workspace, while write targets must have an in-workspace existing ancestor and
no symlink component. Search roots receive the same checks before `rg` runs;
the confined `find` implementation does not follow symlinks.

The active governed skill may expose its verified bundle through
`.docsfab-governed-skills/<skill>/`. That virtual path maps only to the locked
skill directory and is available only through `read`; edit and write reject the
reserved prefix.

These application checks fail closed but cannot eliminate filesystem
time-of-check/time-of-use races. A local process with access to the disposable
workspace could replace a checked path component before the following I/O.
Production deployment must therefore run DocsFab in an OS or container sandbox
whose mount namespace exposes the repository workspace and the verified skill
bundle only, with the bundle mounted read-only. That isolation boundary—not
JavaScript path validation—is the TOCTOU-resistant control.

The persistent local `live-agent` is a separate surface. It enables
documentation-scoped edits by default; `--read-only` disables edits and host
commands. In write mode, `bash` requires approval for each exact command and
runs with documentation-only filesystem writes. The Linux bubblewrap profile
does not unshare the network namespace, and the macOS profile does not establish
a network firewall. Treat approved commands as host-network-capable operations
that can use the local user's selected CLI authentication.

`docsfab doctor` is offline. Only `docsfab doctor --live` sends a prompt to the configured model endpoint. The live probe disables tools, skills, extensions, prompt templates, themes, and repository context; it reports only success and latency. Provider errors are scrubbed against configured model and judge secrets before reaching the CLI.

## Known inherited advisory (resolved)

Pi 0.83.0 shrinkwrapped `brace-expansion` 5.0.7, which npm reports under
GHSA-mh99-v99m-4gvg. This was contained (not exploitable in DocsFab's
single-requester release, which does not expose user-controlled glob
expansion) rather than resolved, pending a Pi release whose installed tree
carried a patched `brace-expansion`.

As of 2026-08-31, DocsFab is pinned to Pi 0.84.4, whose shrinkwrapped
`brace-expansion` is 5.0.9 (past the 5.0.8 patch), verified against the
installed tree. The dependency-exception record is retired; `npm run
security:dependencies` now runs in its no-exception, reintroduction-guard mode
and fails if an affected `brace-expansion` reappears anywhere in the
production tree. The full containment history, evidence, and remediation are
recorded in
[docs/reference/operations/dependency-exceptions.md](docs/reference/operations/dependency-exceptions.md).
Run `npm run security:dependencies` (also included in `npm run check`) to
verify the current state.
