// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public, non-executing command metadata shared by help and inspection surfaces. */
export interface PublicCommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
}

/** One subcommand of a command group, as help lists it. */
export interface PublicSubcommandDefinition {
  readonly name: string;
  readonly description: string;
}

/**
 * A command whose first operand selects a subcommand. `bare: "help"` means the
 * command does nothing without one, so a bare invocation lists the
 * subcommands; `bare: "command"` leaves the bare invocation to the command
 * (for example, `sources` lists the selection).
 */
export interface PublicCommandGroup {
  readonly subcommands: readonly PublicSubcommandDefinition[];
  readonly bare: "help" | "command";
}

/**
 * Argv tokens that dispatch to a registry command without being registry names.
 * `help`, `--help`, and `-h` share one catalog entry; default `run` is the router fallthrough.
 */
export const PUBLIC_COMMAND_ALIASES = Object.freeze({
  "--help": "help",
  "-h": "help",
} as const);

const REGISTRY = [
  {
    name: "help",
    description: "Display the command catalog, or one command's usage.",
    readOnly: true,
  },
  { name: "list", description: "List installed workflows.", readOnly: true },
  {
    name: "init",
    description: "Initialize DocsFab for one selected input repository.",
    readOnly: false,
  },
  { name: "setup", description: "Configure the supported model profile.", readOnly: false },
  { name: "config", description: "Inspect effective configuration paths.", readOnly: true },
  {
    name: "doctor",
    description: "Check whether a selected use can proceed and show what to do next.",
    readOnly: true,
  },
  { name: "test", description: "Run the offline product smoke.", readOnly: true },
  { name: "plan", description: "Print a workflow plan.", readOnly: true },
  {
    name: "do",
    description: "Continue or start a documentation run from one quoted sentence.",
    readOnly: false,
  },
  { name: "run", description: "Run one governed workflow.", readOnly: false },
  { name: "publish", description: "Deliver a succeeded write run.", readOnly: false },
  {
    name: "ship",
    description: "Open a draft merge request for a succeeded write.",
    readOnly: false,
  },
  {
    name: "runs",
    description: "List, show, query, import, or delete saved run records.",
    // `list`, `show`, and `query` only read. `import` adds index rows; `delete`
    // removes one run's local stores only after an exact preview confirmation.
    readOnly: false,
  },
  {
    name: "why",
    description: "Diagnose why a saved run or batch failed, and what to do next.",
    readOnly: true,
  },
  { name: "reports", description: "Serve a saved review report.", readOnly: true },
  { name: "profile", description: "Inspect and manage model profiles.", readOnly: false },
  { name: "composition", description: "Inspect installed compositions.", readOnly: true },
  { name: "live-agent", description: "Start or resume the local Pi agent.", readOnly: false },
  {
    name: "sessions",
    description: "List or delete local live-agent sessions.",
    // `list` only reads; `delete` removes session files after a confirmed preview.
    readOnly: false,
  },
  {
    name: "sources",
    description: "Inspect and manage the sources one invocation binds.",
    // Most verbs only assemble a process-local selection and read, but `purge`
    // deletes owned local copies a custody store holds, a durable effect
    // outside this process.
    readOnly: false,
  },
  { name: "evaluate", description: "Evaluate run records against a fixture.", readOnly: true },
  {
    name: "auto",
    description: "Preview or execute one bounded autonomous cycle.",
    readOnly: false,
  },
  {
    name: "multi-unit-campaign",
    description: "Inspect or run a bounded private multi-unit campaign.",
    readOnly: false,
  },
  {
    name: "roadmap-issues",
    description: "Preflight or apply authenticated roadmap issue records.",
    readOnly: false,
  },
  {
    name: "ia",
    description: "Reserved information-architecture surface; parked until a catalog skill exists.",
    readOnly: true,
  },
  {
    name: "roadmap-plan",
    description:
      "Reserved authenticated roadmap-planning surface; parked until a catalog skill exists.",
    readOnly: true,
  },
] as const satisfies readonly PublicCommandDefinition[];

export type PublicCommandName = (typeof REGISTRY)[number]["name"];

