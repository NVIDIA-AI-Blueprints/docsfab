// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const KNOWLEDGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_VALIDATOR = join(
  KNOWLEDGE_ROOT,
  "skills/register-source-thread/scripts/source_thread.py",
);
const SOURCE_SCHEMA = join(
  KNOWLEDGE_ROOT,
  "skills/register-source-thread/references/source-item-v1.schema.json",
);
const VISUAL_TEST = join(
  KNOWLEDGE_ROOT,
  "skills/synthesize-source-threads/tests/test_validate_visual_closure.py",
);
// Skip only when the whole live model is absent, as in the exported tree; a partial model still runs and fails.
const liveModelSkip = (base) =>
  existsSync(join(base, ".docsfab/reference-model"))
    ? false
    : "live repository model .docsfab/reference-model is absent from this tree";
const PROCEDURAL_GUIDANCE = Object.fromEntries(
  [
    ["registrationSkill", "skills/register-source-thread/SKILL.md"],
    ["registrationContract", "skills/register-source-thread/references/source-thread-contract.md"],
    ["synthesisSkill", "skills/synthesize-source-threads/SKILL.md"],
    ["synthesisContract", "skills/synthesize-source-threads/references/synthesis-contract.md"],
    ["convergenceSkill", "skills/converge-documentation/SKILL.md"],
    ["convergenceContract", "skills/converge-documentation/references/convergence-contract.md"],
  ].map(([name, relative]) => [name, readFileSync(join(KNOWLEDGE_ROOT, relative), "utf8")]),
);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const VISUAL_MIME_VARIANTS = [
  "Image/Svg+Xml; charset=utf-8",
  "Text/Mermaid; charset=utf-8",
  "Text/Vnd.Mermaid; charset=utf-8",
  "Text/X-Mermaid; charset=utf-8",
  "Text/Graphviz; charset=utf-8",
  "Text/Vnd.Graphviz; charset=utf-8",
  "Text/X-Graphviz; charset=utf-8",
  "Text/PlantUML; charset=utf-8",
  "Text/Vnd.PlantUML; charset=utf-8",
  "Text/X-PlantUML; charset=utf-8",
  "Application/Vnd.Graphviz; version=1",
  "Application/Vnd.PlantUML; version=1",
  "Application/Vnd.Jgraph.Mxfile; version=1",
];

