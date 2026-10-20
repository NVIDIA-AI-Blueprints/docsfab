// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  readPublicationReceipt,
  readVersionArchive,
  writePublicationReceipt,
} from "./package-publication.mjs";

const ACCEPTED_UPLOAD_STATES = [
  "uploaded-verified",
  "existing-exact-bytes",
  "reconciled-after-response-loss",
];

export async function initializePublicationReceipt({
  phase,
  artifactRoot,
  packageJson,
  target,
  metadata,
  candidateBytes,
  expectedIntegrity,
  fail,
}) {
  if (phase === "upload") {
    return {
      schemaVersion: 1,
      name: packageJson.name,
      version: target.version,
      sourceRevision: metadata.sourceRevision,
      sourceVersion: metadata.sourceVersion,
      sourceClean: metadata.sourceClean,
      integrity: expectedIntegrity,
      size: candidateBytes.byteLength,
      upload: { state: "pending" },
      promotion: { channel: target.distTag, state: "pending" },
    };
  }
  const receipt = await readPublicationReceipt(artifactRoot);
  if (!receipt)
    fail("upload-receipt-unknown: promotion requires the successful immutable-upload receipt");
  if (
    receipt?.schemaVersion !== 1 ||
    receipt?.name !== packageJson.name ||
    receipt?.version !== target.version ||
    receipt?.sourceRevision !== metadata.sourceRevision ||
    receipt?.sourceVersion !== packageJson.version ||
    receipt?.sourceClean !== true ||
    receipt?.integrity !== expectedIntegrity ||
    receipt?.size !== candidateBytes.byteLength ||
    !ACCEPTED_UPLOAD_STATES.includes(receipt?.upload?.state)
  ) {
    fail("upload-receipt-conflict: immutable-upload receipt does not bind the verified candidate");
  }
  receipt.promotion = { channel: target.distTag, state: "pending" };
  return receipt;
}

async function recordReadbackFailure({
  phase,
  receipt,
  artifactRoot,
  error,
  reasonClass,
  readbackAttempts,
}) {
  if (phase === "promote") {
    receipt.promotion = { channel: receipt.promotion.channel, state: "unknown", reasonClass };
  } else {
    receipt.upload = {
      state: "unknown",
      reasonClass,
      ...(readbackAttempts ? { readbackAttempts } : {}),
    };
  }
  await writePublicationReceipt(artifactRoot, receipt);
  throw error;
}

async function readCandidateVersion({ readArchive, phase, receipt, artifactRoot, reasonClass }) {
  try {
    return await readArchive();
  } catch (error) {
    await recordReadbackFailure({
      phase,
      receipt,
      artifactRoot,
      error,
      reasonClass: reasonClass(error),
    });
  }
}

async function requireAcceptedBytes({
  archive,
  expectedIntegrity,
  receipt,
  candidateBytes,
  artifactRoot,
  fail,
  readbackAttempts,
}) {
  if (
    archive.integrity !== expectedIntegrity ||
    archive.size !== receipt.size ||
    !archive.bytes.equals(candidateBytes)
  ) {
    receipt.upload = {
      state: "conflict",
      reasonClass: "different_bytes",
      observedIntegrity: archive.integrity,
      observedSize: archive.size,
      ...(archive.readbackSource ? { readbackSource: archive.readbackSource } : {}),
      ...(readbackAttempts ? { readbackAttempts } : {}),
    };
    await writePublicationReceipt(artifactRoot, receipt);
    fail("immutable-version-conflict: exact registry version contains different archive bytes");
  }
}

async function runNpmPublish({
  tarballPath,
  registry,
  uploadTag,
  projectRoot,
  npmEnvironment,
  run,
  runWithOutputBound,
}) {
  try {
    await runWithOutputBound(
      run,
      "npm",
      ["publish", tarballPath, "--registry", registry, "--tag", uploadTag, "--ignore-scripts"],
      { cwd: projectRoot, env: npmEnvironment },
      "npm publish",
    );
    return { published: true, responseLost: false };
  } catch {
    return { published: false, responseLost: true };
  }
}

async function reconcileUploadedArchive({
  readArchive,
  receipt,
  artifactRoot,
  packageJson,
  target,
  expectedIntegrity,
  candidateBytes,
  reasonClass,
  versionReadAttempts,
  versionReadDelay,
  versionReadTimeout,
  wait,
  fail,
  log,
}) {
  let archive = null;
  let readbackAttempts = 0;
  for (; readbackAttempts < versionReadAttempts.value; ) {
    readbackAttempts += 1;
    try {
      archive = await readArchive({
        freshOnline: true,
        metadataTimeoutMs: versionReadTimeout.value,
      });
    } catch (error) {
      await recordReadbackFailure({
        phase: "upload",
        receipt,
        artifactRoot,
        error,
        reasonClass: reasonClass(error),
        readbackAttempts,
      });
    }
    if (archive !== null) break;
    if (readbackAttempts < versionReadAttempts.value) await wait(versionReadDelay.value);
  }
  if (archive === null) {
    receipt.upload = { state: "unknown", reasonClass: "eventual_visibility", readbackAttempts };
    await writePublicationReceipt(artifactRoot, receipt);
    fail(
      `publication-state-unknown: exact version ${packageJson.name}@${target.version} is not readable after bounded attempts (${versionReadAttempts.refusal}; observed=${readbackAttempts}, publishPackage.versionReadbackAttempts=${versionReadAttempts.value}, scope=exact-version registry readback); inspect the registry and receipt before retrying`,
    );
  }
  await requireAcceptedBytes({
    archive,
    expectedIntegrity,
    receipt,
    candidateBytes,
    artifactRoot,
    fail,
    readbackAttempts,
  });
  if (archive.readbackSource)
    log(
      `Exact registry archive for ${packageJson.name}@${target.version} verified through direct project archive read after metadata E404.`,
    );
  return { archive, readbackAttempts };
}

