// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ConversionBlock,
  ConversionDocument,
  ConversionInline,
  ConversionNode,
  ConvertTarget,
  IncludeNode,
} from "../contracts.js";
import { resolveNodeRule } from "../resolver.js";
import { FERN_INTENT_EMITTERS, type FernEmitContext, type NodeFrontmatterKey } from "./emitters.js";
import { type TextPosition, yamlDoubleQuoted, yamlScalar } from "./escape.js";
import { checkFernMdx } from "./mdx-check.js";
import {
  FERN_EMIT_REFUSAL_NEXT_ACTIONS,
  type FernEmitNotice,
  type FernEmitRefusal,
  type FernEmitRefusalCode,
  type FernPageInput,
  type FernPageResult,
} from "./types.js";

const COMPONENT_BLOCK_START = /^<[A-Z][A-Za-z]*[\s/>]/u;
const COMPONENT_BLOCK_END = /<\/[A-Z][A-Za-z]*>$/u;

function isComponentBlock(block: string): boolean {
  return COMPONENT_BLOCK_START.test(block) && COMPONENT_BLOCK_END.test(block);
}

/**
 * Join emitted blocks with one blank line. Adjacent component elements (tabs
 * in a tab set, consecutive callouts) sit on consecutive lines instead.
 */
export function joinFernBlocks(parts: readonly string[]): string {
  let out = "";
  let previous: string | undefined;
  for (const raw of parts) {
    const part = raw.replace(/^\n+|\n+$/gu, "");
    if (part === "") continue;
    if (previous === undefined) out = part;
    else out += `${isComponentBlock(previous) && isComponentBlock(part) ? "\n" : "\n\n"}${part}`;
    previous = part;
  }
  return out;
}

type Decision = { kind: "convert"; intent: ConvertTarget } | { kind: "skip" };

/** An emitter called with the intent it was selected by. */
interface AnyEmitter {
  block?: (node: ConversionBlock, intent: ConvertTarget, context: FernEmitContext) => string;
  inline?: (
    node: ConversionInline,
    intent: ConvertTarget,
    context: FernEmitContext,
    position: TextPosition,
  ) => string;
}

/**
 * Emit one conversion IR document as Fern page text. Every node takes its
 * disposition from the rule index (and an answered unit for judged nodes);
 * anything the emitter cannot write is refused or recorded as a notice, and
 * the finished page must pass the independent MDX check. Reader defects in the
 * IR raise the resolver's `ConversionContractError`.
 */
