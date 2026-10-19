// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Plan/page admission keeps file reads and write-scope decisions together. */
import { RstRegionError } from "../../rst-authoring/contracts.js";
import type { HarnessStepResult, RunRequest } from "../../execution/contracts.js";
import type { StepRunRecord } from "../../records/contracts.js";
import type { WorkflowDefinition, WorkflowStep } from "../../workflow-contracts/contracts.js";
import type { SourceRunCapabilityV1 } from "../../inputs/source-resolver.js";
import type { KnowledgeResumeReceiptV1 } from "../../canon/from-knowledge-snapshot.js";
import { compareText, type WorkflowRunnerOptions } from "../runner-ports.js";
import {
  admitCreateTargets,
  AMBIGUOUS_CREATE_TARGETS_CODE,
  ambiguousCreateTargetsQuestion,
  attachNavigationCompanions,
  convertCreatePlanPageToUpdate,
  CREATE_CONVERSION_REASON,
  createSourceAwareDocumentationPlanBinding,
  CreateTargetExistsError,
  documentationPlanAddressedPaths,
  documentationPlanWritePaths,
  OmittedFirstPassTargetError,
  PlanWriteScopeError,
  validateDocumentationPlanBinding,
} from "../plan-binding.js";
import {
  documentationPlanCompanions,
  intersectWriteCeilings,
  LOCAL_DOCUMENTATION_WRITE_ROOTS,
  observeDocumentationRoots,
  observeRestructureNavigationFiles,
  preservedIndexPaths,
  readIndexLinkBases,
} from "../plan-companions.js";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { SourceCitationPageReadError } from "../../inputs/source-evidence-artifacts.js";
import { requiresOperatorNaming } from "../../repository/agent-instruction-files.js";
import { operatorNamedPaths } from "../../repository/operator-named-paths.js";
import { hasErrnoCode } from "../../shared/primitives.js";
import { resolveTemplateSet, type TemplateSetCapability } from "../../templates/load.js";
import {
  pageTemplateGuidance,
  readWorkspacePage,
  type PageTemplateGuidanceInput,
  type PageTemplateGuidanceV1,
} from "../../templates/page-guidance.js";
import type { AuthoringCandidateLifecycleV1 } from "../authoring-runtime.js";
import {
  documentationPlanModeForWorkflow,
  type AdmittedDocumentationPlanBinding,
  type PlanWriteRefusal,
} from "../plan-binding.js";
import { isRestructureNavigationWrite } from "../plan-companions.js";
import type { PlanWriteGuidanceV1 } from "../plan-write-guidance.js";
import type {
  DocumentationPlanWriteScope,
  FirstPassDocumentationTargetControl,
} from "../runner-ports.js";

/**
 * The text of each planned page in the workspace, `null` for one that is absent
 * or that the write confinement cannot write: a path through a symbolic link,
 * or an entry that is not a regular file. Such a page holds nothing the step
 * wrote, so it adds no claim. Any other read failure is the coded
 * `SourceCitationPageReadError`.
 */
export async function readPlannedPageTexts(
  workspacePath: string,
  paths: readonly string[],
  stepId: string,
): Promise<Map<string, string | null>> {
  const texts = new Map<string, string | null>();
  for (const path of paths) {
    try {
      texts.set(path, await readPlannedPageText(workspacePath, path));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      throw new SourceCitationPageReadError({
        stepId,
        path,
        errorCode: typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "unknown",
      });
    }
  }
  return texts;
}

async function readPlannedPageText(workspacePath: string, path: string): Promise<string | null> {
  const segments = path.split("/");
  let current = workspacePath;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return null;
      if (index === segments.length - 1 && !metadata.isFile()) return null;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) return null;
      throw error;
    }
  }
  const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Which of `paths` the run's revision holds in any form, read through the lifecycle's collision oracle. */
export function plannedTargetExistence(
  lifecycle: Pick<AuthoringCandidateLifecycleV1, "plannedTargetCollisions">,
): (paths: readonly string[]) => Promise<readonly string[]> {
  return async (paths) =>
    (await lifecycle.plannedTargetCollisions({ writePaths: paths })).map(
      (collision) => collision.path,
    );
}