function validateWithDraft202012(instances) {
  const script = `
import json, sys
from jsonschema import Draft202012Validator
with open(sys.argv[1], encoding="utf-8") as handle:
    schema = json.load(handle)
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema)
instances = json.load(sys.stdin)
print(json.dumps([[error.message for error in validator.iter_errors(value)] for value in instances]))
`;
  const result = spawnSync("python3", ["-c", script, SOURCE_SCHEMA], {
    encoding: "utf8",
    input: JSON.stringify(instances),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "docsfab-governed-visual-"));
  const itemId = "ITEM-VISUAL-ONE";
  const sourceBytes = Buffer.from("flowchart LR\n  A --> B\n");
  const sourceDigest = digest(sourceBytes);
  const retained = `artifacts/sha256/${sourceDigest.slice(0, 2)}/${sourceDigest}`;
  mkdirSync(join(root, dirname(retained)), { recursive: true });
  mkdirSync(join(root, "views"), { recursive: true });
  writeFileSync(join(root, retained), sourceBytes);

  const representation = {
    representation_id: "source-diagram",
    role: "descriptive-source-role",
    visual_metadata: {
      artifact_kind: "diagram",
      provenance_role: "source",
      lifecycle_disposition: "current",
    },
    media_type: "text/vnd.mermaid",
    original_filename: "diagram.mmd",
    size_bytes: sourceBytes.length,
    locator: {
      scheme: "thread-artifact",
      uri: retained,
      repository: null,
      commit: null,
      path: null,
      external_version: null,
      retained_copy: retained,
    },
    integrity: { algorithm: "sha256", value: sourceDigest },
    derived_from: [],
    transform: null,
    access_override: null,
  };
  const item = {
    schema_version: "docsfab.knowledge.source-item/v2",
    item_id: itemId,
    thread_id: "SRC-VISUAL",
    artifact_type: "diagram",
    governed_visual: true,
    title: "Governed visual fixture",
    summary: null,
    attribution: { author: "fixture", contributors: [], collector: "test" },
    timestamps: {
      source_created_at: "2026-09-08T00:00:00Z",
      ingested_at: "2026-09-08T00:00:01Z",
    },
    version: { kind: "content-hash", value: sourceDigest },
    scope: {
      product_version: "fixture",
      deployment: "test",
      audience: "test",
      model_region: "architecture",
    },
    representations: [representation],
    members: [],
    governance: {
      consent: "test",
      citation_boundary: "test",
      retention_boundary: "test",
      redistribution_boundary: "test",
      access_classification: "test",
    },
    lineage: { parent_item_ids: [], supersedes: [], related_item_ids: [] },
    transforms: [],
    evidence_state: "source-authored",
    limitations: [],
  };
  const thread = {
    schema_version: "docsfab.knowledge.source-thread/v1",
    thread_id: "SRC-VISUAL",
    origin: { kind: "artifact", identity: "fixture", identity_state: "verified" },
    created_at: "2026-09-08T00:00:00Z",
    access: { classification: "test" },
    item_ids: [itemId],
    relations: [],
    event_log: "events.jsonl",
    head_event_ids: ["EVT-ITEM"],
  };
  const events = [
    {
      schema_version: "docsfab.knowledge.source-event/v1",
      event_id: "EVT-THREAD",
      thread_id: "SRC-VISUAL",
      sequence: 1,
      occurred_at: "2026-09-08T00:00:00Z",
      actor: "test",
      event_type: "thread.created",
      item_id: null,
      parent_event_ids: [],
      payload: {},
    },
    {
      schema_version: "docsfab.knowledge.source-event/v1",
      event_id: "EVT-ITEM",
      thread_id: "SRC-VISUAL",
      sequence: 2,
      occurred_at: "2026-09-08T00:00:01Z",
      actor: "test",
      event_type: "item.registered",
      item_id: itemId,
      parent_event_ids: ["EVT-THREAD"],
      payload: { representation_ids: ["source-diagram"] },
    },
  ];
  writeJson(join(root, "thread.json"), thread);
  writeJson(join(root, "items", `${itemId}.json`), item);
  writeFileSync(join(root, "events.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  return { root, item, representation };
}

function validateSource(root) {
  return spawnSync("python3", [SOURCE_VALIDATOR, "validate", root], {
    encoding: "utf8",
  });
}

const LEGACY_HARNESS = `
import importlib.util, json, pathlib, sys
spec = importlib.util.spec_from_file_location("source_thread_legacy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if len(sys.argv) == 2:
    print(json.dumps(sorted(module.LEGACY_V1_VISUAL_ITEM_SHA256)))
    raise SystemExit(0)
module.LEGACY_V1_VISUAL_ITEM_SHA256 = frozenset(json.loads(sys.argv[3]))
try:
    module.validate_thread(pathlib.Path(sys.argv[2]))
except module.ContractError as exc:
    print(f"error: {exc}", file=sys.stderr)
    raise SystemExit(1)
`;

function validateWithLegacyDigests(root, digests) {
  return spawnSync("python3", ["-c", LEGACY_HARNESS, SOURCE_VALIDATOR, root, JSON.stringify(digests)], {
    encoding: "utf8",
  });
}

function legacyVisualDigests() {
  const result = spawnSync("python3", ["-c", LEGACY_HARNESS, SOURCE_VALIDATOR], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function withFixture(callback) {
  const fixture = sourceFixture();
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test("source schema defines independent governed-visual provenance and lifecycle", () => {
  const schema = JSON.parse(readFileSync(SOURCE_SCHEMA, "utf8"));
  const representation = schema.$defs.representation.properties;
  assert.deepEqual(
    representation.visual_metadata.properties.provenance_role.enum,
    ["source", "derived"],
  );
  assert.deepEqual(
    representation.visual_metadata.properties.lifecycle_disposition.enum,
    ["current", "superseded", "rejected"],
  );
  assert.deepEqual(schema.properties.schema_version.enum, [
    "docsfab.knowledge.source-item/v1",
    "docsfab.knowledge.source-item/v2",
  ]);
});

test("authoritative JSON Schema rejects governed-visual custody and lineage bypasses", () => {
  withFixture(({ item }) => {
    const candidates = [structuredClone(item)];
    const names = ["valid retained"];
    const mutations = [
      ["mutable HTTPS", (candidate) => {
        candidate.representations[0].locator = {
          ...candidate.representations[0].locator,
          scheme: "https",
          uri: "https://example.test/visual",
          retained_copy: null,
        };
      }],
      ["null integrity", (candidate) => {
        candidate.representations[0].integrity.value = null;
      }],
      ["omitted metadata", (candidate) => {
        delete candidate.representations[0].visual_metadata;
      }],
      ["derived without lineage", (candidate) => {
        candidate.representations[0].visual_metadata.provenance_role = "derived";
      }],
      ["source with derived lineage", (candidate) => {
        candidate.representations[0].derived_from = ["parent"];
        candidate.representations[0].transform = {
          tool: "fixture",
          version: "1",
          method: "fixture",
          review_state: "fixture",
        };
      }],
      ["second inferred visual without metadata", (candidate) => {
        const second = structuredClone(candidate.representations[0]);
        second.representation_id = "unmarked-second-visual";
        second.media_type = "Text/Vnd.Mermaid; charset=utf-8";
        delete second.visual_metadata;
        second.locator = {
          ...second.locator,
          scheme: "https",
          uri: "https://example.test/mutable-second-visual",
          retained_copy: null,
        };
        second.integrity.value = null;
        candidate.representations.push(second);
      }],
      ["member inferred visual without metadata", (candidate) => {
        const second = structuredClone(candidate.representations[0]);
        second.representation_id = "unmarked-member-visual";
        second.media_type = "Application/Vnd.Graphviz; version=1";
        delete second.visual_metadata;
        second.locator = {
          ...second.locator,
          scheme: "https",
          uri: "https://example.test/mutable-member-visual",
          retained_copy: null,
        };
        second.integrity.value = null;
        candidate.members = [{
          member_id: "visual-member",
          title: "Visual member",
          artifact_type: "diagram",
          representations: [second],
        }];
      }],
      ["parameterized image without metadata", (candidate) => {
        const second = structuredClone(candidate.representations[0]);
        second.representation_id = "unmarked-image";
        second.media_type = "IMAGE/SVG+XML; charset=utf-8";
        delete second.visual_metadata;
        candidate.representations.push(second);
      }],
      ["parameterized PlantUML without metadata", (candidate) => {
        const second = structuredClone(candidate.representations[0]);
        second.representation_id = "unmarked-plantuml";
        second.media_type = "Text/Vnd.PlantUML; charset=utf-8";
        delete second.visual_metadata;
        candidate.representations.push(second);
      }],
      ["false visual flag with parameterized Mermaid", (candidate) => {
        candidate.artifact_type = "correction";
        candidate.governed_visual = false;
        const representation = candidate.representations[0];
        representation.media_type = "Text/Vnd.Mermaid; charset=utf-8";
        representation.locator = {
          ...representation.locator,
          scheme: "content-addressed",
          uri: `sha256:${representation.integrity.value}`,
          retained_copy: null,
        };
        representation.size_bytes = null;
        delete representation.visual_metadata;
      }],
    ];
    for (const [name, mutate] of mutations) {
      const candidate = structuredClone(item);
      mutate(candidate);
      candidates.push(candidate);
      names.push(name);
    }

    const contentAddressed = structuredClone(item);
    const checksum = contentAddressed.representations[0].integrity.value;
    contentAddressed.representations[0].locator = {
      ...contentAddressed.representations[0].locator,
      scheme: "content-addressed",
      uri: `sha256:${checksum}`,
      retained_copy: null,
    };
    contentAddressed.representations[0].size_bytes = null;
    candidates.push(contentAddressed);
    names.push("valid content addressed");
    const nonvisualCompanion = structuredClone(item);
    const companion = structuredClone(nonvisualCompanion.representations[0]);
    companion.representation_id = "nonvisual-companion";
    companion.media_type = "text/plain; charset=utf-8";
    companion.locator = {
      ...companion.locator,
      scheme: "content-addressed",
      uri: `sha256:${companion.integrity.value}`,
      retained_copy: null,
    };
    companion.size_bytes = null;
    delete companion.visual_metadata;
    nonvisualCompanion.representations.push(companion);
    candidates.push(nonvisualCompanion);
    names.push("valid nonvisual companion");

    const results = validateWithDraft202012(candidates);
    assert.deepEqual(results[0], [], names[0]);
    for (let index = 1; index <= mutations.length; index += 1) {
      assert.notDeepEqual(results[index], [], names[index]);
    }
    for (let index = results.length - 2; index < results.length; index += 1) {
      assert.deepEqual(results[index], [], names[index]);
    }
  });
});

test("visual member artifact types govern opaque collection representations", () => {
  withFixture(({ root, item }) => {
    const visualArtifactTypes = [
      "diagram",
      "image",
      "presentation",
      "architecture-view",
      "diagram-collection",
      "state-machine",
      "timeline",
    ];
    const collectionWithMember = (artifactType, governedVisual) => {
      const candidate = structuredClone(item);
      const representation = structuredClone(candidate.representations[0]);
      representation.media_type = "application/octet-stream";
      delete representation.visual_metadata;
      candidate.artifact_type = "document-collection";
      candidate.governed_visual = governedVisual;
      candidate.representations = [];
      candidate.members = [{
        member_id: "opaque-member",
        title: "Opaque member",
        artifact_type: artifactType,
        representations: [representation],
      }];
      return candidate;
    };

    const visualFlagBypasses = visualArtifactTypes.map((artifactType) => (
      collectionWithMember(artifactType, false)
    ));
    const visualMetadataBypass = collectionWithMember("diagram", true);
    const nonvisualMember = collectionWithMember("document", false);
    const schemaResults = validateWithDraft202012([
      ...visualFlagBypasses,
      visualMetadataBypass,
      nonvisualMember,
    ]);
    visualArtifactTypes.forEach((artifactType, index) => {
      assert.notDeepEqual(
        schemaResults[index],
        [],
        `${artifactType} member must govern collection`,
      );
    });
    assert.notDeepEqual(
      schemaResults[visualFlagBypasses.length],
      [],
      "visual member requires metadata",
    );
    assert.deepEqual(
      schemaResults[visualFlagBypasses.length + 1],
      [],
      "nonvisual member remains nonvisual",
    );

    for (const visualFlagBypass of visualFlagBypasses) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), visualFlagBypass);
      const result = validateSource(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /governed_visual must be true for inferred visual items/u);
    }

    writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), visualMetadataBypass);
    let result = validateSource(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inferred visual representations require visual_metadata/u);

    writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), nonvisualMember);
    result = validateSource(root);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("visual metadata independently governs opaque representations", () => {
  withFixture(({ root, item }) => {
    const opaqueCandidate = (placement, governedVisual) => {
      const candidate = structuredClone(item);
      const representation = structuredClone(candidate.representations[0]);
      representation.media_type = "application/octet-stream";
      representation.locator = {
        ...representation.locator,
        scheme: "content-addressed",
        uri: `sha256:${representation.integrity.value}`,
        retained_copy: null,
      };
      representation.size_bytes = null;
      candidate.governed_visual = governedVisual;
      if (placement === "top-level") {
        candidate.artifact_type = "correction";
        candidate.representations = [representation];
        candidate.members = [];
      } else {
        candidate.artifact_type = "document-collection";
        candidate.representations = [];
        candidate.members = [{
          member_id: "opaque-nonvisual-member",
          title: "Opaque nonvisual member",
          artifact_type: "document",
          representations: [representation],
        }];
      }
      return candidate;
    };

    const placements = ["top-level", "member"];
    const placedRepresentation = (candidate, placement) => (
      placement === "top-level"
        ? candidate.representations[0]
        : candidate.members[0].representations[0]
    );
    const falseFlagCandidates = placements.map((placement) => (
      opaqueCandidate(placement, false)
    ));
    const nullFalseCandidates = placements.map((placement) => {
      const candidate = opaqueCandidate(placement, false);
      placedRepresentation(candidate, placement).visual_metadata = null;
      return candidate;
    });
    const nullGovernedCandidates = placements.map((placement) => {
      const candidate = opaqueCandidate(placement, true);
      placedRepresentation(candidate, placement).visual_metadata = null;
      return candidate;
    });
    const governedCandidates = placements.map((placement) => (
      opaqueCandidate(placement, true)
    ));
    const omittedCandidates = placements.map((placement) => {
      const candidate = opaqueCandidate(placement, false);
      delete placedRepresentation(candidate, placement).visual_metadata;
      return candidate;
    });
    const schemaResults = validateWithDraft202012([
      ...falseFlagCandidates,
      ...nullFalseCandidates,
      ...nullGovernedCandidates,
      ...governedCandidates,
      ...omittedCandidates,
    ]);
    placements.forEach((placement, index) => {
      assert.notDeepEqual(
        schemaResults[index],
        [],
        `${placement} visual_metadata must force governed_visual true`,
      );
      assert.notDeepEqual(
        schemaResults[index + placements.length],
        [],
        `${placement} null visual_metadata must not act omitted`,
      );
      assert.notDeepEqual(
        schemaResults[index + placements.length * 2],
        [],
        `${placement} null visual_metadata must reject when governed`,
      );
      assert.deepEqual(
        schemaResults[index + placements.length * 3],
        [],
        `${placement} governed visual metadata remains valid`,
      );
      assert.deepEqual(
        schemaResults[index + placements.length * 4],
        [],
        `${placement} omitted metadata remains nonvisual`,
      );
    });

    for (const candidate of falseFlagCandidates) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), candidate);
      const result = validateSource(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /governed_visual must be true for inferred visual items/u);
    }
    for (const candidate of nullFalseCandidates) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), candidate);
      const result = validateSource(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /governed_visual must be true for inferred visual items/u);
    }
    for (const candidate of nullGovernedCandidates) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), candidate);
      const result = validateSource(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /visual_metadata must be an object/u);
    }
    for (const candidate of governedCandidates) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), candidate);
      const result = validateSource(root);
      assert.equal(result.status, 0, result.stderr);
    }
    for (const candidate of omittedCandidates) {
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), candidate);
      const result = validateSource(root);
      assert.equal(result.status, 0, result.stderr);
    }
  });
});

