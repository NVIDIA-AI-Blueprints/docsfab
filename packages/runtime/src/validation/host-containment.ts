// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Host-owned containment admission shared by delivery and repository checks. */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repositoryWorkspaceExportLimits } from "../config/repository-discovery-limits.js";
import { formatLimitObservation, limit } from "../config/limits.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { acquireRepositoryWorkspaceLease } from "../repository/workspace/lease.js";
import {
  createValidationBackendAttestation,
  createValidationBackendRequest,
  decodeValidationBackendRequest,
  failValidationBackend,
  issueHostSelectedValidationBackend,
  requireValidationBackend,
  validationBackendPolicySha256,
  validationBackendResultSha256,
  validationScratchSha256,
  DOCSFAB_VALIDATION_BACKEND_POLICY_V1,
  type ValidationBackendAttestationV1,
  type ValidationBackendCapability,
  type ValidationBackendIdentity,
  type ValidationBackendRequestV1,
} from "../delivery/worktree/validation-backend.js";
import {
  DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT,
  DARWIN_DOCKER_DESKTOP_IMAGE,
  assertDarwinDockerDesktopIsolationArgv,
  darwinDockerDesktopProbeScript,
  darwinDockerDesktopValidationArgv,
} from "../delivery/worktree/docker-desktop-backend.js";
import {
  CHECK_COMMAND_TIMEOUT_LIMIT,
  CHECK_CREDENTIAL_SCAN_LIMIT,
  CHECK_OUTPUT_RETAINED_LIMIT,
  CHECK_SECRET_NAME_PATTERN,
  presentCheckedGitMetadata,
  runBoundedCheckCommand,
  type CheckCommandResult,
} from "../workflow-execution/check-sandbox.js";
import type {
  CheckCommandAuthority,
  RequiredCheckProgram,
} from "../workflow-execution/workflow-checks.js";

export type HostContainmentTier = "unattended-check" | "delivery" | "attended-write";

/** Declares the roots and authority properties that a backend must establish. */
export interface HostContainmentPolicy {
  readonly tier: HostContainmentTier;
  readonly readRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly network: "deny";
  readonly credentials: "exclude-names" | "deny-host";
  readonly lifetime: "exact-container" | "die-with-parent";
}

/** Shared host admission: live backend capability, exact input/scratch and a backend probe. */
export async function admitHostContainment<T>(input: {
  readonly backend: ValidationBackendCapability;
  readonly request: ValidationBackendRequestV1;
  readonly identity: ValidationBackendIdentity;
  readonly policy: HostContainmentPolicy;
  readonly observeInput: () => Promise<string>;
  readonly observeScratch: () => Promise<string>;
  readonly probe: () => Promise<{ readonly value: T; readonly commandPrefix: readonly string[] }>;
}): Promise<{ value: T; attestation: ValidationBackendAttestationV1 }> {
  const verifier = requireValidationBackend(input.backend);
  if (verifier.identity !== input.identity) failValidationBackend("untrusted-backend");
  const policy = input.policy;
  const read = policy.readRoots.map((root) => resolve(root));
  const writable = policy.writableRoots.map((root) => resolve(root));
  if (
    policy.tier === "attended-write" ||
    policy.network !== "deny" ||
    (policy.tier === "unattended-check" && policy.credentials !== "exclude-names") ||
    (policy.tier === "delivery" && policy.credentials !== "deny-host") ||
    (input.identity === "darwin-docker-desktop" && policy.lifetime !== "exact-container") ||
    (input.identity === "linux-bubblewrap" && policy.lifetime !== "die-with-parent") ||
    read.length !== 1 ||
    writable.length !== 1 ||
    [...policy.readRoots, ...policy.writableRoots].some((root) => !isAbsolute(root)) ||
    inside(read[0]!, writable[0]!) ||
    inside(writable[0]!, read[0]!)
  )
    failValidationBackend("policy-mismatch");
  const bound = decodeValidationBackendRequest(input.request);
  if ((await input.observeInput()) !== bound.inputTreeSha256)
    failValidationBackend("input-tree-mismatch");
  if ((await input.observeScratch()) !== bound.scratchSha256)
    failValidationBackend("scratch-mismatch");
  const { value, commandPrefix } = await input.probe();
  return {
    value,
    attestation: createValidationBackendAttestation({
      backendIdentity: input.identity,
      policySha256: validationBackendPolicySha256(),
      inputTreeSha256: bound.inputTreeSha256,
      scratchSha256: bound.scratchSha256,
      resultSha256: validationBackendResultSha256(commandPrefix),
    }),
  };
}

