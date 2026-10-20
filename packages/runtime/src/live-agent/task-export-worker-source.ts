// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fixed, cwd-anchored worker for publishing one live-agent task export. */
export const LIVE_AGENT_TASK_EXPORT_WORKER = String.raw`
// DOCSFAB_TASK_EXPORT_WRITER_WORKER_V1
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";

const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const readInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const fail = code => { process.exitCode = code; };
const rootMatches = (stat, root) => stat.isDirectory() &&
  stat.uid === root.uid && (stat.mode & 0o7777) === root.mode &&
  stat.dev === root.dev && stat.ino === root.ino;
const privateDirectory = (stat, uid) => stat.isDirectory() && !stat.isSymbolicLink() &&
  stat.uid === uid && (stat.mode & 0o7777) === 0o700;
const privateFile = (stat, uid, links = 1) => stat.isFile() && !stat.isSymbolicLink() &&
  stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === links;
const ownedTemporary = (stat, uid) => privateFile(stat, uid, 1) || privateFile(stat, uid, 2);
const safeNames = input => typeof input.stage === "string" &&
  /^\.task-export-[a-f0-9-]{36}$/u.test(input.stage) &&
  typeof input.temporary === "string" &&
  /^\.export-[a-f0-9-]{36}\.tmp$/u.test(input.temporary) &&
  typeof input.destination === "string" && /^[a-f0-9]{64}(?:\.json|\.activity\.jsonl)$/u.test(input.destination);

let input;
let rootFd;
let stageFd;
let temporaryFd;
let stageIdentity;
let temporaryIdentity;
let temporaryCreated = false;
let published = false;
let unsafeIdentity = false;
let inStage = false;
let stageRemoved = false;
try {
  input = await readInput();
  if (!input || typeof input !== "object" || !input.root || !safeNames(input) ||
      typeof input.payload !== "string" || typeof input.payloadSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.payloadSha256) ||
      !Number.isSafeInteger(input.root.dev) || !Number.isSafeInteger(input.root.ino) ||
      !Number.isSafeInteger(input.root.uid) || !Number.isSafeInteger(input.root.mode) ||
      input.root.mode !== 0o700 || typeof process.getuid !== "function" ||
      input.root.uid !== process.getuid()) fail(2);
  else {
    const root = statSync(".");
    if (!rootMatches(root, input.root)) fail(2);
    else {
      rootFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (!rootMatches(fstatSync(rootFd), input.root)) fail(2);
      else {
        const payload = Buffer.from(input.payload, "utf8");
        if (createHash("sha256").update(payload).digest("hex") !== input.payloadSha256) fail(2);
        else {
          mkdirSync(input.stage, { mode: 0o700 });
          const stage = lstatSync(input.stage);
          if (!privateDirectory(stage, input.root.uid)) fail(2);
          else {
            stageFd = openSync(input.stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            stageIdentity = fstatSync(stageFd);
            if (!privateDirectory(stageIdentity, input.root.uid) || !same(stage, stageIdentity)) fail(2);
            else {
              process.chdir(input.stage);
              inStage = true;
              if (!same(statSync("."), stageIdentity) || !rootMatches(statSync(".."), input.root)) fail(2);
              else {
                temporaryFd = openSync(input.temporary,
                  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
                  0o600);
                temporaryCreated = true;
                // Capture the exact exclusive-create inode before chmod or payload writes.
                temporaryIdentity = fstatSync(temporaryFd);
                if (!temporaryIdentity.isFile() || temporaryIdentity.uid !== input.root.uid || temporaryIdentity.nlink !== 1) fail(2);
                else {
                  fchmodSync(temporaryFd, 0o600);
                  const afterChmod = fstatSync(temporaryFd);
                  if (!privateFile(afterChmod, input.root.uid) || !same(afterChmod, temporaryIdentity)) fail(2);
                  else {
                    let offset = 0;
                    while (offset < payload.length) offset += writeSync(temporaryFd, payload, offset, payload.length - offset);
                    fsyncSync(temporaryFd);
                    const completed = fstatSync(temporaryFd);
                    if (!privateFile(completed, input.root.uid) || !same(completed, temporaryIdentity) ||
                        completed.size !== payload.length) fail(2);
                    else {
                      const namedTemporary = lstatSync(input.temporary);
                      if (!privateFile(namedTemporary, input.root.uid) || !same(namedTemporary, temporaryIdentity)) {
                        unsafeIdentity = true;
                        fail(2);
                      } else {
                        process.chdir("..");
                        inStage = false;
                        if (!rootMatches(statSync("."), input.root) || !rootMatches(fstatSync(rootFd), input.root)) fail(2);
                        else {
                          const namedStage = lstatSync(input.stage);
                          if (!privateDirectory(namedStage, input.root.uid) || !same(namedStage, stageIdentity)) {
                            unsafeIdentity = true;
                            fail(2);
                          } else {
                            try {
                              linkSync(input.stage + "/" + input.temporary, input.destination);
                              published = true;
                            } catch (error) {
                              if (error && error.code === "EEXIST") fail(3);
                              else throw error;
                            }
                            if (published) {
                              const destination = lstatSync(input.destination);
                              if (!privateFile(destination, input.root.uid, 2) || !same(destination, temporaryIdentity)) fail(2);
                              else {
                                fsyncSync(rootFd);
                                process.chdir(input.stage);
                                inStage = true;
                                if (!same(statSync("."), stageIdentity) || !rootMatches(statSync(".."), input.root)) {
                                  unsafeIdentity = true;
                                  fail(2);
                                } else {
                                  const currentTemporary = lstatSync(input.temporary);
                                  if (!privateFile(currentTemporary, input.root.uid, 2) || !same(currentTemporary, temporaryIdentity)) {
                                    unsafeIdentity = true;
                                    fail(2);
                                  } else {
                                    unlinkSync(input.temporary);
                                    temporaryCreated = false;
                                    fsyncSync(stageFd);
                                    process.chdir("..");
                                    inStage = false;
                                    const finalStage = lstatSync(input.stage);
                                    if (!rootMatches(statSync("."), input.root) ||
                                        !privateDirectory(finalStage, input.root.uid) || !same(finalStage, stageIdentity)) {
                                      unsafeIdentity = true;
                                      fail(2);
                                    } else {
                                      rmdirSync(input.stage);
                                      stageRemoved = true;
                                      fsyncSync(rootFd);
                                      fail(0);
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
} catch {
  if (process.exitCode === undefined || process.exitCode === 0) fail(2);
} finally {
  if (input && stageIdentity && !unsafeIdentity && !stageRemoved) {
    try {
      if (!inStage) {
        if (!rootMatches(statSync("."), input.root)) unsafeIdentity = true;
        else {
          const currentStage = lstatSync(input.stage);
          if (!privateDirectory(currentStage, input.root.uid) || !same(currentStage, stageIdentity)) unsafeIdentity = true;
          else { process.chdir(input.stage); inStage = true; }
        }
      }
      if (inStage && !same(statSync("."), stageIdentity)) unsafeIdentity = true;
      if (inStage && temporaryCreated && !unsafeIdentity && temporaryIdentity) {
        const currentTemporary = lstatSync(input.temporary);
        if (ownedTemporary(currentTemporary, input.root.uid) && same(currentTemporary, temporaryIdentity)) {
          unlinkSync(input.temporary);
          temporaryCreated = false;
        } else unsafeIdentity = true;
      }
      if (inStage && !unsafeIdentity) {
        process.chdir("..");
        inStage = false;
        const currentStage = lstatSync(input.stage);
        if (!rootMatches(statSync("."), input.root) || !privateDirectory(currentStage, input.root.uid) || !same(currentStage, stageIdentity)) unsafeIdentity = true;
        else { rmdirSync(input.stage); stageRemoved = true; fsyncSync(rootFd); }
      }
    } catch { unsafeIdentity = true; }
  }
  if (temporaryFd !== undefined) try { closeSync(temporaryFd); } catch {}
  if (stageFd !== undefined) try { closeSync(stageFd); } catch {}
  if (rootFd !== undefined) try { closeSync(rootFd); } catch {}
}
`;
