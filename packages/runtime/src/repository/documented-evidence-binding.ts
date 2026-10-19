// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Structural evidence for an explicitly documented code fact, never an incidental literal. */
export type DocumentedEvidenceBinding =
  | { readonly kind: "exported-constant"; readonly name: string }
  | { readonly kind: "cli-default"; readonly flag: string };

type Node = {
  type?: string;
  loc?: { start: { line: number }; end: { line: number } };
  start?: number;
  end?: number;
  [key: string]: unknown;
};
type Range = { readonly lineStart: number; readonly lineEnd: number };

export function runtimeExpression(value: unknown): Node | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = value as Node;
  return [
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSTypeAssertion",
    "TSNonNullExpression",
    "TSInstantiationExpression",
  ].includes(node.type ?? "")
    ? runtimeExpression(node.expression)
    : node;
}
function* nodes(value: unknown): Generator<Node> {
  if (typeof value !== "object" || value === null) return;
  const node = value as Node;
  if (node.type) yield node;
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue;
    if (Array.isArray(child)) for (const item of child) yield* nodes(item);
    else if (typeof child === "object" && child !== null) yield* nodes(child);
  }
}
function names(pattern: unknown): string[] {
  const node = runtimeExpression(pattern);
  if (!node) return [];
  if (node.type === "Identifier" && typeof node.name === "string") return [node.name];
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return [];
  if (node.type === "ObjectProperty") return names(node.value);
  if (node.type === "AssignmentPattern") return names(node.left);
  if (node.type === "RestElement") return names(node.argument);
  if (node.type === "TSParameterProperty") return names(node.parameter);
  if (node.type === "ObjectPattern") return (node.properties as unknown[]).flatMap(names);
  if (node.type === "ArrayPattern") return (node.elements as unknown[]).flatMap(names);
  if (node.type === "VariableDeclaration")
    return (node.declarations as Node[]).flatMap((declaration) => names(declaration.id));
  return [];
}
function writeTarget(node: Node): unknown {
  if (
    node.type === "AssignmentExpression" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  )
    return node.left;
  if (
    node.type === "UpdateExpression" ||
    (node.type === "UnaryExpression" && node.operator === "delete")
  )
    return node.argument;
  return undefined;
}
function hasMemberWriteTarget(value: unknown): boolean {
  const node = runtimeExpression(value);
  if (!node) return false;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return true;
  if (node.type === "ObjectProperty") return hasMemberWriteTarget(node.value);
  if (node.type === "AssignmentPattern") return hasMemberWriteTarget(node.left);
  if (node.type === "RestElement") return hasMemberWriteTarget(node.argument);
  if (node.type === "ObjectPattern")
    return (node.properties as unknown[]).some(hasMemberWriteTarget);
  if (node.type === "ArrayPattern") return (node.elements as unknown[]).some(hasMemberWriteTarget);
  return false;
}
function information(program: unknown) {
  const all = [...nodes(program)];
  const counts = new Map<string, number>();
  const writes = new Map<string, Node[]>();
  for (const node of all) {
    const bindings =
      node.type === "VariableDeclarator"
        ? names(node.id)
        : ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
              node.type ?? "",
            )
          ? [...names(node.id), ...((node.params as unknown[]) ?? []).flatMap(names)]
          : ["ClassDeclaration", "ClassExpression"].includes(node.type ?? "")
            ? names(node.id)
            : node.type === "CatchClause"
              ? names(node.param)
              : node.type?.startsWith("Import")
                ? names(node.local)
                : [];
    for (const name of bindings) counts.set(name, (counts.get(name) ?? 0) + 1);
    const assigned = names(writeTarget(node));
    for (const name of assigned) writes.set(name, [...(writes.get(name) ?? []), node]);
  }
  const declarations = new Map<
    string,
    { id: Node; init: Node | undefined; kind: unknown; exported: boolean }
  >();
  const root = runtimeExpression(program);
  for (const statement of (root?.body as Node[]) ?? []) {
    const exported = statement.type === "ExportNamedDeclaration" && statement.exportKind !== "type";
    const declaration = exported ? (statement.declaration as Node) : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.declare === true) continue;
    for (const variable of declaration.declarations as Node[]) {
      const id = variable.id as Node;
      if (id?.type === "Identifier" && typeof id.name === "string")
        declarations.set(id.name, {
          id,
          init: runtimeExpression(variable.init),
          kind: declaration.kind,
          exported,
        });
    }
  }
  return { all, counts, writes, declarations };
}
function range(node: Node | undefined): Range | undefined {
  return node?.loc ? { lineStart: node.loc.start.line, lineEnd: node.loc.end.line } : undefined;
}
function union(a: Range, b: Range): Range {
  return { lineStart: Math.min(a.lineStart, b.lineStart), lineEnd: Math.max(a.lineEnd, b.lineEnd) };
}
function literal(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (
    node.type === "StringLiteral" ||
    node.type === "NumericLiteral" ||
    node.type === "BooleanLiteral"
  )
    return String(node.value);
  if (node.type === "NullLiteral") return "null";
  const argument = runtimeExpression(node.argument);
  if (
    node.type === "UnaryExpression" &&
    ["+", "-"].includes(String(node.operator)) &&
    argument?.type === "NumericLiteral"
  )
    return String(node.operator === "-" ? -Number(argument.value) : Number(argument.value));
  if (node.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) {
    const quasi = (node.quasis as Node[])[0];
    const value = (quasi?.value as { cooked?: unknown } | undefined)?.cooked;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function documentedBindingValue(
  program: unknown,
  binding: DocumentedEvidenceBinding,
  value: string | null,
): Range | undefined {
  const info = information(program);
  if (
    info.all.some(
      (node) =>
        node.type === "CallExpression" &&
        (node.callee as Node)?.type === "Identifier" &&
        (node.callee as Node).name === "eval",
    )
  )
    return undefined;
  let name: string;
  let association: Range | undefined;
  let allowedWrites: Set<Node> | undefined;
  if (binding.kind === "exported-constant") name = binding.name;
  else {
    if (info.counts.has("process") || hasUnverifiedEvidenceEnvironment(program)) return undefined;
    const argv = new Set(
      [...info.declarations]
        .filter(([name, row]) => {
          if (row.kind !== "const" || info.counts.get(name) !== 1 || info.writes.has(name))
            return false;
          const init = row.init;
          const called =
            init?.type === "CallExpression" ? runtimeExpression(init.callee) : undefined;
          const member =
            called?.type === "MemberExpression" && (called.property as Node)?.name === "slice"
              ? runtimeExpression(called.object)
              : init;
          return (
            member?.type === "MemberExpression" &&
            member.computed !== true &&
            (member.object as Node)?.type === "Identifier" &&
            (member.object as Node).name === "process" &&
            (member.property as Node)?.name === "argv"
          );
        })
        .map(([name]) => name),
    );
    const matches: { name: string; write: Node; source: Range }[] = [];
    for (const node of info.all) {
      if (node.type !== "IfStatement") continue;
      const test = runtimeExpression(node.test);
      if (test?.type !== "BinaryExpression" || !["===", "=="].includes(String(test.operator)))
        continue;
      const left = runtimeExpression(test.left);
      const right = runtimeExpression(test.right);
      const member =
        left?.type === "StringLiteral" && left.value === binding.flag
          ? right
          : right?.type === "StringLiteral" && right.value === binding.flag
            ? left
            : undefined;
      if (
        member?.type !== "MemberExpression" ||
        member.computed !== true ||
        !argv.has(String((member.object as Node)?.name))
      )
        continue;
      const consequent = node.consequent as Node;
      const statements =
        consequent.type === "BlockStatement" ? (consequent.body as Node[]) : [consequent];
      for (const statement of statements) {
        const write =
          statement.type === "ExpressionStatement"
            ? runtimeExpression(statement.expression)
            : undefined;
        const target = write?.left as Node | undefined;
        const assigned = runtimeExpression(write?.right);
        if (
          write?.type === "AssignmentExpression" &&
          write.operator === "=" &&
          target?.type === "Identifier" &&
          assigned?.type === "MemberExpression" &&
          assigned.computed === true &&
          (assigned.object as Node)?.name === (member.object as Node)?.name &&
          node.loc
        )
          matches.push({ name: String(target.name), write, source: range(node)! });
      }
    }
    if (new Set(matches.map((match) => match.name)).size !== 1) return undefined;
    name = matches[0]!.name;
    allowedWrites = new Set(matches.map((match) => match.write));
    association = matches.reduce(
      (result, match) => union(result, match.source),
      matches[0]!.source,
    );
  }
  const declaration = info.declarations.get(name);
  if (!declaration || info.counts.get(name) !== 1) return undefined;
  if (
    binding.kind === "exported-constant" &&
    (declaration.kind !== "const" || !declaration.exported)
  )
    return undefined;
  if ((info.writes.get(name) ?? []).some((write) => !allowedWrites?.has(write))) return undefined;
  const observed = literal(declaration.init);
  const located = range(declaration.init);
  if (observed === undefined || observed !== value || !located) return undefined;
  return association ? union(located, association) : located;
}

/** A primitive can occupy a JSON property; undefined, functions, symbols and unknown mutable bindings cannot. */
export function serializedPrimitiveVerifier(
  program: unknown,
): (value: unknown) => Range | undefined {
  const info = information(program);
  const prove = (value: unknown, seen: ReadonlySet<string> = new Set()): Range | undefined => {
    const node = runtimeExpression(value);
    const located = range(node);
    if (!node || !located) return undefined;
    if (
      [
        "StringLiteral",
        "NumericLiteral",
        "BooleanLiteral",
        "NullLiteral",
        "TemplateLiteral",
      ].includes(node.type ?? "")
    )
      return located;
    if (
      node.type === "UnaryExpression" &&
      ["+", "-"].includes(String(node.operator)) &&
      runtimeExpression(node.argument)?.type === "NumericLiteral"
    )
      return located;
    if (
      node.type === "Identifier" &&
      typeof node.name === "string" &&
      node.name !== "undefined" &&
      !seen.has(node.name)
    ) {
      const declaration = info.declarations.get(node.name);
      if (
        !declaration ||
        declaration.kind !== "const" ||
        info.counts.get(node.name) !== 1 ||
        info.writes.has(node.name) ||
        declaration.init?.end === undefined ||
        node.start === undefined ||
        declaration.init.end >= node.start
      )
        return undefined;
      const inner = prove(declaration.init, new Set([...seen, node.name]));
      return inner ? union(located, inner) : undefined;
    }
    if (node.type === "ConditionalExpression") {
      const left = prove(node.consequent, seen);
      const right = prove(node.alternate, seen);
      return left && right ? union(located, union(left, right)) : undefined;
    }
    return undefined;
  };
  return prove;
}

/** Corroboration supports self-contained parsing and serialization, not unverified side effects. */
export function hasUnverifiedEvidenceEnvironment(program: unknown): boolean {
  const info = information(program);
  const named = (value: unknown, name: string): boolean => {
    const node = runtimeExpression(value);
    return node?.type === "Identifier" && node.name === name;
  };
  const member = (value: unknown, object: string, property: string): boolean => {
    const node = runtimeExpression(value);
    return (
      node?.type === "MemberExpression" &&
      node.computed !== true &&
      named(node.object, object) &&
      named(node.property, property)
    );
  };
  const argv = new Set(
    [...info.declarations]
      .filter(([name, declaration]) => {
        const init = declaration.init;
        const callee = runtimeExpression(init?.callee);
        return (
          declaration.kind === "const" &&
          info.counts.get(name) === 1 &&
          !info.writes.has(name) &&
          init?.type === "CallExpression" &&
          callee?.type === "MemberExpression" &&
          callee.computed !== true &&
          named(callee.property, "slice") &&
          member(callee.object, "process", "argv")
        );
      })
      .map(([name]) => name),
  );
  if (["JSON", "console", "process"].some((name) => info.counts.has(name) || info.writes.has(name)))
    return true;
  return info.all.some((node) => {
    if (
      (node.type === "ImportDeclaration" && node.importKind !== "type") ||
      ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
        node.source !== null &&
        node.source !== undefined &&
        node.exportKind !== "type") ||
      node.type === "ImportExpression" ||
      node.type === "NewExpression"
    )
      return true;
    if (hasMemberWriteTarget(writeTarget(node))) return true;
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return false;
    const callee = runtimeExpression(node.callee);
    if (
      node.type !== "CallExpression" ||
      callee?.type !== "MemberExpression" ||
      callee.computed === true
    )
      return true;
    if (
      member(callee, "JSON", "stringify") ||
      ["log", "error", "warn", "info"].some((name) => member(callee, "console", name)) ||
      member(callee, "process", "exit") ||
      (named(callee.property, "slice") && member(callee.object, "process", "argv"))
    )
      return false;
    const object = runtimeExpression(callee.object);
    return !(
      named(callee.property, "includes") &&
      (object?.type === "ArrayExpression" ||
        object?.type === "StringLiteral" ||
        (object?.type === "Identifier" && argv.has(String(object.name))))
    );
  });
}
