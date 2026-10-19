// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import http from "node:http";

import {
  documentationBriefMarkdown,
  sharedModelMarkdown,
  workflowRecordMarkdown,
} from "./exports.mjs";

const MAXIMUM_BODY_BYTES = 1024 * 1024;

function writeJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeMarkdown(response, body) {
  response.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAXIMUM_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAXIMUM_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Request body is not valid JSON", { cause: error });
  }
}

const NODE_ERRNO = /^[A-Z][A-Z0-9_]+$/u;

function errorStatus(error) {
  if (error.message.startsWith("Stale command:")) {
    return 409;
  }
  if (error.message.startsWith("Store is unhealthy")) {
    return 503;
  }
  if (error.message.startsWith("Unknown ")) {
    return 404;
  }
  if (error instanceof AggregateError) {
    return 500;
  }
  // Node errno codes such as ENOENT are infrastructure failures. Kebab
  // EvidenceSourceError.code values are rejected records, not HTTP 500.
  if (typeof error.code === "string" && NODE_ERRNO.test(error.code)) {
    return 500;
  }
  return 400;
}

function projectExport(state, pathname, searchParams) {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)\/exports\/([^/]+)$/);
  if (!match) {
    return null;
  }
  const [, projectId, kind] = match;
  if (kind === "shared-model") {
    return sharedModelMarkdown(state, projectId, searchParams.get("model"));
  }
  if (kind === "documentation-brief") {
    return documentationBriefMarkdown(state, projectId, searchParams.get("plan"));
  }
  throw new Error(`Unknown export: ${kind}`);
}

export function createKnowledgeServer({ backend, host = "127.0.0.1", port = 4310 }) {
  if (!backend) {
    throw new Error("Backend is required");
  }
  if (!new Set(["127.0.0.1", "::1"]).has(host)) {
    throw new Error("Knowledge backend may bind only to a loopback address");
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === "GET" && url.pathname === "/health") {
        const health = backend.health();
        writeJson(response, health.ok ? 200 : 503, health);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/state") {
        writeJson(response, 200, backend.getState());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        writeJson(response, 200, { events: backend.getEvents() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        const requestedState = url.searchParams.get("state");
        const tasks = Object.values(backend.getState().tasks)
          .filter((task) => !requestedState || task.state === requestedState)
          .sort((left, right) => left.id.localeCompare(right.id));
        writeJson(response, 200, { tasks });
        return;
      }
      if (request.method === "GET") {
        const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
        if (taskMatch) {
          const task = backend.getState().tasks[taskMatch[1]];
          if (!task) {
            throw new Error(`Unknown task: ${taskMatch[1]}`);
          }
          writeJson(response, 200, task);
          return;
        }
        const workflowMatch = url.pathname.match(/^\/v1\/workflows\/([^/]+)\/export$/);
        if (workflowMatch) {
          writeMarkdown(response, workflowRecordMarkdown(backend.getState(), workflowMatch[1]));
          return;
        }
        const exported = projectExport(backend.getState(), url.pathname, url.searchParams);
        if (exported !== null) {
          writeMarkdown(response, exported);
          return;
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/commands") {
        const body = await readJson(request);
        const result = await backend.dispatch(body.command, {
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          input: body.input,
        });
        writeJson(response, 201, result);
        return;
      }
      writeJson(response, 404, { error: "Route not found" });
    } catch (error) {
      writeJson(response, errorStatus(error), { error: error.message });
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: address.port };
    },
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