export const PUBLIC_COMMAND_REGISTRY: readonly PublicCommandDefinition[] = Object.freeze(REGISTRY);

/** Commands whose first operand is a subcommand; help lists and routes these. */
export const PUBLIC_COMMAND_GROUPS: Readonly<
  Partial<Record<PublicCommandName, PublicCommandGroup>>
> = Object.freeze({
  config: {
    bare: "help",
    subcommands: [
      { name: "inspect", description: "Show effective configuration paths and their sources." },
    ],
  },
  profile: {
    bare: "help",
    subcommands: [
      { name: "inspect", description: "Inspect the configured model endpoint's profile." },
      { name: "seed", description: "Write the unsigned example model profile from a preset." },
      { name: "approve", description: "Sign, then apply, a reviewed model-profile proposal." },
      { name: "rollback", description: "Roll back an applied model-profile approval." },
      { name: "probe", description: "Probe one route and model; offline unless --live is passed." },
      { name: "draft", description: "Print a composition-shaped record for one route and model." },
    ],
  },
  composition: {
    bare: "help",
    subcommands: [
      { name: "list", description: "List installed compositions." },
      {
        name: "preflight",
        description: "Check a native harness CLI's version, authentication, and catalog.",
      },
      { name: "compare", description: "Compare sealed composition run records offline." },
      {
        name: "pilot-campaign",
        description: "Run the acknowledged live cross-harness development pilot.",
      },
    ],
  },
  runs: {
    bare: "help",
    subcommands: [
      { name: "list", description: "List saved run records, newest first." },
      { name: "show", description: "Show one saved run record and its next steps." },
      {
        name: "query",
        description: "Count run index rows across runs, filtered and grouped by field.",
      },
      { name: "import", description: "Add saved run records or a harness batch to the run index." },
      { name: "delete", description: "Preview and confirm removal of one run's local stores." },
    ],
  },
  sessions: {
    bare: "help",
    subcommands: [
      {
        name: "list",
        description: "List local live-agent sessions with age, size, and repository.",
      },
      {
        name: "delete",
        description:
          "Delete one, all, or older local live-agent sessions after a confirmed preview.",
      },
    ],
  },
  reports: {
    bare: "help",
    subcommands: [{ name: "serve", description: "Serve saved review report HTML." }],
  },
  "roadmap-issues": {
    bare: "help",
    subcommands: [
      { name: "preflight", description: "Check roadmap issue records without writing." },
      { name: "apply", description: "Apply roadmap issue records against confirmed digests." },
    ],
  },
  sources: {
    bare: "command",
    subcommands: [
      { name: "list", description: "List every selected source." },
      { name: "add", description: "Select one tracked path or merged merge request." },
      { name: "show", description: "Show one selected source with a bounded preview." },
      { name: "refresh", description: "Re-read selected tracked files and adopt new versions." },
      { name: "revalidate", description: "Re-check each selected source without adopting." },
      { name: "remove", description: "Deselect one source." },
      { name: "search", description: "Discover merged changes, when a searcher is wired." },
      { name: "purge", description: "Delete owned local copies after a confirmed preview." },
      { name: "review", description: "Select one pull or merge request as the review basis." },
    ],
  },
  ia: {
    bare: "command",
    subcommands: [
      { name: "input", description: "Provision, create, inspect, or validate IA inputs." },
      { name: "approve", description: "Approve one IA planning run." },
      { name: "cycle", description: "Run one IA analysis and planning cycle." },
    ],
  },
});

export function resolvePublicCommandName(name: string): string {
  return Object.hasOwn(PUBLIC_COMMAND_ALIASES, name)
    ? PUBLIC_COMMAND_ALIASES[name as keyof typeof PUBLIC_COMMAND_ALIASES]
    : name;
}

export function findPublicCommand(name: string): PublicCommandDefinition | undefined {
  const canonical = resolvePublicCommandName(name);
  return PUBLIC_COMMAND_REGISTRY.find((command) => command.name === canonical);
}

export function formatPublicCommandCatalog(): string {
  const width = Math.max(...PUBLIC_COMMAND_REGISTRY.map((command) => command.name.length));
  return PUBLIC_COMMAND_REGISTRY.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.description}`,
  ).join("\n");
}