const DOCKER_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
const CONTAINER_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const VIEW_KIND = "docsfab-checked-snapshot-v1";
const VALIDATE_VIEW_SCRIPT = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const h=crypto.createHash('sha256').update('${VIEW_KIND}\\n');let pending=[''];
while(pending.length){const dir=pending.pop();const names=fs.readdirSync(path.join('/input',dir),{withFileTypes:true}).map(e=>e.name).filter(n=>n!=='.git').sort((a,b)=>a<b?-1:a>b?1:0);
for(const name of names){const p=dir?dir+'/'+name:name,a=path.join('/input',p),s=fs.lstatSync(a);
if(s.isDirectory()){h.update('d\\0'+p+'\\n');pending.push(p)}
else if(s.isFile()){const b=fs.readFileSync(a);h.update('f\\0'+p+'\\0'+((s.mode&64)?'x':'-')+'\\0'+crypto.createHash('sha256').update(b).digest('hex')+'\\n')}
else if(s.isSymbolicLink()){h.update('l\\0'+p+'\\0'+fs.readlinkSync(a)+'\\n')}
else{h.update('o\\0'+p+'\\n')}}}
process.stdout.write(h.digest('hex'));`;
const RESOLVE_SCRIPT =
  "const fs=require('node:fs');for(const p of process.argv.slice(1)){try{if(fs.statSync(p).isFile()){fs.accessSync(p,fs.constants.X_OK);process.stdout.write(p);break}}catch{}}";
/** Fixed host-authored preparer. Its only source reads are relative to no-follow directory fds. */
const PREPARE_VIEW_SCRIPT = `import io,json,os,posixpath,re,stat,sys
pattern=re.compile(sys.argv[1],re.DOTALL)
max_entries=int(sys.argv[2]);max_bytes=int(sys.argv[3])
entries=0;bytes_seen=0;excluded=0
directory_flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
file_flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC
source=os.open('/input',directory_flags)
output=os.open('/scratch/view',directory_flags)
def same(a,b):
 return a.st_dev==b.st_dev and a.st_ino==b.st_ino and stat.S_IFMT(a.st_mode)==stat.S_IFMT(b.st_mode)
def copy_dir(src,dst,relative):
 global entries,bytes_seen,excluded
 for name in sorted(os.listdir(src)):
  entries+=1
  if entries>max_entries:
   print(json.dumps({'status':'scan-bound','observed':entries}));sys.exit(2)
  if pattern.fullmatch(name):
   excluded+=1;continue
  meta=os.stat(name,dir_fd=src,follow_symlinks=False)
  child=posixpath.join(relative,name)
  if stat.S_ISDIR(meta.st_mode):
   fd=os.open(name,directory_flags,dir_fd=src)
   try:
    if not same(meta,os.fstat(fd)):raise RuntimeError('changed')
    os.mkdir(name,0o700,dir_fd=dst)
    out=os.open(name,directory_flags,dir_fd=dst)
    try:
     copy_dir(fd,out,child)
     os.fchmod(out,meta.st_mode&0o777)
    finally:os.close(out)
   finally:os.close(fd)
  elif stat.S_ISREG(meta.st_mode):
   bytes_seen+=meta.st_size
   if bytes_seen>max_bytes:raise RuntimeError('size-bound')
   fd=os.open(name,file_flags,dir_fd=src)
   try:
    if not same(meta,os.fstat(fd)):raise RuntimeError('changed')
    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=dst)
    try:
     remaining=meta.st_size
     while remaining:
      part=os.read(fd,min(remaining,io.DEFAULT_BUFFER_SIZE))
      if not part:raise RuntimeError('changed')
      written=0
      while written<len(part):written+=os.write(out,part[written:])
      remaining-=len(part)
     if os.read(fd,1):raise RuntimeError('changed')
     os.fchmod(out,meta.st_mode&0o777)
    finally:os.close(out)
   finally:os.close(fd)
  elif stat.S_ISLNK(meta.st_mode):
   target=os.readlink(name,dir_fd=src)
   resolved=posixpath.normpath(posixpath.join('/input',relative,target))
   if posixpath.isabs(target) or not (resolved=='/input' or resolved.startswith('/input/')):raise RuntimeError('unsafe-link')
   os.symlink(target,name,dir_fd=dst)
  else:raise RuntimeError('unsupported-entry')
