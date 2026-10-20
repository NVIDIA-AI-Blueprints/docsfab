---
title: DocsFab Support Matrix
description: Review DocsFab platform coverage, tested models, and detailed hardware, software, network, and access prerequisites.
status: draft
content.type: reference
---

Use this matrix to prepare an environment for the current DocsFab development
build used by internal testers. Follow [Install DocsFab](../get-started/installation.md)
for the installation commands. This page records platform coverage and the
scope of model testing; it does not designate a default model.

Last reviewed: October 14, 2026.

## Hardware

DocsFab runs locally and calls the model endpoint you configure. Hosted models
do not require a local GPU, CUDA, or a container runtime. If you run a local
NVIDIA NIM, its GPU, driver, and container requirements apply to the model
server. Refer to [Use a Local NIM](../configure/local-nim.md).

The following resources are required on the DocsFab host:

| Resource | Requirement |
| --- | --- |
| CPU and memory | A host that runs the supported Node.js version. DocsFab has not established a minimum CPU count or RAM capacity. |
| Storage | Space for the source checkout, npm dependencies, compiled output, target repositories, working copies, and saved runs. Usage grows with repository size and retained runs; no fixed minimum is established. |
| Directory access | Write access to the source checkout, npm global installation prefix, and DocsFab configuration and state directories. Documentation writes also need access to the target paths. |
| WSL2 storage | Keep the checkout, configuration, and run state on the Linux filesystem, such as under your Ubuntu home directory. Avoid `/mnt/c/` for these paths. |

## Software

### Operating System

Platform coverage depends on the operation you run:

| Platform | Coverage | Preparation and Limits |
| --- | --- | --- |
| Linux | CLI, model configuration, model calls, and workflow execution. | Required workflow validation checks need `/usr/bin/bwrap` and working unprivileged user namespaces. |
| macOS | CLI, model configuration, model calls, and workflows whose required checks can run on the host. | Required repository validation has no admitted macOS backend, including Docker Desktop. Use Linux when the workflow requires those checks. |
| Windows 11 with WSL2 | Linux DocsFab execution inside Ubuntu 24.04. | Use Linux Node.js, npm, Git, and `glab`, and keep working files on Linux storage. Follow the [Windows Installation Instructions](../get-started/installation.md#windows-11-with-wsl2). Approved DocsFab commands use Linux tools. |
| Native Windows | Unsupported. | Windows Node.js, PowerShell, and CMD are not DocsFab execution platforms. Use WSL2. |

Linux and macOS installations must also satisfy the operating-system requirements
of Node.js 24.21.0 or later. The tested configuration below records a specific
host; it is not a minimum OS-version guarantee for every distribution.

### Runtime Dependencies

Prepare the dependencies required by your intended operation:

| Dependency | Requirement | When It Is Needed |
| --- | --- | --- |
| Node.js | Version 24.21.0 or later, available on `PATH`. | Every DocsFab command. Startup rejects an unsupported Node.js version. |
| npm | Available with your supported Node.js installation. | Install source dependencies and the global CLI. `npm ci` uses the runtime lockfile. |
| Git | Available on `PATH`, with access to the DocsFab source repository and the target repository. | Clone and update DocsFab; inspect repository revisions and run repository workflows. |
| Bubblewrap | `/usr/bin/bwrap`, with working unprivileged user namespaces. | Execute required workflow validation checks and isolated Linux commands. Do not disable host security policy to make a check pass. |
| GitLab CLI (`glab`) | Installed and authenticated to the target GitLab host. | GitLab reads and draft merge request delivery. Local review and local patches do not require GitLab authentication. |

The current source installation does not require npm authentication to the
DocsFab package registry. Packaged development installations require separate
registry access and npm authentication, as described in
[Install a Development Build](../manage/development-installation.md).

## Verified Configurations

The following retained qualification establishes installation and command
isolation on a specific configuration:

| Host | Linux Environment | Tested Dependencies | Verified Coverage |
| --- | --- | --- | --- |
| Windows 11 Enterprise, x86_64 | WSL2 with Ubuntu 24.04.5 and native Linux storage | Linux Node.js 24.21.0, npm 11.19.0, and Bubblewrap 0.9.0 | The published `0.0.1-main.17c65c55` development package installed. Offline fixture tests and Linux command-isolation controls passed. |

This configuration establishes those installed-product checks. It does not
establish a passing full WSL regression suite or successful workflows with
every model. Model results are listed separately below.

## Tested Models

These models have recorded DocsFab workflow tests on the specified routes.
The results describe the tested revision and task, rather than every possible
combination of model, endpoint, platform, and workflow.

The eight-case matrix covers create, review, update, and restructure through
both the CLI and the live agent. The following table summarizes retained results:

| Model | Tested Route and API | Recorded Results |
| --- | --- | --- |
| GPT-6 Sol, `azure/openai/gpt-6-sol` | NVIDIA Inference API internal gateway, OpenAI-compatible Chat Completions. | Three eight-case rounds passed 24/24 on the September 25 revision. A later October 9 canary passed 7/8; the create CLI case failed its artifact check. |
| Claude Sonnet 5, `aws/anthropic/bedrock-claude-sonnet-5` | NVIDIA Inference API internal gateway, OpenAI-compatible Chat Completions. | Three eight-case rounds on the September 25 revision passed 0/24. This is a tested configuration, not a qualified recommendation. |
| Nemotron 3 Super 120B-A12B, `nvidia/nemotron-3-super-120b-a12b` | Hosted NVIDIA API Catalog, OpenAI-compatible Chat Completions. | Hosted review tests reached the final evaluation stage without a validated final quality report. A separate eight-case WSL2 matrix passed 0/8. |

The internal gateway tests require access to that service. They do not establish
results for the same model on the direct OpenAI API, direct Anthropic API,
native Azure or Bedrock APIs, or a local NIM container. A model ID containing
`azure/` or `aws/` identifies the model served by the tested gateway.

Other models can be configured when their endpoint supports the selected API,
streaming, and native tool calling. A successful connection check or an
installed composition does not establish workflow quality. For the meaning of
a complete workflow result, refer to [Evaluating DocsFab](../resources/evaluation/index.md).

## Network Access

Prepare access to the services used by your chosen operation:

| Service | Required Access |
| --- | --- |
| DocsFab source repository | Git clone and pull access using the repository's SSH remote. |
| npm dependency registries | Download access during `npm ci`. Use your organization's approved proxy and certificate configuration when required. |
| Model endpoint | The configured base URL, model ID, supported API, and that service's API key. Remote endpoints use HTTPS. Plain HTTP is supported only for a model server on this machine's loopback interface. |
| Target GitLab repository | Authenticated Git and `glab` access, plus push and merge request permissions, when you want DocsFab to deliver a draft merge request. |

### External API Service Access

Choose credentials for the service that actually hosts your model:

- For **OpenAI** or **Anthropic**, use an API key from that provider's product console.
- For **OpenAI-compatible** or **Anthropic-compatible**, obtain the service's
  model ID, base endpoint URL, API format, and key. Compatibility depends on
  the endpoint's API; selecting a compatible provider does not add native
  cloud authentication or discover an endpoint for you.
- For a local NIM, follow its deployment requirements and the
  [local connection instructions](../configure/local-nim.md).

Store model credentials through `docsfab setup` or the approved host secret
facility. Do not put keys in repository files or command-line arguments.
For the setup prompts, refer to [Configure the Model](../configure/model.md).

## Requirements by Operation

For model, repository, and delivery prerequisites by operation, follow [Check Readiness](../manage/check-readiness.md#requirements-by-operation).

## Pre-Installation Checklist

Confirm the prerequisites that apply to your intended operation:

- [ ] The host platform and Node.js version meet the requirements above.
- [ ] You can clone DocsFab and write to its checkout and your npm global prefix.
- [ ] You have the model ID, service key, and endpoint details needed for model-backed work.
- [ ] Linux command isolation is available when the workflow requires validation checks.
- [ ] GitLab authentication and publication permissions are available when you need draft merge request delivery.

## Next Steps

- [Install DocsFab](../get-started/installation.md)
- [Configure the Model](../configure/model.md)
- [Check DocsFab Readiness](../manage/check-readiness.md)
- [Troubleshooting](../troubleshooting.md)