test("Draft 2020-12 and Python share the full visual MIME matrix", () => {
  withFixture(({ item }) => {
    const candidates = [];
    const labels = [];
    for (const mediaType of VISUAL_MIME_VARIANTS) {
      const topLevel = structuredClone(item);
      topLevel.artifact_type = "correction";
      topLevel.governed_visual = false;
      const topRepresentation = topLevel.representations[0];
      topRepresentation.media_type = mediaType;
      topRepresentation.locator = {
        ...topRepresentation.locator,
        scheme: "content-addressed",
        uri: `sha256:${topRepresentation.integrity.value}`,
        retained_copy: null,
      };
      topRepresentation.size_bytes = null;
      delete topRepresentation.visual_metadata;
      candidates.push(topLevel);
      labels.push(`top-level ${mediaType}`);

      const memberLevel = structuredClone(item);
      const memberRepresentation = structuredClone(memberLevel.representations[0]);
      memberRepresentation.representation_id = "member-visual";
      memberRepresentation.media_type = mediaType;
      memberRepresentation.locator = {
        ...memberRepresentation.locator,
        scheme: "content-addressed",
        uri: `sha256:${memberRepresentation.integrity.value}`,
        retained_copy: null,
      };
      memberRepresentation.size_bytes = null;
      delete memberRepresentation.visual_metadata;
      memberLevel.members = [{
        member_id: "visual-member",
        title: "Visual member",
        artifact_type: "diagram",
        representations: [memberRepresentation],
      }];
      candidates.push(memberLevel);
      labels.push(`member ${mediaType}`);
    }
    const results = validateWithDraft202012(candidates);
    results.forEach((errors, index) => {
      assert.notDeepEqual(errors, [], labels[index]);
    });
  });

  for (const mediaType of VISUAL_MIME_VARIANTS) {
    for (const location of ["top-level", "member"]) {
      withFixture(({ root, item }) => {
        const representation = structuredClone(item.representations[0]);
        representation.representation_id = `${location}-unmarked-visual`;
        representation.media_type = mediaType;
        representation.locator = {
          ...representation.locator,
          scheme: "content-addressed",
          uri: `sha256:${representation.integrity.value}`,
          retained_copy: null,
        };
        representation.size_bytes = null;
        delete representation.visual_metadata;
        if (location === "top-level") {
          item.artifact_type = "correction";
          item.governed_visual = false;
          item.representations = [representation];
        } else {
          item.members = [{
            member_id: "visual-member",
            title: "Visual member",
            artifact_type: "diagram",
            representations: [representation],
          }];
        }
        writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
        const result = validateSource(root);
        assert.notEqual(result.status, 0, `${location} ${mediaType}`);
      });
    }
  }
});

