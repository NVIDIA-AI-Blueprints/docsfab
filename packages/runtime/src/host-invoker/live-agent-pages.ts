// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Page selection for a hosted live-agent question that named no page (#2400).
 *
 * The host seals such a question's scope with reason `documentation-index`
 * and the project's landing page as its one target. Each turn then indexes
 * the project's documentation set at its own revision (`isDocumentationSetPage`:
 * every tracked Markdown page except test data and benchmark inputs, each
 * distinct text once), ranks it against the question (and, at a lower
 * weight, the thread's previous question, so a vague follow-up such as "how
 * long does that take?" stays on topic), and approves the best matches. A
 * page the question names by its exact path is always approved first, inside
 * the set or not. The
 * approved pages' text joins the turn's evidence, the per-question byte
 * allowance shared fairly among them, and the harness lists them as the
 * approved paths, so the whole documentation set never enters the model's
 * context.
 *
 * The index is built per turn from the exact export the turn already
 * prepared. A hosted turn is one child process whose only writable directory
 * is its own attempt state, which the host removes, so nothing outlives the
 * turn to cache across turns. Indexing DocsFab's own repository took about a
 * second of compute on 2026-10-14, beside the export that already reads
 * every tracked file.
 *
 * Every other scope, including `target=<page>`, passes through unchanged.
 */
import { limit } from "../config/limits.js";
import { isContentIndexSourcePath } from "../content-ir/indexer.js";
import type { AgentHarness, HarnessStepInput } from "../execution/contracts.js";
import { assertWorkflowActive } from "../execution/cancellation.js";
import { assertDocsFabProjectConfig } from "../init/project-config.js";
import { LIVE_AGENT_CONTROL_CHARACTERS } from "../live-agent/session-state.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../repository/workspace/contracts.js";
import {
  listTrackedRepositoryFiles,
  readTrackedRepositoryFile,
} from "../repository/workspace/tracked-read.js";
import {
  DOCUMENTATION_INDEX_VERSION,
  buildDocumentationIndex,
  isDocumentationSetPage,
  pathsNamedIn,
  searchDocumentationIndex,
  type DocumentationIndexPage,
  type DocumentationIndexQuery,
} from "../search/documentation-index.js";
import {
  LIVE_AGENT_PAGE_SELECTION_KIND,
  type LiveAgentPageSelectionV1,
  type LiveAgentRetrievedPageV1,
  type LiveAgentSelectedPageV1,
} from "./live-agent-evidence.js";
import { buildLiveAgentTurnInstruction, type PreparedLiveAgentTurn } from "./live-agent-turn.js";
import { isHostRuntimeReviewScopePath, type HostRuntimeRequestV1 } from "./request.js";

/** The scope reason the host seals on a question with no `target=`. */
export const LIVE_AGENT_DOCUMENTATION_INDEX_REASON = "documentation-index" as const;

/**
 * How much a follow-up's previous question counts beside the new one, both
 * scored on one scale. The earlier topic then leads only when the new
 * question's best match scores under about 0.3 of the earlier question's
 * best. On DocsFab's own repository (2026-10-15), four of five vague
 * follow-ups, such as "who is allowed to do that?", scored 0.18 to 0.26 of
 * the earlier question's best, and every clear topic change, such as "what
 * license does this project ship under?", 0.41 or more. At 0.5 three clear
 * topic changes lost first place to the earlier topic; at 0.25 two vague
 * follow-ups left it.
 */
const PREVIOUS_QUESTION_WEIGHT = 0.3;

/**
 * The answer projector refuses an answer holding a URL, and the answer names
 * every approved page. Only a path with this token could read as one; the
 * host's scope rule also refuses it.
 */
const URL_SCHEME = /https?:/iu;

/**
 * The C0 and C1 controls the host refuses to post. A page path holding one,
 * such as NEL (U+0085), would split the evidence block's begin line and the
 * answer's page list; the scope rule refuses only C0. One unflagged copy, so
 * no `lastIndex` carries from one path to the next.
 */
const CONTROL_CHARACTER = new RegExp(LIVE_AGENT_CONTROL_CHARACTERS.source, "u");

export interface LiveAgentPageLimits {
  /** `liveAgent.askIndexPages`. */
  readonly pages: number;
  /** `liveAgent.askIndexPageTextBytes`. */
  readonly pageTextBytes: number;
  /** `liveAgent.askIndexTextBytes`. */
  readonly textBytes: number;
}

export function resolveLiveAgentPageLimits(): LiveAgentPageLimits {
  return Object.freeze({
    pages: limit("liveAgent.askIndexPages").value,
    pageTextBytes: limit("liveAgent.askIndexPageTextBytes").value,
    textBytes: limit("liveAgent.askIndexTextBytes").value,
  });
}

/**
 * Whether DocsFab may name a page and render it in a prompt and a Slack
 * answer: a path a review scope can carry, with no URL scheme and no control
 * character. A page that fails this is never approved, even when named.
 */
function isRenderablePagePath(path: string): boolean {
  return (
    isHostRuntimeReviewScopePath(path) && !URL_SCHEME.test(path) && !CONTROL_CHARACTER.test(path)
  );
}

/**
 * The turn with its approved pages chosen, its evidence holding their text,
 * and its instruction rebuilt; the same turn for every other scope.
 */
export async function selectLiveAgentTurnPages(
  turn: PreparedLiveAgentTurn,
  input: {
    readonly request: HostRuntimeRequestV1;
    readonly workspace: RepositoryWorkspace;
    readonly signal?: AbortSignal | undefined;
    readonly limits?: LiveAgentPageLimits;
  },
): Promise<PreparedLiveAgentTurn> {
  const scope = input.request.packet.reviewScope;
  if (scope?.reason !== LIVE_AGENT_DOCUMENTATION_INDEX_REASON) return turn;
  const limits = input.limits ?? resolveLiveAgentPageLimits();
  const files = await listTrackedRepositoryFiles(input.workspace);
  const tracked = files.filter((file) => file.path.endsWith(".md"));
  const preferredRoots = await declaredDocumentationRoots(input.workspace, files);
  const renderable = tracked.filter((file) => isRenderablePagePath(file.path));
  const named = pathsNamedIn(turn.input.text, new Set(renderable.map((file) => file.path)));
  const inSet = renderable.filter((file) => isDocumentationSetPage(file.path));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, string>();
  let unreadable = 0;
  for (const file of renderable) {
    if (!named.includes(file.path) && !isDocumentationSetPage(file.path)) continue;
    assertWorkflowActive(input.signal);
    let bytes: Buffer;
    try {
      bytes = await readTrackedRepositoryFile(input.workspace, file.path, file.byteLength);
    } catch (error) {
      // A changed or unreadable file is counted, not indexed. Any other error
      // is not a page problem.
      if (!(error instanceof RepositoryWorkspaceReadError)) throw error;
      if (isDocumentationSetPage(file.path)) unreadable += 1;
      continue;
    }
    try {
      texts.set(file.path, decoder.decode(bytes));
    } catch {
      // Not UTF-8 text.
      if (isDocumentationSetPage(file.path)) unreadable += 1;
    }
  }
  const setPages = inSet
    .filter((file) => texts.has(file.path))
    .map((file) => ({ path: file.path, text: texts.get(file.path)! }));
  const distinct = distinctPages(setPages);
  const index = buildDocumentationIndex(distinct);
  const previous = turn.priorState?.exchanges.at(-1)?.question;
  const query: DocumentationIndexQuery[] = [
    { text: turn.input.text, weight: 1 },
    ...(previous === undefined ? [] : [{ text: previous, weight: PREVIOUS_QUESTION_WEIGHT }]),
  ];
  // Every match, so a named page's own match is counted once.
  const ranked = searchDocumentationIndex(index, query, Math.max(index.paths.length, 1), {
    preferredRoots,
  }).hits;
  const namedPages = named.filter((path) => texts.has(path));
  const chosen: { path: string; reason: LiveAgentSelectedPageV1["reason"] }[] = [
    ...namedPages.map((path) => ({ path, reason: "named-in-question" as const })),
    ...ranked
      .filter((hit) => !namedPages.includes(hit.path))
      .map((hit) => ({ path: hit.path, reason: "index-match" as const })),
  ].slice(0, limits.pages);
  if (chosen.length === 0) {
    // The landing page the host sealed and the dispatcher proved tracked.
    for (const target of scope.targets.slice(0, limits.pages)) {
      chosen.push({ path: target.path, reason: "landing-page" });
    }
  }
  const matchedPageCount = new Set([...namedPages, ...ranked.map((hit) => hit.path)]).size;
  const pageTexts = chosen.map((page) => texts.get(page.path) ?? "");
  const grants = fairShares(
    pageTexts.map((text) => Math.min(Buffer.byteLength(text), limits.pageTextBytes)),
    limits.textBytes,
  );
  const selected: LiveAgentSelectedPageV1[] = [];
  const retrieved: LiveAgentRetrievedPageV1[] = [];
  for (const [offset, page] of chosen.entries()) {
    const text = pageTexts[offset]!;
    const included = leadingText(text, grants[offset]!);
    selected.push(
      Object.freeze({
        path: page.path,
        reason: page.reason,
        pageBytes: Buffer.byteLength(text),
        includedBytes: Buffer.byteLength(included),
      }),
    );
    retrieved.push(Object.freeze({ path: page.path, text: included }));
  }
  const selection: LiveAgentPageSelectionV1 = Object.freeze({
    schemaVersion: 1,
    kind: LIVE_AGENT_PAGE_SELECTION_KIND,
    revision: input.request.revision,
    indexVersion: DOCUMENTATION_INDEX_VERSION,
    trackedPageCount: tracked.length,
    indexedPageCount: distinct.length,
    excludedPageCount: renderable.length - inSet.length,
    duplicatePageCount: setPages.length - distinct.length,
    unindexedPageCount: tracked.length - renderable.length + unreadable,
    matchedPageCount,
    preferredRoots,
    limits: Object.freeze({ ...limits }),
    pages: Object.freeze(selected),
  });
  return Object.freeze({
    ...turn,
    instruction: buildLiveAgentTurnInstruction({
      question: turn.input.text,
      priorState: turn.priorState,
      capsuleEvidence: input.request.capsule.selectedEvidence,
      retrieval: { selection, pages: Object.freeze(retrieved) },
    }),
    approvedPaths: Object.freeze(selected.map((page) => page.path)),
    pageSelection: selection,
  });
}

/** Where a project declares its configuration, `documentationRoots` among it. */
const PROJECT_CONFIG_PATH = ".docsfab.json";

/**
 * The project's declared documentation roots: `documentationRoots` in its
 * tracked `.docsfab.json`, as DocsFab validates that file. They name the
 * project's curated documentation, so its pages rank ahead of equally relevant
 * planning or benchmark pages, as the repository's canonical pages
 * (`isCanonicalRepositoryPage`) always do. They do not bound the set, which
 * also holds README.md, the product reference model, runbooks, and package
 * documentation. None when the file is absent, unreadable, or invalid.
 */
async function declaredDocumentationRoots(
  workspace: RepositoryWorkspace,
  files: readonly { readonly path: string; readonly byteLength: number }[],
): Promise<readonly string[]> {
  const file = files.find((candidate) => candidate.path === PROJECT_CONFIG_PATH);
  if (!file) return Object.freeze([]);
  let bytes: Buffer;
  try {
    bytes = await readTrackedRepositoryFile(workspace, file.path, file.byteLength);
  } catch (error) {
    if (!(error instanceof RepositoryWorkspaceReadError)) throw error;
    return Object.freeze([]);
  }
  try {
    const config: unknown = JSON.parse(bytes.toString("utf8"));
    assertDocsFabProjectConfig(config);
    return Object.freeze([...(config.documentationRoots ?? [])]);
  } catch {
    // Not JSON, or not a configuration DocsFab accepts: no preference.
    return Object.freeze([]);
  }
}

/**
 * Split `budget` bytes among pages that ask for `demands` bytes, so that each
 * gets its whole demand or an equal share of what is left, whichever is
 * smaller. Smaller demands are met first, and the bytes they leave flow to the
 * larger ones, so every approved page gets at least an equal share of the
 * allowance or all of its text. Spending in rank order instead left the last
 * pages slivers of a few bytes, which tell the model nothing.
 */
export function fairShares(demands: readonly number[], budget: number): number[] {
  const order = demands
    .map((demand, index) => ({ demand, index }))
    .sort((left, right) => left.demand - right.demand || left.index - right.index);
  const grants = demands.map(() => 0);
  let remaining = Math.max(budget, 0);
  for (const [position, { demand, index }] of order.entries()) {
    const grant = Math.min(demand, Math.floor(remaining / (order.length - position)));
    grants[index] = grant;
    remaining -= grant;
  }
  return grants;
}

/**
 * Each distinct page text once, under its shortest path (ties by path). A
 * repository keeps byte-identical copies, such as generated staging copies of
 * a source page; indexing every copy would spend approvals on the same text.
 * The shortest path is usually the source the copy was made from.
 */
function distinctPages(pages: readonly DocumentationIndexPage[]): DocumentationIndexPage[] {
  const byText = new Map<string, DocumentationIndexPage>();
  for (const page of pages) {
    const kept = byText.get(page.text);
    if (
      !kept ||
      page.path.length < kept.path.length ||
      (page.path.length === kept.path.length && page.path < kept.path)
    ) {
      byText.set(page.text, page);
    }
  }
  return [...byText.values()];
}

/** User-perceived characters: a letter with its accents, an emoji sequence. */
const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * The longest prefix of `text` within `bytes` UTF-8 bytes that ends between
 * two user-perceived characters, so neither a character nor a letter's
 * combining accent is split. The cut does not step back to a line break or a
 * space: a product reference model is one 57 KB line of JSON whose spaces all
 * lie in its first 2 KB, so either rule would keep about 2 KB of a 16 KiB
 * share. The evidence block's end line says where the page was cut.
 */
function leadingText(text: string, bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= bytes) return text;
  let end = Math.max(bytes, 0);
  // Step back off UTF-8 continuation bytes, so no character is split.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  const prefix = encoded.subarray(0, end).toString("utf8");
  // Then back to the last whole grapheme. A line feed always ends a grapheme,
  // so the scan starts at the cut's own line and stops at the cut.
  const lineStart = prefix.lastIndexOf("\n") + 1;
  let boundary = lineStart;
  for (const { index } of GRAPHEMES.segment(text.slice(lineStart))) {
    if (lineStart + index > prefix.length) break;
    boundary = lineStart + index;
  }
  return text.slice(0, boundary);
}