/**
 * The write scope of a run bound to named pages without write roots: those
 * pages alone, and an agent instruction file or hidden path among them only
 * when the run's request text names it.
 */
function namedPagesWriteScope(
  targetPaths: readonly string[],
  instruction: string | undefined,
): DocumentationPlanWriteScope {
  const named = operatorNamedPaths({ texts: instruction === undefined ? [] : [instruction] });
  return {
    roots: targetPaths,
    rule: (path) =>
      !targetPaths.includes(path)
        ? "outside-roots"
        : requiresOperatorNaming(path) && !named.names(path)
          ? "not-named"
          : undefined,
  };
}

/**
 * The write scope plan admission checks: a local run's, or a run bound to
 * named pages without one, those pages. A run with neither, a hosted run,
 * keeps its own authority.
 */
export function effectivePlanWriteScope(
  planWriteScope: DocumentationPlanWriteScope | undefined,
  targetControl: FirstPassDocumentationTargetControl | undefined,
  instruction: string | undefined,
): DocumentationPlanWriteScope | undefined {
  return (
    planWriteScope ??
    (targetControl ? namedPagesWriteScope(targetControl.targetPaths, instruction) : undefined)
  );
}

/**
 * What the planner is told it may write under `roots`. A restructure's
 * navigation files are stated only where plan admission admits them.
 */
export function planWriteGuidanceFor(
  roots: readonly string[],
  navigationFiles: readonly string[],
  boundTargets: readonly string[],
): PlanWriteGuidanceV1 {
  return {
    ...(boundTargets.length > 0 ? { boundTargets } : {}),
    directoryRoots: roots.filter((root) => root.endsWith("/")),
    fileRoots: roots.filter((root) => !root.endsWith("/")),
    navigationFiles: navigationFiles.filter((path) =>
      isRestructureNavigationWrite(path, roots, navigationFiles),
    ),
  };
}

/**
 * Template guidance for an authoring planner or writer step, or `undefined`
 * when the step takes none, the run has no template set, or it names no page.
 * A page the plan creates maps by its path; any other page also by its
 * current workspace bytes, so its own `template:` frontmatter key decides.
 */
export async function pageTemplateGuidanceForStep(input: {
  readonly templateSet: TemplateSetCapability | undefined;
  readonly workflowName: string;
  readonly skill: string;
  readonly workspacePath: string;
  readonly planBinding: AdmittedDocumentationPlanBinding | undefined;
  readonly plannerTargets: readonly string[];
}): Promise<PageTemplateGuidanceV1 | undefined> {
  if (!input.templateSet || !documentationPlanModeForWorkflow(input.workflowName)) return undefined;
  const pages: Array<{ readonly path: string; readonly create: boolean }> =
    input.skill === "plan-documentation"
      ? input.plannerTargets.map((path) => ({ path, create: false }))
      : input.skill === "write-documentation" && input.planBinding
        ? input.planBinding.pages
            .filter((page) => page.disposition !== "retain" && page.disposition !== "out-of-scope")
            .map((page) => ({ path: page.path, create: page.disposition === "create" }))
        : [];
  if (pages.length === 0) return undefined;
  const bundle = resolveTemplateSet(input.templateSet);
  const inputs: PageTemplateGuidanceInput[] = [];
  for (const page of pages) {
    // A new or absent page maps by its path. A page that exists but the host
    // refused to read keeps the refusal, so its unknown `template:` key is
    // never replaced by a path-based guess.
    const read = page.create ? undefined : await readWorkspacePage(input.workspacePath, page.path);
    inputs.push(read ?? { path: page.path });
  }
  return pageTemplateGuidance({ bundle, pages: inputs });
}

/**
 * Each path `scope` refuses, with why, in the order given. A restructure
 * passes every supported navigation path present in the base workspace,
 * which it may write inside the roots though it is no page.
 */