test("all procedural layers route governed visuals to executable contracts", () => {
  for (const registration of [
    PROCEDURAL_GUIDANCE.registrationSkill,
    PROCEDURAL_GUIDANCE.registrationContract,
  ]) {
    assert.match(registration, /docsfab\.knowledge\.source-item\/v2/u);
    assert.match(registration, /visual_metadata/u);
    assert.match(registration, /legacy/u);
    assert.match(registration, /retained/u);
    assert.match(registration, /content-addressed/u);
    assert.match(registration, /source_thread\.py validate/u);
  }
  for (const synthesis of [
    PROCEDURAL_GUIDANCE.synthesisSkill,
    PROCEDURAL_GUIDANCE.synthesisContract,
  ]) {
    assert.match(synthesis, /required_source_representations/u);
    assert.match(synthesis, /accepted_decision_ids/u);
    assert.match(synthesis, /closure_manifest_source/u);
    assert.match(synthesis, /visual-closure-receipt/u);
    assert.match(synthesis, /flowchart/u);
    assert.match(synthesis, /scripts\/validate_visual_closure\.py/u);
  }
  for (const convergence of [
    PROCEDURAL_GUIDANCE.convergenceSkill,
    PROCEDURAL_GUIDANCE.convergenceContract,
  ]) {
    assert.match(convergence, /validate_visual_closure\.py/u);
    assert.match(convergence, /section 14/u);
    assert.match(convergence, /v0\.29 and later/u);
  }
});