/**
 * The page the structural context packet describes: the first approved page,
 * so the packet is about what the question asked. The landing page stays when
 * the content index does not read that page as a source, because a context
 * target it cannot find fails the step rather than degrading. It leaves out
 * `.docsfab/` (the product reference model), quality and benchmark corpora,
 * fixtures, and build and tool directories.
 */
export function liveAgentContextTargetPath(turn: PreparedLiveAgentTurn | null): string | null {
  const first = turn?.pageSelection?.pages[0]?.path;
  return first !== undefined && isContentIndexSourcePath(first) ? first : null;
}

/**
 * The harness renders the step's approved paths from the frozen scope, which
 * for an index-selected turn names only the landing page. Give it the pages
 * this turn approved instead. The run record keeps the frozen scope, which the
 * terminal checks against the request.
 */
export function scopeLiveAgentTurnHarness(
  harness: AgentHarness,
  turn: PreparedLiveAgentTurn | null,
): AgentHarness {
  if (!turn?.pageSelection) return harness;
  const approved = Object.freeze([...turn.approvedPaths]);
  const scoped = (step: HarnessStepInput): HarnessStepInput =>
    step.reviewScope
      ? {
          ...step,
          reviewScope: {
            ...step.reviewScope,
            targetPaths: approved,
            deferredPaths: [],
            anchorPaths: [],
          },
        }
      : step;
  return {
    ...(harness.inspectSkill
      ? { inspectSkill: (step: HarnessStepInput) => harness.inspectSkill!(scoped(step)) }
      : {}),
    ...(harness.qualityAnswerRecordRouteBindingSha256
      ? {
          qualityAnswerRecordRouteBindingSha256: () =>
            harness.qualityAnswerRecordRouteBindingSha256!(),
        }
      : {}),
    ...(harness.qualityAnswerRecordProviderId
      ? { qualityAnswerRecordProviderId: () => harness.qualityAnswerRecordProviderId!() }
      : {}),
    runStep: (step: HarnessStepInput) => harness.runStep(scoped(step)),
  };
}