try:
 copy_dir(source,output,'')
 print(json.dumps({'status':'passed','excluded':excluded,'entries':entries,'bytes':bytes_seen},separators=(',',':')))
finally:
 os.close(output);os.close(source)
`;

/** A failure to prove removal of an owned container can never become passing evidence. */
export class DockerCheckContainmentError extends Error {
  public constructor() {
    super("Docker Desktop could not establish exact-view binding or container removal.");
    this.name = "DockerCheckContainmentError";
  }
}

/** Preparation failures occur before repository code is admitted. */
export class DockerCheckPreparationError extends Error {
  public constructor(
    message: string,
    public readonly stage: "unavailable" | "view" | "scan-bound",
  ) {
    super(message);
    this.name = "DockerCheckPreparationError";
  }
}

function viewPreparationError(): DockerCheckPreparationError {
  return new DockerCheckPreparationError(
    "The private Docker check view could not be prepared safely.",
    "view",
  );
}

function dockerUnavailableError(): DockerCheckPreparationError {
  return new DockerCheckPreparationError(
    "The pinned Docker image or its isolation probe is unavailable.",
    "unavailable",
  );
}

function scanBoundError(observed: number): DockerCheckPreparationError {
  return new DockerCheckPreparationError(
    formatLimitObservation(limit(CHECK_CREDENTIAL_SCAN_LIMIT), observed),
    "scan-bound",
  );
}

type SnapshotObserver = (root: string) => Promise<{ sha256: string | null }>;

/** All Docker calls use one fixed local context and no inherited credential environment. */
function dockerEnvironment(configRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: DOCKER_PATH,
    HOME: configRoot,
    DOCKER_CONTEXT: "default",
    DOCKER_CONFIG: configRoot,
  };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function containerPath(roots: readonly string[], candidate: string): string {
  const root = roots.find((value) => isAbsolute(candidate) && inside(value, candidate));
  if (!root) throw new DockerCheckContainmentError();
  const rel = relative(root, candidate);
  return rel
    ? `${DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT}/${rel.split(sep).join("/")}`
    : DARWIN_DOCKER_DESKTOP_CANDIDATE_ROOT;
}

/** The digest the source should present after the fixed credential exclusions. */
async function observeSanitizedSource(source: string): Promise<string> {
  const bounds = repositoryWorkspaceExportLimits();
  const entryMax = limit(CHECK_CREDENTIAL_SCAN_LIMIT).value;
  const hash = createHash("sha256").update(`${VIEW_KIND}\n`);
  const pending = [""];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const names = (await readdir(join(source, directory)))
      .filter((name) => !CHECK_SECRET_NAME_PATTERN.test(name))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (++entries > entryMax) throw scanBoundError(entries);
      const path = directory ? `${directory}/${name}` : name;
      const absolute = join(source, path);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        hash.update(`d\0${path}\n`);
        pending.push(path);
      } else if (metadata.isFile()) {
        bytes += metadata.size;
        if (bytes > bounds.maxAggregateBytes.value) throw viewPreparationError();
        const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        let content: Buffer;
        try {
          content = await handle.readFile();
        } finally {
          await handle.close();
        }
        hash.update(
          `f\0${path}\0${metadata.mode & fsConstants.S_IXUSR ? "x" : "-"}\0${createHash("sha256").update(content).digest("hex")}\n`,
        );
      } else if (metadata.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (isAbsolute(target) || !inside(source, resolve(dirname(absolute), target)))
          throw viewPreparationError();
        hash.update(`l\0${path}\0${target}\n`);
      } else {
        throw viewPreparationError();
      }
    }
  }
  return hash.digest("hex");
}

function bounds(configRoot: string) {
  return {
    cwd: configRoot,
    env: dockerEnvironment(configRoot),
    timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
    retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
  };
}

/** A host-generated identity is removed and checked after every Docker invocation. */
async function dockerRun(
  view: string,
  scratch: string,
  configRoot: string,
  command: readonly string[],
  signal?: AbortSignal,
): Promise<CheckCommandResult> {
  const name = `docsfab-check-${randomUUID()}`;
  const host = { worktreePath: view, scratchPath: scratch, deniedReadRoots: [homedir()] };
  const base = darwinDockerDesktopValidationArgv(host);
  const args = [base[0]!, base[1]!, "--name", name, ...base.slice(2), ...command];
  assertDarwinDockerDesktopIsolationArgv(args, host);
  let result: CheckCommandResult | undefined;
  try {
    result = await runBoundedCheckCommand(args[0]!, args.slice(1), {
      ...bounds(configRoot),
      signal,
    });
  } finally {
    await runBoundedCheckCommand("docker", ["rm", "--force", name], bounds(configRoot));
    const remaining = await runBoundedCheckCommand(
      "docker",
      ["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
      bounds(configRoot),
    );
    if (remaining.status !== "passed" || remaining.output.trim() !== "")
      throw new DockerCheckContainmentError();
  }
  return result!;
}

/** The mounted view is measured inside Docker before any repository code. */
async function verifyContainerView(
  view: string,
  scratch: string,
  configRoot: string,
  expected: string,
): Promise<void> {
  const measured = await dockerRun(view, scratch, configRoot, ["node", "-e", VALIDATE_VIEW_SCRIPT]);
  if (measured.status !== "passed" || measured.output !== expected) throw dockerUnavailableError();
}

/** The admitted source is an active, owner-private export whose disposal is leased. */
async function privateWorkspaceRoot(workspace: RepositoryWorkspace): Promise<string> {
  const source = await realpath(workspace.path).catch(() => {
    throw viewPreparationError();
  });
  const parent = dirname(source);
  const [parentDetails, parentCanonical, temporaryCanonical] = await Promise.all([
    lstat(parent),
    realpath(parent),
    realpath(tmpdir()),
  ]);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    source === workspace.sourcePath ||
    basename(source) !== "repository" ||
    !basename(parent).startsWith("docsfab-workspace-") ||
    !parentDetails.isDirectory() ||
    parentDetails.isSymbolicLink() ||
    parentDetails.uid !== uid ||
    (parentDetails.mode & 0o077) !== 0 ||
    parentCanonical !== parent ||
    !inside(temporaryCanonical, parent)
  )
    throw viewPreparationError();
  return source;
}

/** A clean default context must address the local Docker Desktop Unix socket. */
async function assertLocalDockerDesktop(configRoot: string): Promise<void> {
  const context = await runBoundedCheckCommand(
    "docker",
    ["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"],
    bounds(configRoot),
  );
  if (context.status !== "passed" || context.output.trim() !== "unix:///var/run/docker.sock")
    throw dockerUnavailableError();
  const socket = await stat("/var/run/docker.sock").catch(() => undefined);
  if (!socket?.isSocket()) throw dockerUnavailableError();
  const info = await runBoundedCheckCommand(
    "docker",
    ["info", "--format", "{{.OperatingSystem}}"],
    bounds(configRoot),
  );
  if (info.status !== "passed" || info.output.trim() !== "Docker Desktop")
    throw dockerUnavailableError();
}

async function prepareDockerView(
  source: string,
  view: string,
  scratch: string,
  configRoot: string,
): Promise<{ excluded: number }> {
  const result = await dockerRun(source, scratch, configRoot, [
    "/usr/bin/python3",
    "-I",
    "-S",
    "-B",
    "-c",
    PREPARE_VIEW_SCRIPT,
    CHECK_SECRET_NAME_PATTERN.source,
    String(limit(CHECK_CREDENTIAL_SCAN_LIMIT).value),
    String(repositoryWorkspaceExportLimits().maxAggregateBytes.value),
  ]);
  let record: unknown;
  try {
    record = JSON.parse(result.output);
  } catch {
    throw viewPreparationError();
  }
  if (
    record &&
    typeof record === "object" &&
    "status" in record &&
    record.status === "scan-bound" &&
    "observed" in record &&
    typeof record.observed === "number"
  )
    throw scanBoundError(record.observed);
  if (
    result.status !== "passed" ||
    !record ||
    typeof record !== "object" ||
    !("status" in record) ||
    record.status !== "passed" ||
    !("excluded" in record) ||
    !Number.isSafeInteger(record.excluded) ||
    !isAbsolute(view)
  )
    throw viewPreparationError();
  return { excluded: record.excluded as number };
}

export async function prepareDarwinCheckAuthority(
  workspace: RepositoryWorkspace,
  observe: SnapshotObserver,
): Promise<CheckCommandAuthority> {
  const release = await acquireRepositoryWorkspaceLease(workspace).catch(() => {
    throw viewPreparationError();
  });
  try {
    const source = await privateWorkspaceRoot(workspace);
    const original = resolve(workspace.path);
    const before = (await observe(source)).sha256;
    if (!before) throw viewPreparationError();
    const sourceRoots = [...new Set([source, original])];
    const fromRepository = (candidate: string) =>
      sourceRoots.some((root) => inside(root, candidate));
    const scratch = await mkdtemp(join(tmpdir(), "docsfab-docker-check-"));
    const preparation = join(scratch, "preparation");
    const view = join(preparation, "view");
    const working = join(scratch, "scratch");
    const configRoot = join(scratch, "docker-client");
    const cleanup = async () => rm(scratch, { recursive: true, force: true });
    try {
      await mkdir(preparation, { mode: 0o700 });
      await mkdir(view, { mode: 0o700 });
      await mkdir(working, { mode: 0o700 });
      await mkdir(configRoot, { mode: 0o700 });
      await assertLocalDockerDesktop(configRoot);
      const image = await runBoundedCheckCommand(
        "docker",
        ["image", "inspect", DARWIN_DOCKER_DESKTOP_IMAGE, "--format", "{{.Id}}"],
        bounds(configRoot),
      );
      if (image.status !== "passed") throw dockerUnavailableError();
      const copied = await prepareDockerView(source, view, preparation, configRoot);
      if ((await observe(source)).sha256 !== before) throw viewPreparationError();
      const presented = (await observe(view)).sha256;
      if (!presented || (await observeSanitizedSource(source)) !== presented)
        throw viewPreparationError();
      const backend = issueHostSelectedValidationBackend("darwin");
      if (!backend) throw dockerUnavailableError();
      const request = createValidationBackendRequest({
        inputTreeSha256: presented,
        scratchSha256: await validationScratchSha256(working),
        limits: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.limits },
        egress: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.egress },
        credentials: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.credentials },
        teardown: { ...DOCSFAB_VALIDATION_BACKEND_POLICY_V1.teardown },
      });
      await admitHostContainment({
        backend,
        request,
        identity: "darwin-docker-desktop",
        policy: {
          tier: "unattended-check",
          readRoots: [view],
          writableRoots: [working],
          network: "deny",
          credentials: "exclude-names",
          lifetime: "exact-container",
        },
        observeInput: async () => (await observe(view)).sha256 ?? "",
        observeScratch: () => validationScratchSha256(working),
        probe: async () => {
          await verifyContainerView(view, working, configRoot, presented);
          const probe = await dockerRun(view, working, configRoot, [
            "node",
            "-e",
            darwinDockerDesktopProbeScript(),
            "/root/.docker/config.json",
            "/input/.env",
            "/input/.npmrc",
            "/input/.docsfab-validation-probe",
            "/scratch/probe",
          ]);
          if (probe.status !== "passed") throw dockerUnavailableError();
          return {
            value: true,
            commandPrefix: darwinDockerDesktopValidationArgv({
              worktreePath: view,
              scratchPath: working,
              deniedReadRoots: [homedir()],
            }),
          };
        },
      });
      // The temporary Git repository contains only the sanitized view.
      await presentCheckedGitMetadata(view, limit(CHECK_COMMAND_TIMEOUT_LIMIT).value).catch(() => {
        throw viewPreparationError();
      });
      if ((await observe(view)).sha256 !== presented) throw viewPreparationError();
      const verify = async () => {
        if (
          (await observe(source)).sha256 !== before ||
          (await observeSanitizedSource(source)) !== presented ||
          (await observe(view)).sha256 !== presented
        )
          throw new DockerCheckContainmentError();
        await verifyContainerView(view, working, configRoot, presented);
      };
      const resolveExecutable = async (candidates: readonly string[]) => {
        const mapped = candidates.map((candidate) =>
          fromRepository(candidate) ? containerPath(sourceRoots, candidate) : candidate,
        );
        const allowed = mapped.filter(
          (candidate) =>
            candidate.startsWith("/input/") ||
            CONTAINER_PATH.some((dir) => candidate.startsWith(`${dir}/`)),
        );
        await verify();
        const found = await dockerRun(view, working, configRoot, [
          "node",
          "-e",
          RESOLVE_SCRIPT,
          ...allowed,
        ]);
        if (found.status !== "passed") return undefined;
        const index = mapped.indexOf(found.output);
        return index < 0 ? undefined : candidates[index];
      };
      const resolved = new Map<RequiredCheckProgram, Promise<string | undefined>>();
      return {
        backendIdentity: "darwin-docker-desktop",
        presentedViewSha256: presented,
        credentialExclusionCount: copied.excluded,
        resolve: (program) => {
          let answer = resolved.get(program);
          if (!answer) {
            const candidates = [`/usr/local/bin/${program}`, `/usr/bin/${program}`];
            answer = resolveExecutable(candidates);
            resolved.set(program, answer);
          }
          return answer;
        },
        resolveExecutable,
        searchPath: CONTAINER_PATH,
        run: async (executable, argv, options) => {
          const cwd = containerPath(sourceRoots, options.cwd);
          const command = fromRepository(executable)
            ? containerPath(sourceRoots, executable)
            : executable;
          if (
            !command.startsWith("/input/") &&
            !CONTAINER_PATH.some((dir) => command.startsWith(`${dir}/`))
          )
            throw new DockerCheckContainmentError();
          await verify();
          const result = await dockerRun(
            view,
            working,
            configRoot,
            [
              "node",
              "-e",
              "const c=require('node:child_process');process.chdir(process.argv[1]);const r=c.spawnSync(process.argv[2],process.argv.slice(3),{stdio:'inherit',env:process.env});process.exit(r.status??1)",
              cwd,
              command,
              ...argv,
            ],
            options.signal,
          );
          await verify();
          return result;
        },
        cleanup,
      };
    } catch (error) {
      await cleanup().catch(() => undefined);
      throw error;
    }
  } finally {
    release();
  }
}