test("v2 registration accepts exact retained current visuals", () => {
  withFixture(({ root, item }) => {
    assert.equal(validateSource(root).status, 0);
    const confirmationBytes = Buffer.from("The participant confirms the visual.\n");
    const confirmationDigest = digest(confirmationBytes);
    const confirmationRetained = `artifacts/sha256/${confirmationDigest.slice(0, 2)}/${confirmationDigest}`;
    mkdirSync(join(root, dirname(confirmationRetained)), { recursive: true });
    writeFileSync(join(root, confirmationRetained), confirmationBytes);
    const confirmation = structuredClone(item.representations[0]);
    confirmation.representation_id = "participant-confirmation";
    confirmation.role = "participant-confirmation";
    confirmation.media_type = "text/markdown";
    confirmation.original_filename = "confirmation.md";
    confirmation.size_bytes = confirmationBytes.length;
    confirmation.locator.uri = confirmationRetained;
    confirmation.locator.retained_copy = confirmationRetained;
    confirmation.integrity.value = confirmationDigest;
    delete confirmation.visual_metadata;
    item.representations.push(confirmation);
    writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
    assert.equal(validateSource(root).status, 0);

    item.representations.pop();
    const contentAddressed = structuredClone(item);
    const representation = contentAddressed.representations[0];
    representation.locator = {
      ...representation.locator,
      scheme: "content-addressed",
      uri: `sha256:${representation.integrity.value}`,
      retained_copy: null,
    };
    representation.size_bytes = null;
    writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), contentAddressed);
    assert.equal(validateSource(root).status, 0);
  });
});

