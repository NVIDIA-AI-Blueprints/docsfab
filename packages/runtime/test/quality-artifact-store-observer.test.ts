// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ArtifactStoreError } from "../src/artifacts/store.js";
import { RunMaintenanceGateError } from "../src/records/run-maintenance-gate.js";
import {
  observeQualityArtifactStore,
  type ObservedRecordStore,
} from "./helpers/quality-artifact-store-observer.js";

describe("quality artifact store diagnostic observer", () => {
  it("forwards the exact receiver and arguments and preserves resolved object identity", async () => {
    const payload = { artifactKind: "evaluation", secret: "never-output-payload" };
    const written = { digest: "opaque-write", created: true };
    const loaded = { opaque: "never-output-record" };
    const calls: unknown[][] = [];
    const store: ObservedRecordStore = {
      async putRecord(digest, value) {
        calls.push([this, digest, value]);
        return written;
      },
      async getRecord(digest) {
        calls.push([this, digest]);
        return loaded;
      },
    };
    const originalPut = store.putRecord;
    const originalGet = store.getRecord;
    const observer = observeQualityArtifactStore(store);
    expect(await store.putRecord("private-digest", payload)).toBe(written);
    expect(await store.getRecord("private-digest")).toBe(loaded);
    expect(calls).toEqual([
      [store, "private-digest", payload],
      [store, "private-digest"],
    ]);
    expect(observer.summary()).toEqual([
      {
        kind: "evaluation",
        operation: "putRecord",
        returned: 1,
        threw: 0,
        nullReadback: 0,
        undefinedReadback: 0,
        errors: [],
      },
      {
        kind: "evaluation",
        operation: "getRecord",
        returned: 1,
        threw: 0,
        nullReadback: 0,
        undefinedReadback: 0,
        errors: [],
      },
    ]);
    const assertionText = JSON.stringify({ artifactStoreObservation: observer.summary() });
    expect(assertionText).not.toContain("private-digest");
    expect(assertionText).not.toContain("never-output");
    observer.restore();
    expect(store.putRecord).toBe(originalPut);
    expect(store.getRecord).toBe(originalGet);
  });

  it("keeps thrown objects and separates known not-found from null and undefined readback", async () => {
    const notFound = new ArtifactStoreError("not-found", "private-path");
    const held = new RunMaintenanceGateError("held");
    let nextGet: unknown = notFound;
    let nextPutError: unknown;
    const store: ObservedRecordStore = {
      async putRecord() {
        if (nextPutError) throw nextPutError;
        return { created: true };
      },
      async getRecord() {
        if (nextGet === notFound) throw notFound;
        return nextGet;
      },
    };
    const observer = observeQualityArtifactStore(store);
    await store.putRecord("private-digest", { artifactKind: "candidate-report" });
    await expect(store.getRecord("private-digest")).rejects.toBe(notFound);
    nextGet = null;
    expect(await store.getRecord("private-digest")).toBeNull();
    nextGet = undefined;
    expect(await store.getRecord("private-digest")).toBeUndefined();
    nextPutError = held;
    await expect(store.putRecord("private-next", { artifactKind: "quality-score" })).rejects.toBe(
      held,
    );
    const text = JSON.stringify(observer.summary());
    expect(text).toContain('"code":"not-found"');
    expect(text).toContain('"code":"held"');
    expect(text).toContain('"nullReadback":1');
    expect(text).toContain('"undefinedReadback":1');
    expect(text).not.toContain("private-path");
    expect(text).not.toContain("private-digest");
    observer.restore();
  });

  it("redacts hostile error fields and cannot replace the original error", async () => {
    const malicious = Object.defineProperties(new Error("secret-message"), {
      name: { get: () => "secret-name" },
      code: {
        get: () => {
          throw new Error("secret-accessor");
        },
      },
      path: { value: "secret-path" },
    });
    const arbitrary = Object.assign(new Error("secret-message-two"), {
      code: "secret-arbitrary-code",
    });
    let failure: unknown = malicious;
    const store: ObservedRecordStore = {
      async putRecord() {
        throw failure;
      },
      async getRecord() {
        throw failure;
      },
    };
    const observer = observeQualityArtifactStore(store);
    await expect(store.putRecord("private-one", { artifactKind: "evaluation" })).rejects.toBe(
      malicious,
    );
    failure = arbitrary;
    await expect(store.getRecord("private-one")).rejects.toBe(arbitrary);
    const text = JSON.stringify({ artifactStoreObservation: observer.summary() });
    expect(text).toContain('"class":"unknown","code":"unknown"');
    for (const secret of [
      "secret-message",
      "secret-name",
      "secret-accessor",
      "secret-path",
      "secret-arbitrary-code",
      "private-one",
    ]) {
      expect(text).not.toContain(secret);
    }
    observer.restore();
  });

  it("starts a second write before the first settles", async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const started: string[] = [];
    const store: ObservedRecordStore = {
      putRecord(digest) {
        started.push(digest);
        return digest === "first" ? first : Promise.resolve({ second: true });
      },
      async getRecord() {
        return null;
      },
    };
    const observer = observeQualityArtifactStore(store);
    const pendingFirst = store.putRecord("first", { artifactKind: "evaluation" });
    const secondValue = { second: true };
    const pendingSecond = store.putRecord("second", { artifactKind: "quality-score" });
    expect(started).toEqual(["first", "second"]);
    expect(await pendingSecond).toEqual(secondValue);
    resolveFirst({ first: true });
    await pendingFirst;
    expect(observer.summary().filter((row) => row.operation === "putRecord")).toHaveLength(2);
    observer.restore();
  });
});
