# Use a Brev instance

Use an instance in your own Brev account for a short, request-driven DocsFab
session. Choose and manage the CPU instance through the current
[Brev CLI documentation](https://docs.nvidia.com/brev/cli/cli-overview), then
connect to it over SSH using the method supported by your account. This guide
does not provision or operate cloud resources for you.

The DocsFab runtime requires Node.js 24.21.0 or later.

## Install and review

Connect to the instance over SSH using its host name or connection details
provided by Brev:

```sh
ssh <instance-host>
```

In that shell, clone DocsFab with the URL from its repository page. From the
checkout root, install the runtime and configure a model:

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
platform requirements. Keep credentials in the private configuration created
by `docsfab setup`; do not put keys in shell commands, arguments, or a
repository. Start with read-only work on a target you may inspect. Use the
[runtime guide](../../README.md) to understand write and delivery modes.

## Legacy bootstrap script

[`bootstrap.sh`](bootstrap.sh) is a legacy dogfood helper, not the current
monorepo installer. It runs `npm ci` and `npm run build` from the checkout
root, where this repository has no root package manifest. Use the package-scoped
installation above. Do not treat successful provisioning as evidence that the
legacy script installed the current runtime.

Stop or remove your instance when your session is over using the current
controls documented by Brev. Do not reuse a shared or leftover instance.