test("every source-thread JSON layer rejects duplicate object keys", () => {
  const itemDuplicates = [
    ["schema_version", '  "schema_version": "docsfab.knowledge.source-item/v2",', "schema_version"],
    ["artifact_type", '  "artifact_type": "diagram",', "artifact_type"],
    ["representation", '      "representation_id": "source-diagram",', "representation_id"],
    ["locator", '        "scheme": "thread-artifact",', "scheme"],
    ["integrity", '        "algorithm": "sha256",', "algorithm"],
  ];
  for (const [name, needle, duplicateKey] of itemDuplicates) {
    withFixture(({ root, item }) => {
      const raw = `${JSON.stringify(item, null, 2)}\n`.replace(
        needle,
        `${needle}\n${needle}`,
      );
      writeFileSync(join(root, "items/ITEM-VISUAL-ONE.json"), raw);
      const result = validateSource(root);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, new RegExp(`duplicate JSON object key: ${duplicateKey}`, "u"));
    });
  }
  withFixture(({ root }) => {
    const path = join(root, "thread.json");
    const raw = readFileSync(path, "utf8").replace(
      '  "thread_id": "SRC-VISUAL",',
      '  "thread_id": "SRC-VISUAL",\n  "thread_id": "SRC-VISUAL",',
    );
    writeFileSync(path, raw);
    assert.match(validateSource(root).stderr, /duplicate JSON object key: thread_id/u);
  });
  withFixture(({ root }) => {
    const path = join(root, "events.jsonl");
    const raw = readFileSync(path, "utf8").replace(
      '"event_id":"EVT-THREAD"',
      '"event_id":"EVT-THREAD","event_id":"EVT-THREAD"',
    );
    writeFileSync(path, raw);
    assert.match(validateSource(root).stderr, /duplicate JSON object key: event_id/u);
  });
});

test("source-thread validator rejects unexpected keys at every closed schema layer", () => {
  const itemMutations = [
    ["item", (item) => { item.rogue = true; }],
    ["member", (item) => {
      item.members = [{
        member_id: "member-one",
        title: "Member",
        artifact_type: "diagram",
        representations: [structuredClone(item.representations[0])],
        rogue: true,
      }];
    }],
    ["representation", (item) => { item.representations[0].rogue = true; }],
    ["locator", (item) => { item.representations[0].locator.rogue = true; }],
    ["integrity", (item) => { item.representations[0].integrity.rogue = true; }],
    ["transform", (item) => {
      item.representations[0].transform = {
        tool: "fixture",
        version: "1",
        method: "capture",
        review_state: "verified",
        rogue: true,
      };
    }],
    ["governance", (item) => { item.governance.rogue = true; }],
    ["visual metadata", (item) => { item.representations[0].visual_metadata.rogue = true; }],
  ];
  for (const [name, mutate] of itemMutations) {
    withFixture(({ root, item }) => {
      mutate(item);
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
      const result = validateSource(root);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /unsupported keys: rogue/u, name);
    });
  }
  withFixture(({ root }) => {
    const path = join(root, "thread.json");
    const thread = JSON.parse(readFileSync(path, "utf8"));
    thread.rogue = true;
    writeJson(path, thread);
    assert.match(validateSource(root).stderr, /unsupported keys: rogue/u);
  });
  withFixture(({ root }) => {
    const path = join(root, "events.jsonl");
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    events[0].rogue = true;
    writeFileSync(path, `${events.map(JSON.stringify).join("\n")}\n`);
    assert.match(validateSource(root).stderr, /unsupported keys: rogue/u);
  });
});

test("v2 registration preserves derived and superseded or rejected state independently", () => {
  for (const lifecycle of ["superseded", "rejected"]) {
    withFixture(({ root, item, representation }) => {
      const derived = structuredClone(representation);
      derived.representation_id = `derived-${lifecycle}`;
      derived.role = "descriptive-derived-role";
      derived.visual_metadata = {
        artifact_kind: "diagram",
        provenance_role: "derived",
        lifecycle_disposition: lifecycle,
      };
      derived.derived_from = ["source-diagram"];
      derived.transform = {
        tool: "fixture",
        version: "1",
        method: "fixture derivation",
        review_state: lifecycle,
      };
      item.representations.push(derived);
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
      assert.equal(validateSource(root).status, 0);
    });
  }
});

