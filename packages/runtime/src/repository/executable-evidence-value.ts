// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Locate a runtime value without executing repository code or treating comments as implementation. */
import { parse } from "@babel/parser";
import {
  documentedBindingValue,
  hasUnverifiedEvidenceEnvironment,
  serializedPrimitiveVerifier,
  type DocumentedEvidenceBinding,
} from "./documented-evidence-binding.js";
export type { DocumentedEvidenceBinding } from "./documented-evidence-binding.js";

export function findExecutableEvidenceValue(input: {
  readonly source: string;
  /** Corroborating a documented scalar must not confuse a variable name with its value. */
  readonly identifierRole?: "object-key" | "json-key";
  readonly documentedBinding?: DocumentedEvidenceBinding;
  readonly side: { path: string; lineStart: number; lineEnd: number; value: string | null };
}): { readonly lineStart: number; readonly lineEnd: number } | undefined {
  if (
    !/\.[cm]?[jt]sx?$/iu.test(input.side.path) ||
    input.side.path.startsWith("-") ||
    input.side.path.includes("..") ||
    input.side.path.startsWith("/")
  )
    return undefined;
  let source = input.source;
  source = source.replace(/\r\n?/gu, "\n");
  try {
    const parsed = parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] });
    if (input.documentedBinding)
      return documentedBindingValue(parsed.program, input.documentedBinding, input.side.value);
    if (
      input.identifierRole === "json-key" &&
      (hasJsonBinding(parsed.program) || hasUnverifiedEvidenceEnvironment(parsed.program))
    )
      return undefined;
    if (input.identifierRole === "json-key") return uniqueJsonProperty(parsed.program, input.side);
    const pending: unknown[] = [parsed.program];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null) continue;
      const node = value as {
        type?: string;
        declare?: boolean;
        importKind?: string;
        exportKind?: string;
        loc?: { start: { line: number }; end: { line: number } };
        start?: number | null;
        end?: number | null;
        value?: unknown;
        name?: string;
        expression?: unknown;
        [key: string]: unknown;
      };
      if (
        typeof node.type !== "string" ||
        node.declare === true ||
        node.exportKind === "type" ||
        node.importKind === "type"
      )
        continue;
      // Traverse only the runtime-bearing parts of TypeScript containers.
      // Their names and type syntax cannot lend a neighboring value execution.
      if (node.type === "TSEnumDeclaration") {
        // Const-enum members can be inlined as values or retained as an enum;
        // the source flag does not make their alternative disappear.
        if (Array.isArray(node.members)) pending.push(...node.members);
        continue;
      }
      if (node.type === "TSEnumMember") {
        pending.push(node.initializer ?? (input.side.value === null ? node.id : undefined));
        continue;
      }
      if (node.type === "TSModuleDeclaration") {
        const name = node.id as { type?: string } | undefined;
        if (name?.type === "Identifier" && node.global !== true) pending.push(node.body);
        continue;
      }
      if (node.type === "TSModuleBlock") {
        if (Array.isArray(node.body)) pending.push(...node.body);
        continue;
      }
      if (node.type === "TSParameterProperty") {
        pending.push(node.parameter);
        continue;
      }
      if (node.type === "TSExportAssignment") {
        pending.push(node.expression);
        continue;
      }
      // These wrappers preserve a runtime expression, but their type side is erased.
      if (
        node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "TSTypeAssertion" ||
        node.type === "TSNonNullExpression" ||
        node.type === "TSInstantiationExpression"
      ) {
        pending.push(node.expression);
        continue;
      }
      if (
        node.type.startsWith("TS") ||
        node.type.startsWith("Comment") ||
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "Directive" ||
        node.type === "DirectiveLiteral"
      )
        continue;
      if (node.type === "TaggedTemplateExpression") {
        // A tag transforms its quasi; traverse its runtime inputs separately
        // from the text whose resulting value is controlled by the tag.
        pending.push(node.tag);
        const quasi = node.quasi as { expressions?: unknown[] } | undefined;
        if (Array.isArray(quasi?.expressions)) pending.push(...quasi.expressions);
        continue;
      }
      let unaryArgument = node.argument as
        | { type?: string; value?: unknown; expression?: unknown }
        | undefined;
      while (
        unaryArgument?.type === "TSAsExpression" ||
        unaryArgument?.type === "TSSatisfiesExpression" ||
        unaryArgument?.type === "TSTypeAssertion" ||
        unaryArgument?.type === "TSNonNullExpression" ||
        unaryArgument?.type === "TSInstantiationExpression"
      ) {
        unaryArgument = unaryArgument.expression as typeof unaryArgument;
      }
      // Unary plus preserves a numeric literal's value, including its established spelling.
      const positiveUnaryValue =
        node.type === "UnaryExpression" &&
        node.operator === "+" &&
        unaryArgument?.type === "NumericLiteral" &&
        typeof unaryArgument.value === "number"
          ? String(unaryArgument.value)
          : undefined;
      const templateValue =
        node.type === "TemplateLiteral" &&
        Array.isArray(node.expressions) &&
        node.expressions.length === 0 &&
        Array.isArray(node.quasis) &&
        node.quasis.length === 1
          ? (node.quasis[0] as { value?: { cooked?: unknown } } | undefined)?.value?.cooked
          : undefined;
      const objectKey =
        node.type === "ObjectProperty" && node.computed !== true
          ? (node.key as
              | {
                  type?: string;
                  name?: string;
                  loc?: { start: { line: number }; end: { line: number } };
                }
              | undefined)
          : undefined;
      if (
        input.identifierRole === "object-key" &&
        objectKey?.type === "Identifier" &&
        objectKey.name === input.side.value &&
        objectKey.loc &&
        objectKey.loc.start.line >= input.side.lineStart &&
        objectKey.loc.end.line <= input.side.lineEnd
      )
        return { lineStart: objectKey.loc.start.line, lineEnd: objectKey.loc.end.line };
      if (
        node.loc &&
        node.loc.start.line >= input.side.lineStart &&
        node.loc.end.line <= input.side.lineEnd &&
        ((node.type === "Identifier" && input.identifierRole !== "object-key") ||
          node.type === "StringLiteral" ||
          node.type === "NumericLiteral" ||
          node.type === "BooleanLiteral" ||
          node.type === "BigIntLiteral" ||
          node.type === "NullLiteral" ||
          node.type === "UnaryExpression" ||
          typeof templateValue === "string") &&
        (input.side.value === null ||
          positiveUnaryValue === input.side.value ||
          (typeof templateValue === "string"
            ? templateValue
            : node.type === "Identifier"
              ? node.name
              : node.type === "NullLiteral"
                ? "null"
                : node.type === "UnaryExpression" && node.start != null && node.end != null
                  ? source.slice(node.start, node.end)
                  : String(node.value)) === input.side.value)
      )
        return { lineStart: node.loc.start.line, lineEnd: node.loc.end.line };
      // A unary operator belongs to the value; its operand cannot stand in for the whole.
      if (node.type === "UnaryExpression") continue;
      for (const [key, child] of Object.entries(node)) {
        if (
          key === "loc" ||
          key === "extra" ||
          key === "source" ||
          key === "leadingComments" ||
          key === "innerComments" ||
          key === "trailingComments"
        )
          continue;
        if (Array.isArray(child)) pending.push(...child);
        else if (typeof child === "object" && child !== null) pending.push(child);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A local/imported JSON binding cannot corroborate the built-in serializer. */
function hasJsonBinding(program: unknown): boolean {
  const pending: unknown[] = [program];
  const bindsJson = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(bindsJson);
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    if (row.type === "Identifier") return row.name === "JSON";
    if (row.type === "ObjectProperty") return bindsJson(row.value);
    if (row.type === "AssignmentPattern") return bindsJson(row.left);
    if (row.type === "RestElement") return bindsJson(row.argument);
    if (row.type === "ObjectPattern") return bindsJson(row.properties);
    if (row.type === "ArrayPattern") return bindsJson(row.elements);
    if (row.type === "TSParameterProperty") return bindsJson(row.parameter);
    return false;
  };
  const containsJson = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    if (row.type === "Identifier" && row.name === "JSON") return true;
    return Object.entries(row).some(
      ([key, child]) =>
        key !== "loc" &&
        key !== "extra" &&
        key !== "leadingComments" &&
        key !== "trailingComments" &&
        (Array.isArray(child) ? child.some(containsJson) : containsJson(child)),
    );
  };
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    if (
      (row.type === "AssignmentExpression" && containsJson(row.left)) ||
      (row.type === "UpdateExpression" && containsJson(row.argument))
    )
      return true;
    if ([row.id, row.params, row.param, row.local].some(bindsJson)) return true;
    for (const [key, child] of Object.entries(row)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      if (Array.isArray(child)) pending.push(...child);
      else if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  return false;
}

