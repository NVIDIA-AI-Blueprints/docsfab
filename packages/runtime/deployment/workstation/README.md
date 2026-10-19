# Use a managed workstation

Run DocsFab from a workstation you already have permission to access through
your organization's SSH or remote-shell service. DocsFab does not provision or
manage the workstation.

The DocsFab runtime requires Node.js 24.21.0 or later.

## Install and review

Connect to the workstation with the access method your organization provided.
For SSH, use the host name your organization provided:

```sh
ssh <workstation-host>
```

In that shell, clone DocsFab using the URL from its repository page. From the
checkout root, install the runtime and configure your model:

```sh
git clone <DocsFab-repository-url> docsfab
cd docsfab
npm --prefix packages/runtime ci
npm install --global ./packages/runtime
docsfab setup
```

Clone a target repository you are authorized to inspect, then run a read-only
review:

```sh
mkdir -p ~/workspaces
git clone <target-repository-url> ~/workspaces/target
docsfab run review-documentation --repo ~/workspaces/target
```

The [installation guide](../../../../docs/get-started/installation.md) covers
platform requirements and setup. The review reads the target checkout; it does
not edit it. Use [local-user publishing guidance](../../../../packages/runtime/docs/reference/operations/local-user-gitlab-publishing.md)
if you later need an authorized write and delivery path.

## Publication isolation

Some managed Linux workstation profiles cannot create the network namespace
and loopback needed by the publisher isolation probe. On a tested profile,
`bwrap --unshare-net` could not set loopback, and user namespaces could not
write `uid_map`. Publish preflight may work, but `--execute` is unsupported
unless the publisher probe exits successfully. Linux alone does not guarantee
that the profile permits the required isolation. Keep the run and reviewed
plan, then use a host where that probe passes. See the detailed
[publishing limits](../../../../packages/runtime/docs/reference/operations/local-user-gitlab-publishing.md).

The old `deployment/brev/bootstrap.sh` path is for Brev; it is not needed for
an operator-managed workstation. See the [Brev guide](../brev/README.md).
