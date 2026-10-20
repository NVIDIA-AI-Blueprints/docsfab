{/* GENERATED:operational-limits-defaults start - run `npm run generate:limits` from packages/runtime to refresh; do not hand-edit between these markers */}
| Catalog Setting | Default | Applies To |
| --- | --- | --- |
| `compositionExecution.maxCumulativeInputTokens` | 16,777,216 tokens | Cumulative input for one step attempt. |
| `compositionExecution.maxCumulativeOutputTokens` | 4,194,304 tokens | Cumulative output for one step attempt. |
| `compositionExecution.timeoutMs` | 3,600,000 ms (1 hour) | Host ceiling for one step attempt; a narrower installed composition still wins. |
| `compositionExecution.answerNowElapsedShareBasisPoints` | 4,000 basis points (40% of the attempt) | Reading share of one judgment step attempt before the host asks for the answer. |
| `compositionExecution.answerPlan.defaultTokens` | 11,800 tokens | Planned answer size for a step with no measured plan of its own; docsfab doctor --limits lists those steps. |
| `compositionExecution.answerNowDecodeTokensPerSecond` | 80 tokens per second | Decode rate the answer reserve assumes for a step's asked-for answer. |
| `compositionExecution.answerNowTurnLatencyMs` | 25,000 ms (25 seconds) | Latency the answer reserve charges each turn of a step's asked-for answer. |
| `execution.readLoopRepeatStreak` | 8 re-reads of one result | Re-reads of one unchanged result the host still re-sends in full before sending only a notice. |
| `execution.readLoopWithheldReads` | 8 notice-only re-reads | Notice-only re-reads, of one unchanged result or past the cross-result allowance, plus tool calls denied after a conclude-now ask, before the host ends the step attempt as no-progress. |
| `execution.readLoopUnchangedReReads` | 16 unchanged re-reads across results | Unchanged re-reads across all results, with no progress call between, the host still re-sends in full before it sends only a notice and starts spending the notice-only allowance. |
| `execution.readerSourceNominations` | 128 reader sources | Reader sources one update run admits, explicit `--reader-source` nominations plus change-scope paths. A continued run counts the original run's sources plus the files its InputAsk fills add. |
| `checks.commandTimeoutMs` | 600,000 ms (10 minutes) | Wall clock for one repository check command in the isolated check executor. A required check that reaches it is recorded as a limitation that names this setting, and the patch is still delivered. |
| `checks.outputRetainedBytes` | 16,384 bytes (16 KiB) | Output kept from one check command, half from the start and half from the end, with the omitted byte count between them. Output volume never stops a check. |
| `checks.nativeCommandMax` | 8 checks | Discovered documentation checks, such as a `lint:docs` script or a `docs-check` Make target, that one lint step runs. Repository-required checks always run and do not count. |
| `checks.credentialScanMaxEntries` | 1,000,000 entries | Directory entries the check executor's credential scan visits before any check runs. A larger checkout runs no check, and its required checks are recorded as limitations. |
| `retry.maxRetries` | 3 retries | Contract-correction retries for read-only inference failures, and retryable malformed replies of the `create-documentation` revision writer, such as model-correctable revision-accounting refusals. Throttled and transport-fault attempts use `retry.maxTransportRetries` instead, so a read-only step makes at most 1 + 3 + 6 = 10 attempts. |
| `retry.maxTimeoutRetries` | 1 retry | Retries of a step attempt that timed out, counted per step and held under the read-only retry count. |
| `retry.maxCutAnswerRetries` | 1 retry | Retries of a step whose structured answer was cut at the output limit, or completed by continuation and then refused. |
| `retry.maxNoProgressRetries` | 1 retry | Retries of a step attempt the host stopped for re-reading unchanged content or at its tool-call ceiling; the retry withdraws the tools at its first withheld re-read and asks for the answer. |
| `retry.maxTransportRetries` | 6 retries | Read-only step attempts that may end throttled or in a provider transport fault without spending `retry.maxRetries`. |
| `retry.transportMaxDelayMs` | 60,000 ms (1 minute) | Ceiling on one wait before a step's transport retry, a honoured `Retry-After` included. |
| `retry.transportMaxElapsedMs` | 3,600,000 ms (1 hour) | Wall clock one step may spend in transport-failed attempts and their waits. |
| `liveAgent.agentCausedRefusalRetries` | 1 resubmission | Live-agent workflow resubmissions, with your exact words, after a refusal the agent caused. `0` disables them. |
| `liveAgent.workflowContextMaxChars` | 16,384 characters | Non-authoritative context a live agent attaches to a workflow request. Longer context is cut with a coded marker. |
| `liveAgent.commandProcessStopMs` | 5,000 ms (5 seconds) | How long `live-agent` keeps stopping an approved host command's remaining background processes after the command ends. Past it, the command fails with a refusal that names the limit. |
| `liveAgent.commandOutputBytes` | 1,048,576 bytes (1 MiB) | Combined stdout and stderr an approved `live-agent` host command may write. Past it, DocsFab stops the command and returns no partial output. |
| `liveAgent.sessionMaxAgeDays` | 0 days (off) | Removes local `live-agent` sessions whose last write is older than this many days when `live-agent` starts. `0` turns removal off. |
| `providerAttempt.maxAttemptsPerTurn` | 8 requests | Physical provider requests one governed turn may spend, the first included. |
| `providerAttempt.maxBlankAttemptsPerTurn` | 3 requests | Physical requests one governed turn may spend on empty provider turns. |
| `providerAttempt.baseDelayMs` | 500 ms | First deterministic in-turn backoff; no jitter. |
| `providerAttempt.maxDelayMs` | 20,000 ms | Ceiling on one in-turn backoff, a honoured `Retry-After` included. |
| `providerAttempt.maxTotalDelayMs` | 60,000 ms | Summed in-turn backoff across every replay of one governed turn. |
| `providerAttempt.maxThrottledAttemptsPerTurn` | 24 requests | Physical provider requests one governed turn may spend while the provider answers HTTP 429. |
| `providerAttempt.maxThrottledTotalDelayMs` | 380,000 ms (6 minutes 20 seconds) | Summed in-turn backoff across the replays of one governed turn while the provider answers HTTP 429. |
| `providerAttempt.maxPhysicalRequestsPerStep` | 12,288 requests | Physical provider requests one step attempt may spend across all of its governed turns. |
| `hostInvoker.contextPreflightBudgetMs` | 300,000 ms (5 minutes) | Wait for one hosted structural compile; this does not terminate the index build. |
| `contentIndex.maxAssets` | 4,096 assets | Distinct linked assets one content index hashes; more are left out and named. |
| `contentIndex.maxAssetBytes` | 67,108,864 bytes (64 MiB) | Bytes of one linked asset the content index hashes; a larger asset is left out and named. |
| `contentIndex.maxTotalAssetBytes` | 1,073,741,824 bytes (1 GiB) | Combined bytes of the linked assets one content index hashes; assets past it are left out and named. |
| `contentIndex.maxSourceBytes` | 4,194,304 bytes (4 MiB) | Bytes of one page or navigation source a workspace content index parses; a larger page stops the index, naming it. |
| `technicalCorrection.proposalMaxBytes` | 262,144 bytes (256 KiB) | Canonical JSON of one technical-correction proposal. A review whose host-filled coverage alone exceeds it is refused before the first model call; narrow the scope. |
| `technicalCorrection.evidenceMaxBytes` | 524,288 bytes (512 KiB) | Canonical JSON of the complete technical-correction evidence, which carries the proposal and its source checks. |
| `technicalCorrection.derivedResultMaxBytes` | 786,432 bytes (768 KiB) | Canonical JSON of the verification result the host derives from a technical-correction proposal. |
| `recovery.serviceHistoryMaxHostJobs` | 65,536 jobs | Newest host-job rows in a logical recovery export; older rows remain in the physical image. |
| `slackRoutes.documentMaxBytes` | 1,048,576 bytes (1 MiB) | Installed sealed document read by a Slack route operation. |
| `slackRoutes.candidateMaxBytes` | 65,536 bytes (64 KiB) | Staged single-route amendment candidate. |
| `slackRoutes.replacementCandidateMaxBytes` | 524,288 bytes (512 KiB) | Staged replacement candidate containing the desired routes. |
| `slackRoutes.reasonMaxChars` | 1,024 characters | Operator reason retained in a Slack route receipt. |
| `slackRoutes.replacementMaxRoutesPerProject` | 256 routes | Desired routes for one project in a replacement candidate. |
| `context.localPacketInputShareBasisPoints` | 313 basis points (3.13% of the input window) | Input-window share of one local or change-scoped context packet. A larger packet is trimmed, and the step records the bound. |
| `context.corpusPacketInputShareBasisPoints` | 1,250 basis points (12.5% of the input window) | Input-window share of one corpus context packet. A larger packet is trimmed, and the step records the bound. |
| `context.packetFallbackInputTokens` | 65,536 tokens | Input window the context packet shares use when the run has no attested window, and the floor for a smaller one. |
| `context.packetMaxDepth` | 2 hops | Structural hops a context packet walks from its targets. |
| `repository.trackedWriteAdmissionMaxBytes` | 33,554,432 bytes (32 MiB) | Largest page a create or update run can write. A larger page is refused before the candidate seals. Override may only lower it. |
| `repository.evidenceGitOutputMaxBytes` | 83,886,080 bytes (80 MiB) | Largest patch of a run's changes the host captures and delivery reads back, enough for a full rewrite of one page at the page limit. |
| `githubReview.bodyMaxBytes` | 65,000 bytes | Internal byte budget for one GitHub pending-review body; native inline comments have separate transport bounds. |
{/* GENERATED:operational-limits-defaults end */}
