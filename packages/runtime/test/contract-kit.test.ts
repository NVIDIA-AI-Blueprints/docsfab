// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { deepFreezeGraph } from "../src/contract-kit/freeze.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { activateContractDecodeLimits } from "../src/config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import {
  CONTRACT_DECODE_BOUND_AXES,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_DEPTH,
  CONTRACT_MAX_NODES,
  CONTRACT_MAX_STRING_CHARS,
  contractDecodeLimits,
  createContractKit,
  createHostAuthorityFactory,
  createReceiptReplayGuard,
  deepFreeze,
  formatContractBoundExceeded,
  type ContractBoundExceeded,
} from "../src/contract-kit/index.js";
import { DELEGATED_TASK_STATE_MAX_BYTES } from "../src/contract-kit/decode-bounds.js";
import {
  decodeExecutionLeasePolicy,
  ExecutionLeaseContractError,
} from "../src/execution/lease-contracts.js";
import { configureCredential } from "./helpers/configured-credential.js";

type TestCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "authority-replayed"
  | "bound-exceeded";

class TestContractError extends Error {
  public constructor(public readonly code: TestCode) {
    super(`Test contract rejected: ${code}.`);
    this.name = "TestContractError";
  }
}

function fail(code: TestCode): never {
  throw new TestContractError(code);
}

const kitCodes = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "migration-required",
  boundExceeded: "bound-exceeded",
} as const;

const kit = createContractKit({
  fail,
  codes: kitCodes,
});

const strictKit = createContractKit({
  fail,
  inertMode: "strict",
  codes: kitCodes,
});

function expectCode(run: () => unknown, code: TestCode): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TestContractError);
    expect((error as TestContractError).code).toBe(code);
  }
}

