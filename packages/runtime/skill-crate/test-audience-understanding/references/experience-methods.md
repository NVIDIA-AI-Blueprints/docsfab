# Audience Experience Methods

| Dimension | Prefer | Useful measures | Do not overclaim |
| --- | --- | --- | --- |
| Findability | Realistic search, navigation, and retrieval tasks | Success rate; time to find; zero-result rate; precision / recall where labeled | Pageviews are not findability |
| Orientation | Tree tests and path tasks from realistic entry points | Wrong-turn rate; dead-end rate; successful next-step selection | A visible breadcrumb does not prove orientation |
| Task effectiveness | End-to-end execution with expected-result verification | Correct safe completion; critical failure rate | Completion claims without verification are weak evidence |
| Efficiency | Measure successful journeys only | Time to first success; steps; context switches; tool calls; tokens; cost | Faster failure is not efficiency |
| Prevention and recovery | Inject representative errors and observe diagnosis, repair, and verification | Prevention rate; recovery success; recovery time | Troubleshooting-page presence is not recovery evidence |
| Workflow continuity | Observe handoffs across actual surfaces | Handoff completion; lost-context count; manual transfer count | More integrations do not guarantee continuity |
| Contextualization | Test authorized substitutions and preservation of the general rule | Substitution accuracy; context mismatch; privacy violations | Personalization can conceal or leak information |
| Interaction and responsiveness | Test interactive state, feedback, latency, and response contracts | Latency; state inconsistency; feedback completion; response-contract failures | Fast responses can still be wrong or unusable |
| Presentation and experiential coherence | Test render, layout, semantic hierarchy, performance, and supported modalities | Render failures; responsive failures; semantic presentation findings | Visual polish cannot compensate for failure |
| Confidence and satisfaction | Compare perceived confidence with verified outcomes | Satisfaction; calibration error; return intent | High confidence can accompany wrong results |

Use the same task corpus for a baseline comparison only when product,
documentation, environment, audience, and scoring conditions are comparable.
Preserve raw outcomes and confidence intervals when sample sizes support them.