test("v2 governed visuals reject mutable locators, null hashes, and conflated state", () => {
  const mutations = [
    ["mutable locator", (item) => {
      item.representations[0].locator = {
        scheme: "https",
        uri: "https://example.test/diagram",
        repository: null,
        commit: null,
        path: null,
        external_version: "looks-versioned",
        retained_copy: null,
      };
    }, "retained bytes or an exact content-addressed locator"],
    ["unverified Git locator", (item) => {
      item.representations[0].locator = {
        scheme: "git",
        uri: "git:fixture/repository@bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:diagram.mmd",
        repository: "fixture/repository",
        commit: "b".repeat(40),
        path: "diagram.mmd",
        external_version: null,
        retained_copy: null,
      };
    }, "retained bytes or an exact content-addressed locator"],
    ["wrong content-addressed digest", (item) => {
      item.representations[0].locator = {
        ...item.representations[0].locator,
        scheme: "content-addressed",
        uri: `sha256:${"0".repeat(64)}`,
        retained_copy: null,
      };
    }, "locator.uri must equal its exact SHA-256 integrity"],
    ["null checksum", (item) => {
      item.representations[0].integrity.value = null;
    }, "retained artifacts require a sha256 integrity value"],
    ["arbitrary provenance", (item) => {
      item.representations[0].visual_metadata.provenance_role = "original-ish";
    }, "provenance_role is unsupported"],
    ["arbitrary lifecycle", (item) => {
      item.representations[0].visual_metadata.lifecycle_disposition = "current-ish";
    }, "lifecycle_disposition is unsupported"],
    ["missing lifecycle", (item) => {
      delete item.representations[0].visual_metadata.lifecycle_disposition;
    }, "missing required keys: lifecycle_disposition"],
    ["missing visual metadata", (item) => {
      delete item.representations[0].visual_metadata;
    }, "inferred visual representations require visual_metadata"],
    ["hidden governed diagram", (item) => {
      item.governed_visual = false;
      delete item.representations[0].visual_metadata;
    }, "governed_visual must be true for inferred visual items"],
    ["second inferred visual without metadata", (item) => {
      const second = structuredClone(item.representations[0]);
      second.representation_id = "unmarked-second-visual";
      second.media_type = "Text/Vnd.Mermaid; charset=utf-8";
      delete second.visual_metadata;
      second.locator = {
        ...second.locator,
        scheme: "https",
        uri: "https://example.test/mutable-second-visual",
        retained_copy: null,
      };
      second.integrity.value = null;
      item.representations.push(second);
    }, "inferred visual representations require visual_metadata"],
    ["member inferred visual without metadata", (item) => {
      const second = structuredClone(item.representations[0]);
      second.representation_id = "unmarked-member-visual";
      second.media_type = "Text/Vnd.PlantUML; charset=utf-8";
      delete second.visual_metadata;
      second.locator = {
        ...second.locator,
        scheme: "https",
        uri: "https://example.test/mutable-member-visual",
        retained_copy: null,
      };
      second.integrity.value = null;
      item.members = [{
        member_id: "visual-member",
        title: "Visual member",
        artifact_type: "diagram",
        representations: [second],
      }];
    }, "inferred visual representations require visual_metadata"],
    ["false visual flag with parameterized Mermaid", (item) => {
      item.artifact_type = "correction";
      item.governed_visual = false;
      const representation = item.representations[0];
      representation.media_type = "Text/Vnd.Mermaid; charset=utf-8";
      representation.locator = {
        ...representation.locator,
        scheme: "content-addressed",
        uri: `sha256:${representation.integrity.value}`,
        retained_copy: null,
      };
      representation.size_bytes = null;
      delete representation.visual_metadata;
    }, "governed_visual must be true for inferred visual items"],
  ];
  for (const [name, mutate, expected] of mutations) {
    withFixture(({ root, item }) => {
      mutate(item);
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
      const result = validateSource(root);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, new RegExp(expected), name);
    });
  }
});

test("new v1 visual records cannot downgrade around v2 metadata", () => {
  withFixture(({ root, item }) => {
    item.schema_version = "docsfab.knowledge.source-item/v1";
    delete item.governed_visual;
    delete item.representations[0].visual_metadata;
    writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
    const result = validateSource(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /new or changed visual item/u);
  });
});

test("parameterized visual MIME essences cannot downgrade a new v1 record", () => {
  const mediaTypes = [
    "Text/Vnd.Mermaid; charset=utf-8",
    "IMAGE/SVG+XML; charset=utf-8",
    "Application/Vnd.Graphviz; version=1",
    "Text/Vnd.PlantUML; charset=utf-8",
  ];
  for (const mediaType of mediaTypes) {
    withFixture(({ root, item }) => {
      item.schema_version = "docsfab.knowledge.source-item/v1";
      item.artifact_type = "correction";
      delete item.governed_visual;
      const representation = item.representations[0];
      representation.media_type = mediaType;
      representation.locator = {
        ...representation.locator,
        scheme: "content-addressed",
        uri: `sha256:${representation.integrity.value}`,
        retained_copy: null,
      };
      representation.size_bytes = null;
      delete representation.visual_metadata;
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
      const result = validateSource(root);
      assert.notEqual(result.status, 0, mediaType);
      assert.match(result.stderr, /new or changed visual item/u, mediaType);
    });
  }
});

test("generic Markdown visual bodies cannot evade visual inference", () => {
  const bodies = [
    "# Correction\n\n~~~mermaid\nflowchart LR\n  A --> B\n~~~~\n",
    "# Correction\n\n````mermaid\nflowchart LR\n  A --> B\n`````\n",
    "# Correction\n\n> ```mermaid\n> flowchart LR\n>   A --> B\n> ```\n",
    "# Correction\n\n- Diagram\n\n  ~~~~mermaid\n  flowchart LR\n    A --> B\n  ~~~~\n",
    "# Correction\n\n<svg viewBox=\"0 0 10 10\"></svg>\n",
    "# Correction\n\n<svg\n viewBox=\"0 0 10 10\"></svg>\n",
    "# Correction\n\n@startuml\nA -> B\n@enduml\n",
    "# Correction\r\n\r\n@startuml\r\nA -> B\r\n@enduml\r\n",
    "# Correction\r\n\r\n> @startuml\r\n> A -> B\r\n> @enduml\r\n",
  ];
  for (const body of bodies) {
    withFixture(({ root, item }) => {
      const bytes = Buffer.from(body);
      const contentDigest = digest(bytes);
      const retained = `artifacts/sha256/${contentDigest.slice(0, 2)}/${contentDigest}`;
      mkdirSync(join(root, dirname(retained)), { recursive: true });
      writeFileSync(join(root, retained), bytes);
      item.schema_version = "docsfab.knowledge.source-item/v1";
      item.artifact_type = "correction";
      item.version.value = contentDigest;
      delete item.governed_visual;
      const representation = item.representations[0];
      representation.media_type = "text/markdown";
      representation.size_bytes = bytes.length;
      representation.locator.uri = retained;
      representation.locator.retained_copy = retained;
      representation.integrity.value = contentDigest;
      delete representation.visual_metadata;
      writeJson(join(root, "items/ITEM-VISUAL-ONE.json"), item);
      const result = validateSource(root);
      assert.notEqual(result.status, 0, body);
      assert.match(result.stderr, /new or changed visual item/u);
    });
  }
});

