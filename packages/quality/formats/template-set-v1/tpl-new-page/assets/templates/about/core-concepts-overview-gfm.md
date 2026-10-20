---
title: "Core Concepts Overview for [Product Name]"
description: "TODO: Add a one or two sentence description of the content of this page. This description is used in search results and previews, so make it informative and compelling."
template-source-version: "1.0.0"

---

# Core Concepts Overview for [Product Name]
<!-- @tpl:naming
Use title casing: Start with "Core Concepts Overview for" followed by [Product Name], such as Core Concepts Overview for NeMo Curator. Only page titles get denoted with a single hashtag (#).
-->

<!-- This is the Core Concepts Overview template. Use it to introduce and summarize core conceptual information. If you need to explain one concept in depth or concepts for one specific use case, use the Conceptual templates instead. Use this template when your product's core concepts fit on a single summary page. If a concept area needs its own subpages, use the `templates/conceptual/overview` template to route readers to them instead. -->

<!-- @tpl:example
To get started, refer to [Environments](https://docs.nvidia.com/nemo/gym/main/about/concepts/environments) and [Evaluation](https://docs.nvidia.com/nemo/gym/main/about/concepts/evaluation).
-->

<!-- @tpl:naming
Do not rename the file.
-->

<!-- @tpl:formatting
- Use tables to organize complex information.
- Use in-page tabs (`tab-set`) to present OS-specific and language-specific command variants within a step.
- Use code blocks for examples, API patterns, or configuration structures.
- Use Mermaid diagrams sparingly to illustrate component relationships, data flows, or process steps.
- Use callouts for important warnings, notes, and tips.
-->

<!-- Provide an introductory sentence to introduce the core concepts. Replace the following example with your own text. -->

To help you make informed decisions when building curation workflows, it is important that you first learn more about pipelines, stages, tasks, and execution models at a high level.

<!-- @tpl:formatting
Organize this page into sections and subsections. Keep the conceptual information for each section and subsection brief. Use tables and lists to help improve readability.
-->

## [Add a Heading for a Section Here]
<!-- @tpl:naming
Sections are required. Use title casing for the heading. For example: [Environments](https://docs.nvidia.com/nemo/gym/main/about/concepts/environments). Section headings are denoted with a double hashtag (##).
-->

<!-- Explain the core concept here. Replace the following example with your own text. -->

The term environment comes from reinforcement learning, where it describes the world an agent interacts with. The agent takes actions, the environment returns observations and a reward, and the cycle repeats. Historically, the word “Gym” refers to a collection of RL training environments, which inspired the naming of NeMo Gym.

The concept is the same today but the usage of environments has expanded beyond RL to include much more, such as model evaluation, agent evaluation, agent harness optimization, and synthetic data generation.

### [Add a Heading for a Subsection Here]
<!-- @tpl:naming
Subsections are optional. Use title casing for the heading. For example: [Anatomy of an Environment](https://docs.nvidia.com/nemo/gym/main/about/concepts/environments#anatomy-of-an-environment). Subsection headings are denoted with a triple hashtag (###).
-->

<!-- Use subsections to add related conceptual information here. Replace the following example with your own text. -->

An environment contains everything that is required for an agent to complete a task, which includes the following:

- **Dataset**: A collection of tasks (prompts for the agent to solve), along with metadata and privileged information necessary for scoring each task attempt. Each task defines a problem for the model, such as a coding issue to fix, a math problem to solve, and a tool-calling scenario to navigate.
- **Agent Harness**: The agent harness defines how the model interacts with the environment. Language models perform stateless inference. The harness is what turns a model into an agent in which it loops model calls, routes tool use, manages context, and decides when the task is done. Harnesses exist on a spectrum. A simple harness just loops model calls until the task is complete. Other harnesses like Claude Code or OpenClaw include tools, planning, memory, self-correction, skills, and more.
- **Verifier**: The verifier (sometimes referred to as a scorer or grader) scores a task attempt to calculate a reward, typically between 0 and 1. It defines what “good” means for this environment by scoring the model’s output against task-specific metadata, such as expected answers, test cases, unit tests, ground truth, and rubrics.
- **State**: The per-task state changes as the agent takes actions. Each task attempt starts from a clean state. This ensures attempts are independent and rewards are attributable to the agent’s actions on that task. Some environments have minimal state. Others have rich state that evolves across turns: file systems being modified, databases being updated, code repositories being patched, and game boards advancing. Runtimes and sandboxes host and run the environment. A runtime is the execution infrastructure. A sandbox is a runtime with isolated execution, such as a container for each episode that provides security boundaries when the agent can execute arbitrary code.

The model powering the agent is external to the environment. It generates a response (actions), which the environment processes. The environment updates its internal state, returns observations (tool results, error messages, and state changes), and produces a reward (a numerical score of how well the agent performed).

## [Add a Heading for a Subsection Here]
<!-- @tpl:naming
Sections are required. Use title casing for the heading. For example: [Evaluation](https://docs.nvidia.com/nemo/gym/main/about/concepts/evaluation). Section headings are denoted with a double hashtag (##).
-->

<!-- Explain the core concept here. Replace the following example with your own text. -->

Evaluation is the entire process of running an agent on tasks, scoring the results and measuring performance. It exists to guide improvements to the AI pipeline. Evaluation scores give information on what’s working, what’s not, and where to focus next.

Model performance has many different dimensions, and evaluation can be used to measure them: from the model’s accuracy, or any other similar definition of intelligence, to the quality of its tool calling, the confidence in operating in a specific environment, and even latency or token usage.

The process of evaluating entails different components. For example, to evaluate how accurate a coding agent is at fixing bugs, the following are needed:

- The model (in NeMo Gym, accessed by deploying the model server)
- The agent harness, which determines the tools it can access (agent server)
- A set of real bugs to test against (the dataset integrated into the environment in the resources server)
- A sandbox with the code repository for the agent to work in (state that exists in an environment in the resources server)
- A test suite to check if the fix actually works (verifier contained in the environment)

<!-- @tpl:formatting
Add more sections and subsections as needed.
-->
