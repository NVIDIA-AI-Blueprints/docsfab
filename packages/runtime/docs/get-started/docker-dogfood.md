# Docker dogfooding

DocsFab uses Docker Desktop in two different roles. Do not mix them.

## Host-managed validation on Darwin

On macOS, the trusted DocsFab host validates the exact candidate tree in an
ephemeral Docker Desktop container (#216). Linux Bubblewrap remains the
interchangeable #215 implementation. This adapter follows the #210
backend-neutral contract (CODEOWNER isolation stamp on that Investigation;
this page does not say Product Security, Legal, or OSRB signed):

- no Docker socket, host home, SCM/model credentials, privileged mode, or
  external network
- a private, credential-hidden view of the candidate tree mounted read-only
  at `/input` and isolated scratch at `/scratch`, with both digests bound
- read-only root filesystem, tmpfs `/tmp`, CPU, memory, PID, timeout, and
  descendant teardown (`--init --rm`) plus host-owned container removal and
  absence verification after each check
- `--network none` keeps private loopback inside the capsule; it does not
  imply host or external connectivity
- if Docker Desktop is unavailable, DocsFab returns one actionable diagnostic
  and preserves the patch

The runtime launches `docker run` with the digest-pinned image in
`deploy/compose/docker-desktop-validation.yaml`. Pull that image once:

```bash
docker pull node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
```

Native Darwin required checks and `docsfab publish … --execute` use this
backend. The full pinned image includes Python and Git for repository checks.
The backend does not re-enable `sandbox-exec` (#110 / #210). Plan, config,
environment, and model output still cannot select or construct it.

If `docker info` fails, start Docker Desktop, load the pinned image, and
retry. The preserved patch is not applied to the source checkout.

## Nested Linux dogfood image (not the validation backend)

Use Docker Desktop to run DocsFab's Linux-shaped **write** workflow when you
want a Linux userland. That setup is an operator boundary for local
dogfooding, not a production sandbox and **not** the #216 validation
backend. It does not make an untrusted repository safe to execute, and it
does not grant the container access to Docker, your home directory, or
arbitrary host paths.

**Nested execute stays fail-closed.** Nested `bwrap` inside this image is
still **not** a supported confinement boundary. On Docker Desktop, nested
`--unshare-net` can still allow `listen(127.0.0.1)`, so confined execute
fails closed with `validation-isolation-unavailable` (#259). Standalone
`npm run bwrap:probe` (outbound connect) does not prove that listen-deny
boundary. Do not weaken the publisher probe for Desktop convenience. For
native Darwin validation, use the host-managed backend above instead of
nested Bubblewrap.

The container runs DocsFab as UID 10001. Its immutable application assets
are root-owned; its configuration, state, temporary files, and
container-owned target clones live under a persistent named Docker volume at
`/home/docsfab`. The one host checkout selected by `DOCSFAB_REPOSITORY` is
mounted read-only only as clone input. This keeps the host checkout
unchanged while making the run record, write workflow, and publisher use
one stable Linux path.

## Build and prove the nested runtime

Choose the input repository and, optionally, an environment file outside
this checkout. The environment file is for existing operator-managed
provider and GitLab configuration; never commit credentials or set them in
`compose.yaml`. Select an existing `known_hosts` file that already contains
the approved key for the target GitLab SSH host; do not learn or replace
that key inside the container.

```bash
export DOCSFAB_REPOSITORY=/absolute/path/to/target-repo
export DOCSFAB_SSH_KNOWN_HOSTS="$HOME/.ssh/known_hosts"
export DOCSFAB_RUNTIME_ENV_FILE="$HOME/.config/docsfab/dogfood.env"
docker compose build
docker compose run --rm --workdir /opt/docsfab --entrypoint npm docsfab run ci:env-check
docker compose run --rm --workdir /opt/docsfab --entrypoint npm docsfab run bwrap:probe
```

The behavioral probe verifies that `bwrap` can create the required PID and
network namespaces, denies an out-of-scratch write, and allows its private
scratch write. A passing binary-presence check alone is not enough.

`packages/runtime/ci/compose.yaml` deliberately uses Docker
Desktop-specific `SYS_ADMIN`, `seccomp=unconfined`, and
`systempaths=unconfined` settings because Docker Desktop's default profile
blocks nested `bwrap` namespaces. They are the minimum settings verified
for this image, but they relax the outer container boundary. Do not treat
this container as a production sandbox, do not add `--privileged`, and do
not mount the Docker socket. Re-run the behavioral probe after changing
Docker Desktop or its security settings.

The root-owned GitLab CLI is copied from the digest-pinned official
multi-architecture `registry.gitlab.com/gitlab-org/cli:v1.112.0` build
stage. Supply any GitLab credentials only through the selected external
runtime environment file; do not copy a host credential directory into the
container. For SSH Git transport, Compose forwards Docker Desktop's
SSH-agent socket and mounts only the selected `known_hosts` file read-only.
The container receives the ability to request signatures from the agent
while it is running; it never receives the private-key files. Use an agent
with only the identities intended for this dogfood session when tighter
credential scoping is required.

## Run a nested write workflow

Clone the selected read-only host checkout into the named container volume
once, then use only that clone for every DocsFab command. Its path stays
stable across audit, write, preflight, and execution. Cloning a local path
would make that path the Git remote, so immediately replace it with the
canonical, uncredentialed GitLab remote before initialization or
publication.

```bash
docker compose run --rm --entrypoint git docsfab clone --no-local /workspace/source .
docker compose run --rm --entrypoint git docsfab remote set-url origin \
  ssh://git@<your-gitlab-host>:<port>/<group>/<project>.git
docker compose run --rm docsfab init
docker compose run --rm docsfab doctor
docker compose run --rm docsfab run review-documentation --repo .
```

Continue with a separately authorized write workflow and the existing
two-phase `docsfab publish` process. Preflight may succeed inside this
container; nested `--execute` is expected to fail closed on Docker Desktop
(`/.dockerenv` plus a failed listen-deny probe). For native Darwin
validation-to-draft-MR, run `docsfab` on the Mac so #216 can use
host-managed Docker Desktop. Standing-grant Linux proof still needs a host
whose deny-listen Bubblewrap probe passes (#235 / #210). Inside Desktop
write workflows, provide owner-private roots under `/home/docsfab/state`
for `--delivery-root` and `--receipt-root`. The usual write authorization,
reviewed plan digest, GitLab identity checks, and draft-MR controls still
apply; Docker neither grants nor replaces them.

To start fresh, remove only the DocsFab-specific named volume after
confirming that its run records and receipts are no longer needed:

```bash
docker compose down --volumes
```
