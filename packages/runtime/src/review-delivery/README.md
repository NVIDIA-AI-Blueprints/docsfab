# Review feedback preparation

`prepareReviewFeedback(input, policy)` applies an explicit `pr-review`,
`editorial-coaching`, or `audit` scenario to the existing retained review
inventory and placement planner. Installed callers can use
`prepareRetainedReviewFeedback` from `public.ts` with a saved run ID and state
directory. Both paths return the same preparation shape.

Every retained finding receives one `post`, `group`, `defer`, or `dismiss`
disposition with a reason. The row carries its original finding and placement
manifest entry, including retained result identity, evidence, qualifications,
and planned action ID. Rule status defaults to `unknown`; callers can identify
a mandatory rule or optional polish only by binding that classification to the
finding's retained source ID and locator. A dismissal also needs matching
retained evidence. Unsupported provider placement becomes an explicit deferral.

Preparation is read-only. A planned action is an intent, and
`publicationConfirmed` remains `false`. The delivery receipt and readback path
establish whether any action was actually posted. Suggestion compilation and
publication authority stay with their existing capabilities.