export function emitFernPage(input: FernPageInput): FernPageResult {
  const refusals: FernEmitRefusal[] = [];
  const notices: FernEmitNotice[] = [];
  const { documentId } = input;
  const refusal = (
    code: FernEmitRefusalCode,
    message: string,
    node?: ConversionNode,
    construct?: string,
  ): void => {
    refusals.push({
      code,
      message,
      nextAction: FERN_EMIT_REFUSAL_NEXT_ACTIONS[code],
      ...(node === undefined ? {} : { nodeId: node.id }),
      ...(construct === undefined ? {} : { construct }),
    });
  };
  const root = input.ir.documents.find((document) => document.id === documentId);
  if (root === undefined) {
    refusal("fern-document-unknown", `The conversion IR has no document ${documentId}.`);
    return { status: "refused", documentId, refusals, notices };
  }

  for (const key of Object.keys(root.frontmatter).sort()) {
    notices.push({
      code: "frontmatter-key-not-emitted",
      nodeId: root.id,
      detail: `Source frontmatter key ${key} is not consumed by the page plan.`,
    });
  }

  const nodeFrontmatter = new Map<NodeFrontmatterKey, string>();
  const includeStack: string[] = [root.id];

  const decide = (node: ConversionNode): Decision => {
    const { construct, rule } = resolveNodeRule(input.rules, node);
    const { disposition } = rule;
    switch (disposition.disposition) {
      case "convert":
        return { kind: "convert", intent: disposition.convert };
      case "drop-with-notice":
        return { kind: "skip" };
      case "refuse":
        refusal(
          "fern-node-refused",
          `${construct} node ${node.id}: ${disposition.text}`,
          node,
          construct,
        );
        return { kind: "skip" };
      case "judge":
        break;
    }
    const unitId = `unit:node:${node.id}`;
    const answer = input.answers?.get(unitId);
    switch (answer?.answer) {
      case "keep-literal":
        return { kind: "convert", intent: { target: "literal-text", text: answer.text } };
      case "drop":
        notices.push({ code: "answer-drop", nodeId: node.id, detail: answer.reason });
        return { kind: "skip" };
      case "map-to-construct": {
        const mapped = input.rules.rules.get(answer.construct)?.disposition;
        const intent = mapped?.disposition === "convert" ? mapped.convert : undefined;
        if (intent !== undefined && (answer.parameters ?? intent).target === intent.target) {
          return { kind: "convert", intent: answer.parameters ?? intent };
        }
        break;
      }
      default:
        break;
    }
    refusal(
      "fern-node-unresolved",
      `${construct} node ${node.id} needs an answer for ${unitId}.`,
      node,
      construct,
    );
    return { kind: "skip" };
  };

  const emitterFor = (intent: ConvertTarget, node: ConversionNode): AnyEmitter | undefined => {
    if (Object.hasOwn(FERN_INTENT_EMITTERS, intent.target)) {
      return FERN_INTENT_EMITTERS[intent.target] as unknown as AnyEmitter;
    }
    refusal(
      "fern-intent-unknown",
      `Node ${node.id} converts to ${JSON.stringify(intent.target)}, which has no Fern emitter.`,
      node,
    );
    return undefined;
  };

  const contextFor = (document: ConversionDocument): FernEmitContext => {
    const context: FernEmitContext = {
      ir: input.ir,
      document,
      emitBlock(node) {
        const decision = decide(node);
        if (decision.kind === "skip") return "";
        const emitter = emitterFor(decision.intent, node);
        if (emitter === undefined) return "";
        if (emitter.block === undefined) {
          return context.refuse(
            "fern-intent-node-mismatch",
            node,
            `Intent ${decision.intent.target} has no block form for ${node.kind} node ${node.id}.`,
          );
        }
        return emitter.block(node, decision.intent, context);
      },
      emitBlocks(nodes) {
        return joinFernBlocks(nodes.map((node) => context.emitBlock(node)));
      },
      joinBlocks: joinFernBlocks,
      emitInlines(nodes, position) {
        let out = "";
        for (const node of nodes) {
          const lineStart = out === "" ? position.lineStart : out.endsWith("\n");
          const decision = decide(node);
          if (decision.kind === "skip") continue;
          const emitter = emitterFor(decision.intent, node);
          if (emitter === undefined) continue;
          if (emitter.inline === undefined) {
            context.refuse(
              "fern-intent-node-mismatch",
              node,
              `Intent ${decision.intent.target} has no inline form for ${node.kind} node ${node.id}.`,
            );
            continue;
          }
          out += emitter.inline(node, decision.intent, context, { lineStart, mode: position.mode });
        }
        return out;
      },
      refuse(code, node, message) {
        refusal(code, message, node);
        return "";
      },
      notice(code, node, detail) {
        notices.push({ code, nodeId: node.id, detail });
      },
      setFrontmatter(key, value, node) {
        if (nodeFrontmatter.has(key)) {
          notices.push({
            code: "frontmatter-key-not-emitted",
            nodeId: node.id,
            detail: `${key} is already set on this page.`,
          });
          return;
        }
        nodeFrontmatter.set(key, value);
      },
      readText(node, path) {
        const text = input.sources?.readText?.({
          documentId: document.id,
          sourcePath: document.sourcePath,
          nodeId: node.id,
          path,
        });
        if (text === undefined) {
          refusal("fern-source-missing", `Node ${node.id} needs the text of ${path}.`, node);
        }
        return text;
      },
      includeDocument(node: IncludeNode, path) {
        const included = input.sources?.document?.({
          documentId: document.id,
          sourcePath: document.sourcePath,
          nodeId: node.id,
          path,
        });
        if (included === undefined) {
          refusal(
            "fern-source-missing",
            `Include node ${node.id} needs the document for ${path}.`,
            node,
          );
          return undefined;
        }
        if (includeStack.includes(included.id)) {
          refusal(
            "fern-include-cycle",
            `Include node ${node.id} includes ${included.id}, which is already being emitted (${includeStack.join(" -> ")}).`,
            node,
          );
          return undefined;
        }
        includeStack.push(included.id);
        const text = contextFor(included).emitBlocks(included.children);
        includeStack.pop();
        return text;
      },
      substitution(name) {
        const planned = input.rules.substitutions.get(name)?.literal;
        if (planned !== undefined) return planned;
        const entry = input.ir.substitutions.find((candidate) => candidate.name === name);
        return entry?.value.kind === "literal" ? entry.value.text : undefined;
      },
    };
    return context;
  };

  const body = contextFor(root).emitBlocks(root.children);
  const plan = input.frontmatter ?? {};
  const frontmatter: string[] = [];
  if (plan.title !== undefined) frontmatter.push(`title: ${yamlDoubleQuoted(plan.title)}`);
  if (plan.slug !== undefined) frontmatter.push(`slug: ${yamlScalar(plan.slug)}`);
  for (const key of ["description", "keywords"] as const) {
    const value = nodeFrontmatter.get(key);
    if (value !== undefined) frontmatter.push(`${key}: ${yamlDoubleQuoted(value)}`);
  }
  if (plan.canonicalUrl !== undefined) {
    frontmatter.push(`canonical-url: ${yamlScalar(plan.canonicalUrl)}`);
  }
  const head = frontmatter.length === 0 ? "" : ["---", ...frontmatter, "---"].join("\n");
  const text = `${[head, body].filter((part) => part !== "").join("\n\n")}\n`;

  if (refusals.length === 0) {
    for (const issue of checkFernMdx(text)) {
      refusal("fern-mdx-unsafe", `Line ${issue.line}: ${issue.code}: ${issue.detail}`);
    }
  }
  return refusals.length === 0
    ? { status: "emitted", documentId, text, notices }
    : { status: "refused", documentId, refusals, notices };
}