export function refusedPlanWrites(
  paths: readonly string[],
  scope: DocumentationPlanWriteScope,
  navigationFiles: readonly string[] = [],
): { readonly path: string; readonly refusal: PlanWriteRefusal }[] {
  return paths.flatMap((path) => {
    if (isRestructureNavigationWrite(path, scope.roots, navigationFiles)) return [];
    const refusal = navigationFiles.includes(path)
      ? navigationWriteRefusal(path, scope)
      : scope.rule(path);
    return refusal === undefined ? [] : [{ path, refusal }];
  });
}

/**
 * Why a restructure may not write the repository's navigation file `path`, or
 * undefined inside the roots. Outside them, Fern's, under `fern/`, is one a
 * root on its directory admits. MkDocs' sits at the repository root, which no
 * root covers, so the documentation write rule refuses it as no page.
 */
function navigationWriteRefusal(
  path: string,
  scope: DocumentationPlanWriteScope,
): PlanWriteRefusal | undefined {
  if (isRestructureNavigationWrite(path, scope.roots, [path])) return undefined;
  return path.includes("/") ? "navigation-outside-roots" : scope.rule(path);
}

/** Validate and retain the planner's result before any writer can use it. */
export async function settlePlanResult(input: {
  readonly result: HarnessStepResult;
  readonly workflow: WorkflowDefinition;
  readonly step: WorkflowStep;
  readonly stepRecord: StepRunRecord;
  readonly sourceCapability?: SourceRunCapabilityV1;
  readonly options: Pick<
    WorkflowRunnerOptions,
    | "planWriteScope"
    | "authoringCandidateLifecycle"
    | "hostedPlanNaming"
    | "documentationCompanionGrant"
  >;
  readonly v3: boolean;
  readonly validatedFirstPassTargetControl?: FirstPassDocumentationTargetControl;
  readonly workspacePath: string;
  readonly request: RunRequest;
  readonly knowledgeResumeReceipt?: KnowledgeResumeReceiptV1;
  readonly planBindings: Map<string, AdmittedDocumentationPlanBinding>;
  readonly retainNavigationIndexBases: (bases: ReadonlyMap<string, readonly string[]>) => void;
}): Promise<HarnessStepResult> {
  let { result } = input;
  const {
    workflow,
    step,
    stepRecord,
    sourceCapability,
    options,
    v3,
    validatedFirstPassTargetControl,
    request,
    knowledgeResumeReceipt,
    planBindings,
  } = input;
  const activeWorkspacePath = input.workspacePath;
  if (result.planBinding !== undefined) {
    const mode = documentationPlanModeForWorkflow(workflow.name);
    const structural = validateDocumentationPlanBinding(result.planBinding, {
      ...(mode ? { expectedMode: mode } : {}),
    });
    // A source-aware run records the plan as V2 bound to the whole admitted
    // source binding; a no-source run records V1.
    let validated: AdmittedDocumentationPlanBinding = sourceCapability
      ? createSourceAwareDocumentationPlanBinding(
          {
            mode: structural.mode,
            pages: structural.pages,
            sourceBindings: structural.sourceBindings,
          },
          sourceCapability.binding.bindingSha256,
          { ...(mode ? { expectedMode: mode } : {}) },
        )
      : structural;
    const planWritePaths = documentationPlanWritePaths(validated);
    const canonicalPlanWritePaths = [...planWritePaths].sort(compareText);
    const rstTarget = options.planWriteScope?.rstUpdatePaths?.[0];
    if (step.skill === "plan-documentation" && rstTarget) {
      if (
        options.planWriteScope?.rstUpdatePaths?.length !== 1 ||
        validated.mode !== "update" ||
        validated.pages.length !== 1 ||
        validated.pages[0]?.path !== rstTarget ||
        validated.pages[0]?.disposition !== "update" ||
        planWritePaths.length !== 1 ||
        planWritePaths[0] !== rstTarget
      ) {
        throw new RstRegionError(
          "RST patch-only plan requires exactly one update disposition for the bound existing page",
          "rst-edit-region-unsupported",
          rstTarget,
          { start: 0, end: 0 },
        );
      }
    }
    // CREATE onto a path the revision already holds is settled here, before
    // any write step spends a model turn: one existing page becomes an
    // UPDATE of it, several ask which one is meant, and any other collision is
    // refused. The write paths are the same in every case.
    let ambiguousCreateTargets: readonly string[] | undefined;
    // Only this admission converts; a step result that claims a conversion did not come from it.
    if (structural.createConvertedToUpdate !== undefined) {
      throw new Error("A planner result cannot carry a host CREATE-to-UPDATE conversion."); // hygiene: ok -- host integrity refusal; no model reply can produce the field.
    }
    // Only this admission adds companions. The sealed validator above admits
    // the field, so a step result carrying it would otherwise reach the writer.
    if (structural.navigationCompanions !== undefined) {
      throw new Error("A planner result cannot carry host navigation companions for the writer."); // hygiene: ok -- host integrity refusal; no model reply can produce the field.
    }
    const createPlanAdmission =
      step.skill === "plan-documentation" && validated.mode === "create" && v3;
    // Only CREATE plan admission reads a proposed UPDATE; the harness marks one only there.
    if (result.planProposedMode !== undefined && !createPlanAdmission) {
      throw new Error("Only a CREATE planner result can carry a proposed UPDATE."); // hygiene: ok -- host integrity refusal; the harness sets the field only for the CREATE planner.
    }
    if (createPlanAdmission) {
      const lifecycle = options.authoringCandidateLifecycle;
      if (!lifecycle) throw new Error("CREATE plan admission has no authoring lifecycle.");
      const collisions = await lifecycle.plannedTargetCollisions({ writePaths: planWritePaths });
      const proposedUpdate = result.planProposedMode === "update";
      // The harness admitted the proposal only after finding every page; one
      // that no longer exists is a host fault, not a refusal of the reply.
      if (
        proposedUpdate &&
        planWritePaths.some((path) => !collisions.some((collision) => collision.path === path))
      ) {
        throw new Error("A proposed UPDATE plan names a page the run's revision does not hold."); // hygiene: ok -- host integrity refusal; reply admission confirmed every page exists.
      }
      // A proposed UPDATE passes the same admission as a converted CREATE.
      const admission = admitCreateTargets(collisions);
      if (admission.kind === "refuse") {
        throw new CreateTargetExistsError(admission.collisions, "plan-admission");
      }
      if (admission.kind === "ambiguous") ambiguousCreateTargets = admission.paths;
      if (admission.kind === "convert")
        validated = convertCreatePlanPageToUpdate(
          validated,
          admission,
          proposedUpdate ? "planner-proposed-update" : CREATE_CONVERSION_REASON,
        );
    }
    // The pages the request named are the least a plan addresses, never all
    // it may write. A named page is addressed when the plan writes it or, in
    // an update, keeps it unchanged: naming a page to check does not oblige
    // the plan to write it.
    if (step.skill === "plan-documentation" && validatedFirstPassTargetControl) {
      const addressed = new Set(documentationPlanAddressedPaths(validated));
      const omitted = validatedFirstPassTargetControl.targetPaths.filter(
        (path) => !addressed.has(path),
      );
      if (omitted.length > 0) {
        throw new OmittedFirstPassTargetError(omitted, validated.mode);
      }
    }
    // Every page a plan writes, the named pages and any it adds, stays inside
    // the run's write scope: a local run's documentation write roots, whatever
    // the request reading, or, for a run bound to named pages without them,
    // those pages alone. A restructure may also write supported regular
    // navigation files present in the base workspace and inside the roots.
    // Reachability still observes the primary site configuration independently.
    const writeScope = effectivePlanWriteScope(
      options.planWriteScope,
      validatedFirstPassTargetControl,
      request.instruction,
    );
    const docsRoot =
      step.skill === "plan-documentation" && validated.mode === "restructure"
        ? await observeDocumentationRoots({ workspacePath: activeWorkspacePath, plan: validated })
        : undefined;
    if (step.skill === "plan-documentation" && writeScope) {
      const refused = refusedPlanWrites(
        canonicalPlanWritePaths,
        writeScope,
        docsRoot
          ? await observeRestructureNavigationFiles({ workspacePath: activeWorkspacePath })
          : [],
      );
      if (refused.length > 0) throw new PlanWriteScopeError(refused, writeScope.roots);
    }
    // A hosted run keeps its host authority, and writes an agent instruction
    // file or hidden path only when its operator's request names it.
    if (step.skill === "plan-documentation" && !writeScope && options.hostedPlanNaming) {
      const { roots, named } = options.hostedPlanNaming;
      const unnamed = canonicalPlanWritePaths.flatMap((path) =>
        requiresOperatorNaming(path) && !named.names(path)
          ? [{ path, refusal: "not-named" as const }]
          : [],
      );
      if (unnamed.length > 0) throw new PlanWriteScopeError(unnamed, roots);
    }
    if (
      step.skill === "plan-documentation" &&
      knowledgeResumeReceipt &&
      planWritePaths.some((path) => path !== knowledgeResumeReceipt.selectedTargetPath)
    ) {
      throw new Error("Documentation plan target does not match the knowledge resume receipt.");
    }
    // RESTRUCTURE plan admission adds the docs-root index beside the pages the
    // plan creates or moves, after the target checks above have compared the
    // planner's own pages; those checks never see a companion.
    if (docsRoot) {
      // A local run's companions keep to the docs/ and fern/ companion grant
      // only where it lies inside the run's write roots.
      const companionGrant = options.documentationCompanionGrant ?? LOCAL_DOCUMENTATION_WRITE_ROOTS;
      const produced = documentationPlanCompanions(
        validated,
        docsRoot,
        writeScope ? intersectWriteCeilings(companionGrant, writeScope.roots) : companionGrant,
      );
      validated = attachNavigationCompanions(validated, produced.companions);
      const pagePaths = new Set(validated.pages.map((page) => page.path));
      const producedPaths = new Set(produced.companions.map((companion) => companion.path));
      const attached = validated.navigationCompanions ?? [];
      if (
        attached.length !== producedPaths.size ||
        attached.some(
          (companion) => pagePaths.has(companion.path) || !producedPaths.has(companion.path),
        )
      ) {
        throw new Error(
          "Restructure plan admission attached a companion the producer did not derive.",
        ); // hygiene: ok -- host integrity refusal; only the producer above supplies companions.
      }
      // A companion meets the rule the planner's own pages met above.
      const companionsRefused = writeScope
        ? refusedPlanWrites(
            attached.map((companion) => companion.path),
            writeScope,
          )
        : [];
      if (writeScope && companionsRefused.length > 0) {
        throw new PlanWriteScopeError(companionsRefused, writeScope.roots);
      }
      if (produced.labels.length > 0) stepRecord.navigationLabels = [...produced.labels];
      input.retainNavigationIndexBases(
        await readIndexLinkBases({
          workspacePath: activeWorkspacePath,
          paths: preservedIndexPaths(validated, docsRoot),
        }),
      );
    }
    if (ambiguousCreateTargets) {
      // A host needs-input stop on the planner step, through the planner's own
      // diagnostic: no plan is sealed and no write step runs. The diagnostic
      // names the planner reply the host judged, like a planner's own stop.
      const responseSha256 = result.planResponseSha256;
      if (!responseSha256 || !/^[a-f0-9]{64}$/u.test(responseSha256)) {
        throw new Error("CREATE plan admission cannot name the planner reply it stopped on."); // hygiene: ok -- host integrity refusal; the harness digests every completed planner reply.
      }
      result = {
        ...result,
        outcome: "needs-input",
        summary: ambiguousCreateTargetsQuestion(ambiguousCreateTargets),
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: AMBIGUOUS_CREATE_TARGETS_CODE,
          responseSha256,
          responseShape: "json-object",
        },
      };
      delete result.planBinding;
    } else {
      planBindings.set(step.id, validated);
      stepRecord.planBinding = validated;
    }
  }
  return result;
}