test("visual-fence inference scales linearly on unmatched opener attacks", () => {
  const script = `
import importlib.util, json, pathlib, time
path = pathlib.Path(${JSON.stringify(SOURCE_VALIDATOR)})
spec = importlib.util.spec_from_file_location("source_thread_scaling", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
times = []
for size in (1000, 2000, 4000):
    payload = ("\\x60\\x60\\x60mermaid\\n" * size).encode()
    start = time.perf_counter()
    for _ in range(20):
        assert module._contains_visual_fence(payload)
    times.append(time.perf_counter() - start)
print(json.dumps(times))
`;
  const result = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const times = JSON.parse(result.stdout);
  assert.ok(times[2] < 1, `4k fence scan took ${times[2]} seconds`);
  assert.ok(times[2] <= Math.max(times[0] * 8, 0.02), `nonlinear timings: ${times}`);
});

test("live-model skip covers only an absent model, never an incomplete one", () => {
  const scratch = mkdtempSync(join(tmpdir(), "docsfab-live-skip-"));
  try {
    assert.equal(
      liveModelSkip(scratch),
      "live repository model .docsfab/reference-model is absent from this tree",
    );
    mkdirSync(join(scratch, ".docsfab/reference-model"), { recursive: true });
    assert.equal(liveModelSkip(scratch), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a legacy v1 visual digest admits only its own bytes in its own thread and filename", () => {
  withFixture(({ root, item }) => {
    item.schema_version = "docsfab.knowledge.source-item/v1";
    delete item.governed_visual;
    delete item.representations[0].visual_metadata;
    const itemPath = join(root, "items/ITEM-VISUAL-ONE.json");
    writeJson(itemPath, item);
    const legacy = [digest(readFileSync(itemPath))];
    const accepted = validateWithLegacyDigests(root, legacy);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    const unlisted = validateWithLegacyDigests(root, []);
    assert.notEqual(unlisted.status, 0);
    assert.match(unlisted.stderr, /new or changed visual item/u);

    const threadPath = join(root, "thread.json");
    const thread = JSON.parse(readFileSync(threadPath, "utf8"));
    writeJson(threadPath, { ...thread, thread_id: "SRC-OTHER" });
    const otherThread = validateWithLegacyDigests(root, legacy);
    assert.notEqual(otherThread.status, 0);
    assert.match(otherThread.stderr, /belongs to SRC-VISUAL, expected SRC-OTHER/u);
    writeJson(threadPath, thread);

    renameSync(itemPath, join(root, "items/ITEM-VISUAL-TWO.json"));
    const otherName = validateWithLegacyDigests(root, legacy);
    assert.notEqual(otherName.status, 0);
    assert.match(otherName.stderr, /filename must match item_id ITEM-VISUAL-ONE/u);
  });
});

// The legacy v1 visual allowance names retained live items by digest, so no fixture can stand in.
test("checked legacy v1 visual paths and digests remain readable", { skip: liveModelSkip(REPOSITORY_ROOT) }, () => {
  const threadsRoot = join(REPOSITORY_ROOT, ".docsfab/reference-model/source-threads");
  const threadByItemDigest = new Map();
  for (const entry of readdirSync(threadsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const items = join(threadsRoot, entry.name, "items");
    for (const name of readdirSync(items)) {
      if (name.endsWith(".json")) {
        threadByItemDigest.set(digest(readFileSync(join(items, name))), join(threadsRoot, entry.name));
      }
    }
  }
  const legacy = legacyVisualDigests();
  assert.ok(legacy.length > 0);
  const legacyThreads = new Set();
  for (const value of legacy) {
    assert.ok(threadByItemDigest.has(value), `no retained live item has legacy digest ${value}`);
    legacyThreads.add(threadByItemDigest.get(value));
  }
  for (const thread of legacyThreads) {
    const result = validateSource(thread);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("named Product Reference Model visual-closure behavioral suite passes", () => {
  const result = spawnSync("python3", ["-m", "unittest", VISUAL_TEST], {
    cwd: KNOWLEDGE_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
