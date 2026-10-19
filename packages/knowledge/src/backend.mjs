// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { nextEntityId } from "./model.mjs";

function nextTurnId(state) {
  const count = Object.values(state.interviews).reduce(
    (total, interview) => total + interview.turns.length,
    0,
  );
  return `TURN-${String(count + 1).padStart(3, "0")}`;
}

function requireCommandEnvelope(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Command envelope must be an object");
  }
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
    throw new Error("Command expectedVersion must be a non-negative integer");
  }
  if (typeof command.actor !== "string" || command.actor.trim() === "") {
    throw new Error("Command actor is required");
  }
  if (!command.input || typeof command.input !== "object" || Array.isArray(command.input)) {
    throw new Error("Command input must be an object");
  }
  return command;
}

export class KnowledgeBackend {
  constructor(store) {
    this.store = store;
  }

  getState() {
    return this.store.getState();
  }

  getEvents() {
    return this.store.getEvents();
  }

  health() {
    return this.store.health();
  }

  dispatch(name, commandEnvelope) {
    const command = requireCommandEnvelope(commandEnvelope);
    const handler = this.#handlers()[name];
    if (!handler) {
      throw new Error(`Unknown command: ${String(name)}`);
    }
    return handler(command);
  }

  #emit(command, buildSpecification) {
    return this.store.execute(
      command.expectedVersion,
      command.actor,
      (state, store) => buildSpecification(state, command.input, store),
    );
  }

  #handlers() {
    return {
      "project.activate": (command) =>
        this.#emit(command, (state, input) => {
          const projectId = nextEntityId(state, "projects", "PRJ");
          return { type: "project.activated", projectId, data: input };
        }),
      "source.register": (command) =>
        this.#emit(command, (state, input) => ({
          type: "source.registered",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "sources", "SRC") },
        })),
      "participant.register": (command) =>
        this.#emit(command, (state, input) => ({
          type: "participant.registered",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "participants", "P") },
        })),
      "interview.start": (command) =>
        this.#emit(command, (state, input) => ({
          type: "interview.started",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "interviews", "INT") },
        })),
      "interview.record-turn": (command) =>
        this.#emit(command, (state, input) => ({
          type: "interview.turn-recorded",
          projectId: input.projectId,
          data: { ...input, id: nextTurnId(state) },
        })),
      "claim.propose": (command) =>
        this.#emit(command, (state, input) => ({
          type: "claim.proposed",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "claims", "CL") },
        })),
      "claim.update-status": (command) =>
        this.#emit(command, (_state, input) => ({
          type: "claim.status-updated",
          projectId: input.projectId,
          data: input,
        })),
      "model.create-version": (command) =>
        this.#emit(command, (state, input) => ({
          type: "model.version-created",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "modelVersions", "MODEL") },
        })),
      "model.approve-version": (command) =>
        this.#emit(command, (_state, input) => ({
          type: "model.version-approved",
          projectId: input.projectId,
          data: input,
        })),
      "docs.create-plan": (command) =>
        this.#emit(command, (state, input) => ({
          type: "docs.plan-created",
          projectId: input.projectId,
          data: {
            ...input,
            id: nextEntityId(state, "documentationPlans", "PLAN"),
          },
        })),
      "artifact.register": (command) =>
        this.#emit(command, async (state, input, store) => {
          const id = nextEntityId(state, "artifacts", "ART");
          const stored = await store.writeArtifact(
            input.projectId,
            id,
            input.extension ?? "md",
            input.content,
          );
          return {
            type: "artifact.registered",
            projectId: input.projectId,
            data: {
              id,
              title: input.title,
              kind: input.kind,
              state: input.state,
              ...stored,
            },
          };
        }),
      "workflow.create": (command) =>
        this.#emit(command, (state, input) => ({
          type: "workflow.created",
          projectId: input.projectId,
          data: { ...input, id: nextEntityId(state, "workflows", "WF") },
        })),
      "workflow.transition-step": (command) =>
        this.#emit(command, (_state, input) => ({
          type: "workflow.step-transitioned",
          projectId: input.projectId,
          data: input,
        })),
      "task.queue": (command) =>
        this.#emit(command, (state, input) => ({
          type: "task.queued",
          projectId: input.projectId,
          data: {
            id: nextEntityId(state, "tasks", "TASK"),
            workflowId: input.workflowId,
            stepId: input.stepId,
            workPacket: { ...input.workPacket, inputVersion: state.version },
          },
        })),
      "task.claim": (command) => this.#taskTransition(command, "task.claimed"),
      "task.complete": (command) => this.#taskTransition(command, "task.completed"),
      "task.needs-input": (command) =>
        this.#taskTransition(command, "task.needs-input"),
      "task.block": (command) => this.#taskTransition(command, "task.blocked"),
      "task.fail": (command) => this.#taskTransition(command, "task.failed"),
      "task.requeue": (command) => this.#taskTransition(command, "task.requeued"),
    };
  }

  #taskTransition(command, type) {
    return this.#emit(command, (_state, input) => ({
      type,
      projectId: input.projectId,
      data: input,
    }));
  }
}