function expectBoundRefusal(run: () => unknown, details: ContractBoundExceeded): void {
  try {
    run();
    throw new Error(`expected ${details.axis}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TestContractError);
    expect((error as TestContractError).code).toBe("bound-exceeded");
    expect((error as Error).message).toContain(formatContractBoundExceeded(details));
  }
}

function decodeTestEnvelope(value: unknown) {
  return strictKit.decodeSealed(
    value,
    "docsfab-test-envelope",
    "digestSha256",
    ["payload"],
    (root) => ({ payload: root.payload }),
  );
}

function sealTestEnvelope(payload: unknown) {
  return strictKit.seal("docsfab-test-envelope", "digestSha256", { payload });
}

function unsignedTestEnvelope(payload: unknown) {
  return {
    schemaVersion: 1 as const,
    kind: "docsfab-test-envelope",
    payload,
    digestSha256: "a".repeat(64),
  };
}

function booleanRecord(count: number): Record<string, boolean> {
  const payload: Record<string, boolean> = {};
  for (let index = 0; index < count; index += 1) {
    payload[`k${index}`] = true;
  }
  return payload;
}

function nest(levels: number, leaf: unknown = true): unknown {
  let current = leaf;
  for (let index = 0; index < levels; index += 1) {
    current = { nest: current };
  }
  return current;
}

function denseBooleans(length: number): boolean[] {
  return Array.from({ length }, () => true);
}

/** Root + schemaVersion + kind + payload object + digest. */
const SEALED_ENVELOPE_OVERHEAD_NODES = 5;

const execFileAsync = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const limitsModule = fileURLToPath(new URL("../src/config/limits.ts", import.meta.url));
const kitModule = fileURLToPath(new URL("../src/contract-kit/index.ts", import.meta.url));
const leaseModule = fileURLToPath(new URL("../src/execution/lease-contracts.ts", import.meta.url));
const sourceObligationModule = fileURLToPath(
  new URL("../src/workflow-execution/source-obligation.ts", import.meta.url),
);
const executionContractsModule = fileURLToPath(
  new URL("../src/execution/contracts.ts", import.meta.url),
);

const CONTRACT_OVERRIDE_KEYS = {
  maxNodes: "DOCSFAB_RUNTIME_CONTRACT_MAX_NODES",
  maxDepth: "DOCSFAB_RUNTIME_CONTRACT_MAX_DEPTH",
  maxArrayLength: "DOCSFAB_RUNTIME_CONTRACT_MAX_ARRAY_LENGTH",
  maxStringChars: "DOCSFAB_RUNTIME_CONTRACT_MAX_STRING_CHARS",
} as const;

type ContractDecodeAxis = keyof typeof CONTRACT_OVERRIDE_KEYS;

async function runFreshContractDecodeProcess(
  env: NodeJS.ProcessEnv,
  script: string,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: runtimeRoot,
        env: { ...process.env, ...env, VITEST: "true" },
        encoding: "utf8",
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, status: 0 };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      "stdout" in error &&
      "stderr" in error
    ) {
      const failed = error as {
        code: number | string | null;
        stdout: string | Buffer;
        stderr: string | Buffer;
      };
      return {
        stdout: String(failed.stdout),
        stderr: String(failed.stderr),
        status: typeof failed.code === "number" ? failed.code : 1,
      };
    }
    throw error;
  }
}

describe("contract-kit primitives", () => {
  it("seals and round-trips decodeSealed digests", () => {
    const sealed = kit.seal("docsfab-test-envelope", "digestSha256", {
      id: "item:1",
      value: "alpha",
    });
    expect(sealed.schemaVersion).toBe(1);
    expect(sealed.kind).toBe("docsfab-test-envelope");
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(sealed.digestSha256).toBe(
      canonicalDigest({
        schemaVersion: 1,
        kind: "docsfab-test-envelope",
        id: "item:1",
        value: "alpha",
      }),
    );

    const decoded = kit.decodeSealed(
      structuredClone(sealed),
      "docsfab-test-envelope",
      "digestSha256",
      ["id", "value"],
      (root) => ({
        id: kit.identifier(root.id),
        value: kit.string(root.value),
      }),
    );
    expect(decoded).toEqual(sealed);
  });

  it("rejects digest tampering and schema mismatches", () => {
    const sealed = kit.seal("docsfab-test-envelope", "digestSha256", {
      id: "item:1",
      value: "alpha",
    });
    const tampered = { ...sealed, value: "beta" };
    expectCode(
      () =>
        kit.decodeSealed(
          tampered,
          "docsfab-test-envelope",
          "digestSha256",
          ["id", "value"],
          (root) => ({
            id: kit.identifier(root.id),
            value: kit.string(root.value),
          }),
        ),
      "digest-mismatch",
    );

    expectCode(
      () =>
        kit.decodeSealed(
          { ...sealed, kind: "other" },
          "docsfab-test-envelope",
          "digestSha256",
          ["id", "value"],
          (root) => ({
            id: kit.identifier(root.id),
            value: kit.string(root.value),
          }),
        ),
      "migration-required",
    );
  });

  it("assertInert rejects proxies, accessors, and foreign prototypes", () => {
    expectCode(() => kit.assertInert(new Proxy({}, {})), "invalid-shape");
    expectCode(() => kit.assertInert(Object.create(null)), "invalid-shape");
    expectCode(
      () =>
        kit.assertInert({
          get trap() {
            return 1;
          },
        }),
      "invalid-shape",
    );
    kit.assertInert({ ok: true, nested: [1, null, "x"] });
  });

  it("strict inertMode allows null prototypes and rejects unsafe numbers", () => {
    const strict = createContractKit({
      fail,
      inertMode: "strict",
      codes: {
        invalidShape: "invalid-shape",
        invalidValue: "invalid-value",
        digestMismatch: "digest-mismatch",
        credentialMaterial: "credential-material",
        schemaMismatch: "migration-required",
      },
    });
    const nullProto = Object.create(null);
    nullProto.ok = true;
    strict.assertInert(nullProto);
    expect(strict.object(nullProto)).toEqual({ ok: true });
    expectCode(() => strict.assertInert(Number.NaN), "invalid-value");
    expectCode(() => strict.assertInert(-0), "invalid-value");
    strict.exact({ a: 1 }, ["a", "b"], ["b"]);
    expectCode(() => strict.exact({ a: 1 }, ["a", "b"]), "invalid-shape");
    let traps = 0;
    const proxiedArray = new Proxy([], {
      getPrototypeOf() {
        traps += 1;
        return Array.prototype;
      },
      ownKeys() {
        traps += 1;
        return ["length"];
      },
    });
    expectCode(() => strict.array(proxiedArray), "invalid-shape");
    expect(traps).toBe(0);
    const accessor = [1];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => 1 });
    expectCode(() => strict.array(accessor), "invalid-shape");
    expectCode(() => strict.array(new Array(1)), "invalid-shape");
    const extra = [1] as unknown[] & { extra?: boolean };
    extra.extra = true;
    expectCode(() => strict.array(extra), "invalid-shape");
    const symbolic = [1];
    Object.defineProperty(symbolic, Symbol("extra"), { value: true });
    expectCode(() => strict.array(symbolic), "invalid-shape");
  });

  it("exact and noUnknown enforce closed key sets", () => {
    const root = { a: 1, b: 2 };
    kit.exact(root, ["a", "b"]);
    expectCode(() => kit.exact(root, ["a"]), "invalid-shape");
    expectCode(() => kit.exact(root, ["a", "b", "c"]), "invalid-shape");
    kit.noUnknown(root, ["a", "b", "c"]);
    expectCode(() => kit.noUnknown(root, ["a"]), "invalid-shape");
  });

  it("hash, identifier, and timestamp helpers validate formats", () => {
    const hash = "a".repeat(64);
    expect(kit.hash(hash)).toBe(hash);
    expect(kit.nullableHash(null)).toBeNull();
    expect(kit.identifier("run:1")).toBe("run:1");
    expect(kit.timestamp("2024-01-02T03:04:05.006Z")).toBe("2024-01-02T03:04:05.006Z");
    expect(kit.revision("b".repeat(40))).toBe("b".repeat(40));
    expectCode(() => kit.hash("not-a-hash"), "invalid-value");
    expectCode(() => kit.identifier(""), "invalid-value");
    expectCode(() => kit.timestamp("2024-01-02T03:04:05Z"), "invalid-value");
  });

  it("rejectCredentials fails closed on a configured credential, and passes a shape", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    // A credential shape alone never refuses a record (#1807).
    kit.rejectCredentials({ token });
    configureCredential(token);
    expectCode(() => kit.rejectCredentials({ token }), "credential-material");
    expectCode(
      () => kit.rejectCredentials({ note: `echo ${token.slice(4, 24)}` }),
      "credential-material",
    );
    kit.rejectCredentials({ title: "safe public title" });
  });

  it("deepFreeze freezes nested plain objects", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  it("deepFreezeGraph traverses frozen containers without changing deepFreeze defaults", () => {
    const nested = { value: 1 };
    const value = Object.freeze({ nested });
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(nested)).toBe(false);
    expect(deepFreezeGraph(value)).toBe(value);
    expect(Object.isFrozen(nested)).toBe(true);
  });

  it("deepFreezeGraph handles shared and cyclic descriptors without executing accessors", () => {
    let reads = 0;
    const shared = { value: 1 };
    const value: {
      shared: typeof shared;
      island: readonly object[];
      self?: unknown;
      readonly active: number;
    } = {
      shared,
      island: Object.freeze([shared]),
      get active() {
        reads++;
        return 1;
      },
    };
    value.self = value;
    Object.freeze(value);
    expect(deepFreezeGraph(value)).toBe(value);
    expect(reads).toBe(0);
    expect(value.self).toBe(value);
    expect(value.island[0]).toBe(shared);
    expect(Object.isFrozen(shared)).toBe(true);
  });

  it("receipt replay guard rejects reused receipts per verifier", () => {
    const guard = createReceiptReplayGuard(fail, "authority-replayed");
    const verifier = { id: "v1" };
    guard.consume(verifier, "c".repeat(64));
    expectCode(() => guard.consume(verifier, "c".repeat(64)), "authority-replayed");
    guard.consume({ id: "v2" }, "c".repeat(64));
  });
});

describe("contract-kit decode bounds", () => {
  it("loads the four decode axes from the central catalog at the 2026-09-18 defaults", () => {
    expect(CONTRACT_MAX_NODES).toBe(
      LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES.maxNodes]!.value,
    );
    expect(CONTRACT_MAX_DEPTH).toBe(
      LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES.maxDepth]!.value,
    );
    expect(CONTRACT_MAX_ARRAY_LENGTH).toBe(
      LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES.maxArrayLength]!.value,
    );
    expect(CONTRACT_MAX_STRING_CHARS).toBe(
      LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES.maxStringChars]!.value,
    );
    expect(CONTRACT_MAX_NODES).toBe(100_000);
    expect(CONTRACT_MAX_DEPTH).toBe(64);
    expect(CONTRACT_MAX_ARRAY_LENGTH).toBe(10_000);
    expect(CONTRACT_MAX_STRING_CHARS).toBe(65_536);
    expect(contractDecodeLimits()).toEqual({
      maxNodes: CONTRACT_MAX_NODES,
      maxDepth: CONTRACT_MAX_DEPTH,
      maxArrayLength: CONTRACT_MAX_ARRAY_LENGTH,
      maxStringChars: CONTRACT_MAX_STRING_CHARS,
      stateMaxBytes: DELEGATED_TASK_STATE_MAX_BYTES,
    });
    expect(LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES.maxNodes]!.scope).not.toBe("sealed");
  });

  it("refuses a raised or malformed host override at supported startup", () => {
    const raised = [
      {
        environment: { [CONTRACT_OVERRIDE_KEYS.maxNodes]: String(CONTRACT_MAX_NODES + 1) },
        message: "DOCSFAB_RUNTIME_CONTRACT_MAX_NODES must be an integer between 1 and 100000.",
      },
      {
        environment: { [CONTRACT_OVERRIDE_KEYS.maxDepth]: String(CONTRACT_MAX_DEPTH + 1) },
        message: "DOCSFAB_RUNTIME_CONTRACT_MAX_DEPTH must be an integer between 1 and 64.",
      },
      {
        environment: {
          [CONTRACT_OVERRIDE_KEYS.maxArrayLength]: String(CONTRACT_MAX_ARRAY_LENGTH + 1),
        },
        message:
          "DOCSFAB_RUNTIME_CONTRACT_MAX_ARRAY_LENGTH must be an integer between 1 and 10000.",
      },
      {
        environment: {
          [CONTRACT_OVERRIDE_KEYS.maxStringChars]: String(CONTRACT_MAX_STRING_CHARS + 1),
        },
        message:
          "DOCSFAB_RUNTIME_CONTRACT_MAX_STRING_CHARS must be an integer between 1 and 65536.",
      },
    ] as const;
    for (const testCase of raised) {
      expect(() =>
        activateContractDecodeLimits({ environment: testCase.environment, hostFile: null }),
      ).toThrow(testCase.message);
    }

    const malformedValues = ["nope", "1.5", "0"];
    for (const [axis, key] of Object.entries(CONTRACT_OVERRIDE_KEYS)) {
      const catalog =
        LIMIT_DEFINITION_BY_NAME[CONTRACT_DECODE_BOUND_AXES[axis as ContractDecodeAxis]]!;
      const message = `${key} must be an integer between ${catalog.min} and ${catalog.max}.`;
      for (const value of malformedValues) {
        expect(() =>
          activateContractDecodeLimits({ environment: { [key]: value }, hostFile: null }),
        ).toThrow(message);
      }
    }

    expect(contractDecodeLimits()).toEqual({
      maxNodes: CONTRACT_MAX_NODES,
      maxDepth: CONTRACT_MAX_DEPTH,
      maxArrayLength: CONTRACT_MAX_ARRAY_LENGTH,
      maxStringChars: CONTRACT_MAX_STRING_CHARS,
      stateMaxBytes: DELEGATED_TASK_STATE_MAX_BYTES,
    });
  });

  it("decodes at runtime.contract.maxNodes and names the axis at limit plus one", () => {
    // decodeSealed also scans credentials (20_000 nodes); the named bound is the inert walk.
    const atLimitKeys = CONTRACT_MAX_NODES - 1;
    strictKit.assertInert(booleanRecord(atLimitKeys));

    const observed = CONTRACT_MAX_NODES + 1;
    expectBoundRefusal(
      () =>
        decodeTestEnvelope(
          unsignedTestEnvelope(booleanRecord(observed - SEALED_ENVELOPE_OVERHEAD_NODES)),
        ),
      {
        axis: CONTRACT_DECODE_BOUND_AXES.maxNodes,
        limit: CONTRACT_MAX_NODES,
        observed,
      },
    );
  });

  it("decodes at runtime.contract.maxDepth and names the axis at limit plus one", () => {
    // decodeSealed also scans credentials (depth 24); the named bound is the inert walk.
    // Root at depth 0, so CONTRACT_MAX_DEPTH wrappers put the leaf at the limit.
    strictKit.assertInert(nest(CONTRACT_MAX_DEPTH));

    const observed = CONTRACT_MAX_DEPTH + 1;
    expectBoundRefusal(() => decodeTestEnvelope(unsignedTestEnvelope(nest(CONTRACT_MAX_DEPTH))), {
      axis: CONTRACT_DECODE_BOUND_AXES.maxDepth,
      limit: CONTRACT_MAX_DEPTH,
      observed,
    });
  });

  it("decodes at runtime.contract.maxArrayLength and names the axis at limit plus one", () => {
    const decoded = decodeTestEnvelope(sealTestEnvelope(denseBooleans(CONTRACT_MAX_ARRAY_LENGTH)));
    expect(decoded.payload).toEqual(denseBooleans(CONTRACT_MAX_ARRAY_LENGTH));
    expect(kit.array(denseBooleans(CONTRACT_MAX_ARRAY_LENGTH))).toHaveLength(
      CONTRACT_MAX_ARRAY_LENGTH,
    );

    const observed = CONTRACT_MAX_ARRAY_LENGTH + 1;
    const details = {
      axis: CONTRACT_DECODE_BOUND_AXES.maxArrayLength,
      limit: CONTRACT_MAX_ARRAY_LENGTH,
      observed,
    };
    expectBoundRefusal(
      () => decodeTestEnvelope(unsignedTestEnvelope(denseBooleans(observed))),
      details,
    );
    expectBoundRefusal(() => kit.array(denseBooleans(observed)), details);
  });

  it("decodes at runtime.contract.maxStringChars and names the axis at limit plus one", () => {
    const atLimit = "a".repeat(CONTRACT_MAX_STRING_CHARS);
    const decoded = decodeTestEnvelope(sealTestEnvelope(atLimit));
    expect(decoded.payload).toBe(atLimit);

    const observed = CONTRACT_MAX_STRING_CHARS + 1;
    expectBoundRefusal(() => decodeTestEnvelope(unsignedTestEnvelope("a".repeat(observed))), {
      axis: CONTRACT_DECODE_BOUND_AXES.maxStringChars,
      limit: CONTRACT_MAX_STRING_CHARS,
      observed,
    });
  });

  it("lease decode reports bound axis and observed value", () => {
    const observed = CONTRACT_MAX_STRING_CHARS + 1;
    try {
      decodeExecutionLeasePolicy({ payload: "a".repeat(observed) });
      throw new Error("expected lease bound refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionLeaseContractError);
      expect((error as ExecutionLeaseContractError).code).toBe("invalid-policy");
      expect((error as Error).message).toContain(
        formatContractBoundExceeded({
          axis: CONTRACT_DECODE_BOUND_AXES.maxStringChars,
          limit: CONTRACT_MAX_STRING_CHARS,
          observed,
        }),
      );
    }
  });
});

function shrinkProbeScript(axis: ContractDecodeAxis): string {
  return `
import { activateContractDecodeLimits } from ${JSON.stringify(limitsModule)};
import {
  CONTRACT_DECODE_BOUND_AXES,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_DEPTH,
  CONTRACT_MAX_NODES,
  CONTRACT_MAX_STRING_CHARS,
  contractDecodeLimits,
  createContractKit,
  formatContractBoundExceeded,
} from ${JSON.stringify(kitModule)};
import {
  decodeExecutionLeasePolicy,
  ExecutionLeaseContractError,
} from ${JSON.stringify(leaseModule)};
import { InferenceStepError } from ${JSON.stringify(executionContractsModule)};
import { decodeSourceObligationResponse } from ${JSON.stringify(sourceObligationModule)};

class ProbeError extends Error {
  constructor(code) {
    super("Probe: " + code);
    this.code = code;
  }
}

function fail(code) {
  throw new ProbeError(code);
}

const codes = {
  invalidShape: "invalid-shape",
  invalidValue: "invalid-value",
  digestMismatch: "digest-mismatch",
  credentialMaterial: "credential-material",
  schemaMismatch: "migration-required",
  boundExceeded: "bound-exceeded",
};
const strict = createContractKit({ fail, inertMode: "strict", codes });
const standard = createContractKit({ fail, codes });
const axis = ${JSON.stringify(axis)};
const catalog = {
  maxNodes: CONTRACT_MAX_NODES,
  maxDepth: CONTRACT_MAX_DEPTH,
  maxArrayLength: CONTRACT_MAX_ARRAY_LENGTH,
  maxStringChars: CONTRACT_MAX_STRING_CHARS,
};

activateContractDecodeLimits({ hostFile: null });
const bounds = contractDecodeLimits();
if (bounds[axis] !== 1) {
  throw new Error("effective " + axis + "=" + bounds[axis]);
}
for (const name of Object.keys(catalog)) {
  if (name !== axis && bounds[name] !== catalog[name]) {
    throw new Error("unrelated axis " + name + "=" + bounds[name]);
  }
}

function expectBound(run, observed) {
  try {
    run();
    throw new Error("expected bound " + axis);
  } catch (error) {
    if (!(error instanceof ProbeError) || error.code !== "bound-exceeded") throw error;
    const fragment = formatContractBoundExceeded({
      axis: CONTRACT_DECODE_BOUND_AXES[axis],
      limit: bounds[axis],
      observed,
    });
    if (!error.message.includes(fragment)) {
      throw new Error("missing " + fragment + " in " + error.message);
    }
  }
}

function expectLeaseBound(value, observed) {
  try {
    decodeExecutionLeasePolicy(value);
    throw new Error("expected lease bound");
  } catch (error) {
    if (!(error instanceof ExecutionLeaseContractError) || error.code !== "invalid-policy") throw error;
    const fragment = formatContractBoundExceeded({
      axis: CONTRACT_DECODE_BOUND_AXES[axis],
      limit: bounds[axis],
      observed,
    });
    if (!error.message.includes(fragment)) {
      throw new Error("lease missing " + fragment + " in " + error.message);
    }
  }
}

function expectLeaseUnbound(value) {
  try {
    decodeExecutionLeasePolicy(value);
    throw new Error("expected lease shape refusal");
  } catch (error) {
    if (!(error instanceof ExecutionLeaseContractError) || error.code !== "invalid-policy") throw error;
    if (error.message.includes("bound-exceeded")) {
      throw new Error("lease N hit bound: " + error.message);
    }
  }
}

function expectSourceBound(json) {
  try {
    decodeSourceObligationResponse(json);
    throw new Error("expected source bound");
  } catch (error) {
    if (!(error instanceof InferenceStepError) || error.rejection?.code !== "bounds-exceeded") {
      throw new Error("source N+1 " + (error?.rejection?.code ?? error?.message));
    }
  }
}

function expectSourceUnbound(json) {
  try {
    decodeSourceObligationResponse(json);
    throw new Error("expected source content refusal");
  } catch (error) {
    if (!(error instanceof InferenceStepError)) throw error;
    if (error.rejection?.code === "bounds-exceeded") {
      throw new Error("source N hit bound: " + error.message);
    }
  }
}

if (axis === "maxStringChars") {
  strict.assertInert("x");
  expectBound(() => strict.assertInert("xx"), 2);
  expectLeaseUnbound({ payload: "x" });
  expectLeaseBound({ payload: "xx" }, 2);
  expectSourceUnbound(JSON.stringify({ completeness: "a", dimensions: [], limitations: [] }));
  expectSourceBound(JSON.stringify({ completeness: "aa", dimensions: [], limitations: [] }));
} else if (axis === "maxArrayLength") {
  strict.assertInert([true]);
  standard.array([true]);
  expectBound(() => strict.assertInert([true, true]), 2);
  expectBound(() => standard.array([true, true]), 2);
  expectLeaseUnbound({ payload: [true] });
  expectLeaseBound({ payload: [true, true] }, 2);
  expectSourceUnbound(JSON.stringify({ completeness: "a", dimensions: [true], limitations: [] }));
  expectSourceBound(JSON.stringify({ completeness: "a", dimensions: [true, true], limitations: [] }));
} else if (axis === "maxDepth") {
  strict.assertInert({ nest: true });
  expectBound(() => strict.assertInert({ nest: { nest: true } }), 2);
  expectLeaseUnbound({ payload: true });
  expectLeaseBound({ payload: { nest: true } }, 2);
  expectSourceUnbound(JSON.stringify({ completeness: "a", dimensions: true, limitations: [] }));
  expectSourceBound(JSON.stringify({ completeness: "a", dimensions: { x: true }, limitations: [] }));
} else if (axis === "maxNodes") {
  strict.assertInert(true);
  expectBound(() => strict.assertInert({ a: true }), 2);
  expectLeaseUnbound(true);
  expectLeaseBound({ a: true }, 2);
  expectSourceUnbound(JSON.stringify(true));
  expectSourceBound(JSON.stringify({ completeness: "a", dimensions: true, limitations: [] }));
} else {
  throw new Error("unknown axis " + axis);
}

console.log(JSON.stringify({ ok: true, axis, effective: bounds[axis] }));
`.trim();
}

describe("contract-kit host shrink snapshot", () => {
  it.each(Object.keys(CONTRACT_OVERRIDE_KEYS) as ContractDecodeAxis[])(
    "enforces a fresh-process shrink of %s at bound and bound plus one",
    async (axis) => {
      const child = await runFreshContractDecodeProcess(
        { [CONTRACT_OVERRIDE_KEYS[axis]]: "1" },
        shrinkProbeScript(axis),
      );
      expect(child.status, `${child.stdout}${child.stderr}`).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ ok: true, axis, effective: 1 });
    },
  );

  it("refuses a raised process-env override through supported startup", async () => {
    const child = await runFreshContractDecodeProcess(
      { [CONTRACT_OVERRIDE_KEYS.maxStringChars]: String(CONTRACT_MAX_STRING_CHARS + 1) },
      `
import { activateContractDecodeLimits } from ${JSON.stringify(limitsModule)};
activateContractDecodeLimits({ hostFile: null });
`.trim(),
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr + child.stdout).toContain(
      "DOCSFAB_RUNTIME_CONTRACT_MAX_STRING_CHARS must be an integer between 1 and 65536.",
    );
  });

  it("refuses a malformed process-env override through supported startup", async () => {
    const child = await runFreshContractDecodeProcess(
      { [CONTRACT_OVERRIDE_KEYS.maxNodes]: "nope" },
      `
import { activateContractDecodeLimits } from ${JSON.stringify(limitsModule)};
activateContractDecodeLimits({ hostFile: null });
`.trim(),
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr + child.stdout).toContain(
      "DOCSFAB_RUNTIME_CONTRACT_MAX_NODES must be an integer between 1 and 100000.",
    );
  });
});

describe("host-authority WeakMap factory", () => {
  interface Challenge {
    challengeSha256: string;
  }

  interface Verifier {
    verifyCurrent(challenge: Challenge): Promise<{ status: "current" }>;
  }

  const factory = createHostAuthorityFactory<"docsfab-test-internal-host-authority", Verifier>({
    kind: "docsfab-test-internal-host-authority",
    invalidMessage: "Trusted test host verifier is invalid.",
  });

  it("mints opaque authority and looks up the verifier by identity", async () => {
    const verifier: Verifier = {
      async verifyCurrent() {
        return { status: "current" };
      },
    };
    const authority = factory.create(verifier);
    expect(authority.kind).toBe("docsfab-test-internal-host-authority");
    expect(factory.lookup(authority)).toBe(verifier);
    await expect(
      factory.lookup(authority)!.verifyCurrent({
        challengeSha256: "d".repeat(64),
      }),
    ).resolves.toEqual({ status: "current" });
  });

  it("rejects lookalike kind objects and invalid verifiers", () => {
    const lookalike = { kind: "docsfab-test-internal-host-authority" as const };
    expect(factory.lookup(lookalike)).toBeUndefined();
    expect(() => factory.create(null as never)).toThrow("Trusted test host verifier is invalid.");
    expect(() => factory.create({} as Verifier)).toThrow("Trusted test host verifier is invalid.");
  });
});