async function publishAndReconcile({
  archive,
  dryRun,
  receipt,
  artifactRoot,
  packageJson,
  target,
  expectedIntegrity,
  candidateBytes,
  tarballPath,
  projectRoot,
  registry,
  uploadTag,
  run,
  runWithOutputBound,
  npmEnvironment,
  readArchive,
  reasonClass,
  versionReadAttempts,
  versionReadDelay,
  versionReadTimeout,
  wait,
  fail,
  log,
  outcome,
}) {
  if (archive !== null) {
    await requireAcceptedBytes({
      archive,
      expectedIntegrity,
      receipt,
      candidateBytes,
      artifactRoot,
      fail,
    });
    return { receipt, published: false, returnValue: undefined };
  }
  if (dryRun) {
    receipt.upload = { state: "dry-run" };
    receipt.promotion = { channel: target.distTag, state: "dry-run" };
    await writePublicationReceipt(artifactRoot, receipt);
    log(
      `Dry-run checked exact accepted bytes for ${packageJson.name}@${target.version}; no registry write observed.`,
    );
    return {
      receipt,
      published: false,
      returnValue: { ...outcome, channelState: "dry-run", observedVersion: null },
    };
  }
  const { published, responseLost } = await runNpmPublish({
    tarballPath,
    registry,
    uploadTag,
    projectRoot,
    npmEnvironment,
    run,
    runWithOutputBound,
  });
  const reconciliation = await reconcileUploadedArchive({
    receipt,
    artifactRoot,
    packageJson,
    target,
    expectedIntegrity,
    candidateBytes,
    readArchive,
    reasonClass,
    versionReadAttempts,
    versionReadDelay,
    versionReadTimeout,
    wait,
    fail,
    log,
  });
  archive = reconciliation.archive;
  receipt.upload = {
    state: published
      ? "uploaded-verified"
      : responseLost
        ? "reconciled-after-response-loss"
        : "existing-exact-bytes",
    integrity: archive.integrity,
    size: archive.size,
    readbackAttempts: reconciliation.readbackAttempts,
    ...(archive.readbackSource ? { readbackSource: archive.readbackSource } : {}),
  };
  await writePublicationReceipt(artifactRoot, receipt);
  return { receipt, published, returnValue: undefined };
}

async function inspectVersionBeforeUpload(context) {
  const {
    phase,
    receipt,
    artifactRoot,
    target,
    expectedIntegrity,
    candidateBytes,
    reasonClass,
    fail,
    readArchive,
    log,
  } = context;
  const archive = await readCandidateVersion({
    phase,
    receipt,
    artifactRoot,
    readArchive,
    reasonClass,
  });
  if (archive === null && phase === "upload") {
    receipt.upload = { state: "pending", readbackClass: "absent" };
    await writePublicationReceipt(artifactRoot, receipt);
  }
  if (archive !== null) {
    await requireAcceptedBytes({
      archive,
      expectedIntegrity,
      receipt,
      candidateBytes,
      artifactRoot,
      fail,
    });
    if (archive.readbackSource)
      log(
        `Exact registry archive for ${context.packageJson.name}@${target.version} verified through direct project archive read after metadata E404.`,
      );
  } else if (phase === "promote") {
    receipt.promotion = {
      channel: target.distTag,
      state: "unknown",
      reasonClass: "eventual_visibility",
    };
    await writePublicationReceipt(artifactRoot, receipt);
    fail("version-bytes-unknown: immutable version disappeared before promotion");
  }
  if (phase === "promote")
    return { archive, result: { receipt, published: false, returnValue: undefined } };
  return { archive, result: null };
}

async function completeUpload(context, { archive, readArchive }) {
  const result = await publishAndReconcile({
    ...context,
    archive,
    uploadTag: `upload-${context.metadata.sourceRevision}`,
    readArchive,
  });
  if (result.returnValue) return result;
  if (result.receipt.upload.state === "pending" && archive !== null) {
    result.receipt.upload = {
      state: "existing-exact-bytes",
      integrity: archive.integrity,
      size: archive.size,
      ...(archive.readbackSource ? { readbackSource: archive.readbackSource } : {}),
    };
    await writePublicationReceipt(context.artifactRoot, result.receipt);
  }
  return result;
}

export async function runImmutableUploadPhase(context) {
  const {
    phase,
    packageJson,
    target,
    registry,
    run,
    runWithOutputBound,
    npmEnvironment,
    workRoot,
    fetchImpl,
    reasonClass,
  } = context;
  const readArchive = (readbackOptions = {}) =>
    readVersionArchive({
      name: packageJson.name,
      version: target.version,
      registry,
      env: npmEnvironment,
      run,
      destination: workRoot,
      runWithOutputBound,
      fetchImpl,
      allowDirectArchiveFallback: true,
      ...readbackOptions,
    });
  const inspected = await inspectVersionBeforeUpload({ ...context, readArchive });
  const archive = inspected.archive;
  if (inspected.result) return inspected.result;
  return completeUpload(context, { archive, readArchive });
}
