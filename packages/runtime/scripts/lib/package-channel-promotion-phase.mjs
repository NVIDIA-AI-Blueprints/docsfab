// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readChannelMap,
  readVersionArchive,
  writePublicationReceipt,
} from "./package-publication.mjs";
import {
  assertMainPromotionAllowed,
  assertReleasePromotionAllowed,
  readChannel,
  readChannelWithRetry,
} from "./package-promotion.mjs";

async function assertMainAncestry({ context, observedChannel }) {
  const {
    target,
    packageJson,
    registry,
    npmEnvironment,
    run,
    runWithOutputBound,
    workRoot,
    metadata,
    ancestryDepth,
    fetchImpl,
    fail,
  } = context;
  if (target.channel !== "main") return;
  await assertMainPromotionAllowed({
    observedVersion: observedChannel,
    target,
    packageJson,
    registry,
    env: npmEnvironment,
    run,
    workRoot,
    candidateSourceRevision: metadata.sourceRevision,
    ancestryDepth,
    runWithOutputBound,
    readVersionArchive: (input) => readVersionArchive({ ...input, runWithOutputBound, fetchImpl }),
    fail,
  });
}

async function writeChannelMutation({ context, priorVersion }) {
  const {
    target,
    packageJson,
    registry,
    npmEnvironment,
    run,
    runWithOutputBound,
    receipt,
    artifactRoot,
  } = context;
  receipt.promotion = {
    channel: target.distTag,
    state: "requested",
    priorVersion: priorVersion ?? null,
  };
  await writePublicationReceipt(artifactRoot, receipt);
  await runWithOutputBound(
    run,
    "npm",
    [
      "dist-tag",
      "add",
      `${packageJson.name}@${target.version}`,
      target.distTag,
      "--registry",
      registry,
    ],
    { env: npmEnvironment },
    "npm dist-tag add",
  );
}

async function admitChannelMutation(context) {
  const {
    target,
    packageJson,
    registry,
    npmEnvironment,
    fail,
    dryRun,
    receipt,
    artifactRoot,
    env,
  } = context;
  const tags = await readChannelMap({
    name: packageJson.name,
    registry,
    env: npmEnvironment,
    fetchImpl: context.fetchImpl,
    context: "before channel promotion",
  });
  const observedChannel = tags[target.distTag];
  if (target.channel === "release") assertReleasePromotionAllowed(observedChannel, target, fail);
  if (dryRun) {
    receipt.promotion = {
      channel: target.distTag,
      state: "dry-run",
      observedVersion: observedChannel ?? null,
    };
    await writePublicationReceipt(artifactRoot, receipt);
    return { observedChannel, dryRun: true };
  }
  if (observedChannel === target.version) return { observedChannel, dryRun: false };
  await requirePromotionCutover({ env, receipt, artifactRoot, target, observedChannel, fail });
  await assertMainAncestry({ context, observedChannel });
  const immediatelyBeforeWrite = await readChannelMap({
    name: packageJson.name,
    registry,
    env: npmEnvironment,
    fetchImpl: context.fetchImpl,
    context: "immediately before channel mutation",
  });
  const current = immediatelyBeforeWrite[target.distTag];
  if (current !== observedChannel && current !== target.version) {
    fail(
      "channel-concurrent-update: an outside writer changed the channel during promotion admission",
    );
  }
  if (current !== target.version) {
    await writeChannelMutation({ context, priorVersion: current });
  }
  return { observedChannel, dryRun: false };
}

async function requirePromotionCutover({
  env,
  receipt,
  artifactRoot,
  target,
  observedChannel,
  fail,
}) {
  if (env.DOCSFAB_PACKAGE_LEGACY_WRITERS_DRAINED === "true") return;
  receipt.promotion = {
    channel: target.distTag,
    state: "blocked-cutover",
    reasonClass: "cutover_unconfirmed",
    observedVersion: observedChannel ?? null,
  };
  await writePublicationReceipt(artifactRoot, receipt);
  fail(
    "promotion-cutover-unconfirmed: owner must confirm legacy pipelines and manual publisher access are drained",
  );
}

async function confirmPromotion(context) {
  const {
    readback,
    promotionReadAttempts,
    promotionReadDelay,
    wait,
    receipt,
    artifactRoot,
    target,
    published,
    outcome,
    log,
    packageJson,
  } = context;
  const result = await readChannelWithRetry({
    attempts: promotionReadAttempts.value,
    delayMs: promotionReadDelay.value,
    wait,
    read: readback,
  });
  receipt.promotion = {
    channel: target.distTag,
    state: "promoted-observed",
    observedVersion: result.observedVersion,
    readbackAttempts: result.attempts,
  };
  await writePublicationReceipt(artifactRoot, receipt);
  log(
    `Verified immutable ${packageJson.name}@${target.version} bytes and ${target.distTag} channel promotion.`,
  );
  return {
    ...outcome,
    published,
    channelState: "verified",
    observedVersion: result.observedVersion,
  };
}

export async function runChannelPromotionPhase(context) {
  const { receipt, artifactRoot, target, fail } = context;
  try {
    const admission = await admitChannelMutation(context);
    if (admission.dryRun) {
      return {
        ...context.outcome,
        published: context.published,
        channelState: "dry-run",
        observedVersion: admission.observedChannel ?? null,
      };
    }
    return await confirmPromotion({
      ...context,
      readback: () =>
        readChannel({
          name: context.packageJson.name,
          target,
          registry: context.registry,
          env: context.npmEnvironment,
          run: context.run,
          runWithOutputBound: context.runWithOutputBound,
          outputBoundCode: context.outputBoundCode,
          fail,
          context: "channel promotion",
          timeoutMs: context.promotionReadTimeout.value,
          fetchImpl: context.fetchImpl,
        }),
    });
  } catch (error) {
    const reasonClass = context.receiptFailureClass(error);
    const state =
      reasonClass === "superseded"
        ? "superseded"
        : reasonClass === "cutover_unconfirmed"
          ? "blocked-cutover"
          : "unknown";
    receipt.promotion = {
      channel: target.distTag,
      state,
      reasonClass,
      observedVersion: receipt.promotion?.observedVersion ?? null,
    };
    await writePublicationReceipt(artifactRoot, receipt);
    throw error;
  }
}
