# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Local Linux runtime for governed DocsFab dogfooding.
#
# This image is an operator convenience boundary, not a production sandbox.
# It intentionally runs the CLI as an unprivileged user and keeps its mutable
# configuration outside the immutable package root.
ARG DOCSFAB_GLAB_IMAGE=registry.gitlab.com/gitlab-org/cli:v1.112.0@sha256:50eb63050d26732f55f6de949c3429fcd26e82729a9e3e243271a30d1ffd547c
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

WORKDIR /opt/docsfab/packages/runtime

COPY packages/runtime/package.json packages/runtime/npm-shrinkwrap.json ./
RUN npm ci

COPY packages/runtime/ ./
COPY packages/knowledge/src /opt/docsfab/packages/knowledge/src
# prepack regenerates derived products from these canonical sources and copies
# the license files into the package, both from the repository root.
COPY LICENSE LICENSE-CC-BY-4.0 NOTICE /opt/docsfab/
COPY config /opt/docsfab/config
COPY docs/reference/status-and-configuration/operational-limits-tables /opt/docsfab/docs/reference/status-and-configuration/operational-limits-tables
COPY packages/skills /opt/docsfab/packages/skills
COPY packages/knowledge/skills /opt/docsfab/packages/knowledge/skills
COPY packages/quality/checks /opt/docsfab/packages/quality/checks
COPY packages/quality/formats /opt/docsfab/packages/quality/formats
COPY packages/quality/profiles /opt/docsfab/packages/quality/profiles
COPY packages/quality/rubrics /opt/docsfab/packages/quality/rubrics
COPY packages/quality/runtime-policy /opt/docsfab/packages/quality/runtime-policy
COPY packages/quality/schemas /opt/docsfab/packages/quality/schemas
RUN mkdir /tmp/package \
  && npm pack --pack-destination /tmp/package \
  && mv /tmp/package/*.tgz /tmp/docsfab.tgz

FROM ${DOCSFAB_GLAB_IMAGE} AS glab

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    bubblewrap \
    ca-certificates \
    git \
    openssh-client \
    ripgrep \
    tar \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 docsfab \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin docsfab \
  && install --directory --owner=docsfab --group=docsfab --mode=0700 \
    /home/docsfab/config \
    /home/docsfab/state \
    /home/docsfab/tmp \
    /home/docsfab/.ssh \
    /home/docsfab/workspaces \
    /home/docsfab/workspaces/repository

WORKDIR /opt/docsfab

# Keep this root immutable and owned by root. Mutable operator data belongs
# under /home/docsfab, which Compose persists in a named volume.
COPY --from=build /tmp/docsfab.tgz /tmp/docsfab.tgz
RUN tar -xzf /tmp/docsfab.tgz --strip-components=1 \
  && rm /tmp/docsfab.tgz \
  && npm ci --omit=dev
COPY --from=glab /usr/bin/glab /usr/local/bin/glab
COPY packages/runtime/scripts/ci-env-check.mjs packages/runtime/scripts/bwrap-behavior-probe.mjs ./scripts/

ENV HOME=/home/docsfab \
    DOCSFAB_CONFIG_ROOT=/home/docsfab/config \
    DOCSFAB_STATE_DIR=/home/docsfab/state/runs \
    TMPDIR=/home/docsfab/tmp

USER docsfab:docsfab
WORKDIR /home/docsfab/workspaces/repository

ENTRYPOINT ["node", "/opt/docsfab/dist/launcher.js"]
CMD ["--help"]