/** All serializer shapes in the verified file must agree; one matching call is insufficient. */
function uniqueJsonProperty(
  program: unknown,
  side: { lineStart: number; lineEnd: number; value: string | null },
): { lineStart: number; lineEnd: number } | undefined {
  type Node = { type?: string; [key: string]: unknown };
  type Key = Node & { loc?: { start: { line: number }; end: { line: number } } };
  const expression = (value: unknown): Node | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const node = value as Node;
    return [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "TSInstantiationExpression",
    ].includes(node.type ?? "")
      ? expression(node.expression)
      : node;
  };
  const pending: unknown[] = [program];
  const found: { value: string; lineStart: number; lineEnd: number }[] = [];
  const primitive = serializedPrimitiveVerifier(program);
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    const node = value as Node;
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = expression(node.callee);
      const object = expression(callee?.object);
      if (object?.type === "Identifier" && object.name === "JSON") {
        const method = callee?.property as Node | undefined;
        // A computed or optional call cannot establish which serializer ran.
        if (callee?.computed === true || node.type !== "CallExpression") return undefined;
        if (method?.type === "Identifier" && method.name === "stringify") {
          const args = node.arguments as unknown[];
          const argument = args.length === 1 ? expression(args[0]) : undefined;
          const properties =
            argument?.type === "ObjectExpression" ? (argument.properties as unknown[]) : undefined;
          const property = properties?.length === 1 ? (properties[0] as Node) : undefined;
          const key = property?.key as Key | undefined;
          const name =
            key?.type === "Identifier"
              ? key.name
              : key?.type === "StringLiteral"
                ? key.value
                : undefined;
          if (
            property?.type !== "ObjectProperty" ||
            property.computed === true ||
            typeof name !== "string" ||
            name === "toJSON" ||
            name === "__proto__" ||
            !key?.loc
          )
            return undefined;
          const proof = primitive(property.value);
          if (!proof) return undefined;
          found.push({
            value: name,
            lineStart: Math.min(key.loc.start.line, proof.lineStart),
            lineEnd: Math.max(key.loc.end.line, proof.lineEnd),
          });
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "loc" || key.endsWith("Comments")) continue;
      if (Array.isArray(child)) pending.push(...child);
      else if (typeof child === "object" && child !== null) pending.push(child);
    }
  }
  if (new Set(found.map((entry) => entry.value)).size !== 1) return undefined;
  return found.find(
    (entry) =>
      entry.value === side.value &&
      entry.lineStart >= side.lineStart &&
      entry.lineEnd <= side.lineEnd,
  );
}
