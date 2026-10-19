// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loadDocsFabEnvironment,
  resolveDocsFabConfigurationRoot,
  resolveDocsFabProjectRoot,
  resolveDocsFabStateDirectory,
} from "../src/config/host-paths.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { refreshConfiguredCredentials } from "../src/security/configured-credentials.js";
import {
  ModelProfileMigrationError,
  bindModelExecutionProfile,
  isReviewOverdue,
  loadModelConfigurations,
  localMissingModelProfileLocator,
  parseModelEndpoint,
} from "../src/model/configuration.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";

interface LocatorProbeObservation {
  case: string;
  reason: string;
  locatorExists: boolean;
  locatorFrozen: boolean | null;
  credentialIo: unknown[];
  hostLimitIo: unknown[];
  fileGloballyRegistered: boolean;
  directoryGloballyRegistered: boolean;
  directGloballyRegistered: boolean;
  ambientGloballyRegistered: boolean;
  knownValueStillRegistered: boolean;
  registryUnchanged: boolean;
  weakMapLookalikeExcluded: boolean;
  rootValidationStats: number;
  providerCalls: number;
  policy?: {
    activeDefaultPreserved: boolean;
    directOverrideApplied: boolean;
    io: unknown[];
    registryUnchanged: boolean;
  };
  masking: Array<{
    source: string;
    form: string;
    hidden: boolean;
    filenames: boolean;
    jsonPrivate: boolean;
    registryUnchanged: boolean;
    displayEscaped?: boolean;
  }>;
}

const isolatedLocatorChild = String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [runtime,root,which]=process.argv.slice(1);
const tokenFile=join(root,'owned-token'),directory=join(root,'owned-directory'),service=join(root,'owned-service.env');
const word=(...parts)=>parts.join('-');
const known=word('inert','orchard','known','harbor','value');
const direct=word('inert','cedar','selected','glen','value');
const ambient=word('inert','quartz','ambient','dune','value');
const fileValue=word('inert','maple','file','coral','value');
const directoryValue=word('inert','cobalt','directory','birch','value');
fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.mkdirSync(join(root,'home'),{recursive:true});fs.writeFileSync(tokenFile,fileValue);fs.writeFileSync(join(directory,'credential'),directoryValue);fs.writeFileSync(service,'');
process.env.DOCSFAB_SERVICE_ENV_FILE=service;
const io=[];let watching=false;
const observe=(operation,path)=>{const text=String(path);if(watching&&text.startsWith(root))io.push({operation,path:text.slice(root.length)});};
for(const [method,operation] of [['statSync','stat'],['readFileSync','read'],['readdirSync','list']]){const original=fs[method];fs[method]=function(...args){observe(operation,args[0]);return original.apply(this,args);};}
syncBuiltinESMExports();
const load=(p)=>import(pathToFileURL(join(runtime,p)).href);
const config=await load('src/model/configuration.ts');const credentials=await load('src/security/configured-credentials.ts');
let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw new Error('synthetic-offline-only');};
const explicit={DOCSFAB_CONFIG_ROOT:join(root,'locator'),DOCSFAB_SERVICE_ENV_FILE:service,SCM_TOKEN:direct};
let sample;try{config.loadModelConfigurations(explicit);}catch(e){sample=e;}assert(sample instanceof config.ModelProfileMigrationError);assert.equal(sample.reason,'no-profile');
credentials.registerConfiguredCredential(known,'owned known fixture');credentials.redactConfiguredCredentials('prime permitted synthetic registry');
process.env.SCM_TOKEN_FILE=tokenFile;process.env.CREDENTIALS_DIRECTORY=directory;process.env.SCM_TOKEN=ambient;credentials.refreshConfiguredCredentials();
const registry=globalThis[Symbol.for('docsfab.configured-credentials')];
const registryBefore={version:registry.version(),generation:registry.environmentGeneration()};
let failure;watching=true;
try{
 if(which==='loader')config.loadModelConfigurations(explicit);
 else if(which==='constructor')throw new config.ModelProfileMigrationError(sample.issues,{},explicit);
 else if(which==='invalid')config.loadModelConfigurations({...explicit,MODEL_PROVIDER:'fixture-route'});
 else if(which==='policy')config.loadModelConfigurations(explicit);
 else if(which==='missing-credential')throw new config.ModelProfileMigrationError([{profile:'MODEL',field:'MODEL_API_KEY',message:'missing required environment variable'}],{},explicit);
 else throw new Error('unknown owned case');
}catch(e){failure=e;}
watching=false;const registryUnchanged=registryBefore.version===registry.version()&&registryBefore.generation===registry.environmentGeneration();assert(failure instanceof config.ModelProfileMigrationError);const locator=config.localMissingModelProfileLocator(failure);
const credentialIo=io.filter(x=>x.path==='/owned-token'||x.path.startsWith('/owned-directory'));
const serviceIo=io.filter(x=>x.path==='/owned-service.env');
delete process.env.SCM_TOKEN_FILE;delete process.env.CREDENTIALS_DIRECTORY;delete process.env.SCM_TOKEN;credentials.refreshConfiguredCredentials();
const fileGloballyRegistered=credentials.containsConfiguredCredential(fileValue);const directoryGloballyRegistered=credentials.containsConfiguredCredential(directoryValue);const directGloballyRegistered=credentials.containsConfiguredCredential(direct);const ambientGloballyRegistered=credentials.containsConfiguredCredential(ambient);
const masking=[];
if(which==='loader'){
 const scalar='q z';
 const proxy=word('inert','wicker','proxy','password');
 const webhook=word('inert','violet','webhook','segment');
 const sources=[
  {name:'selected',selected:{SCM_TOKEN:scalar},ambient:{},secret:scalar},
  {name:'ambient',selected:{},ambient:{SCM_TOKEN:scalar},secret:scalar},
  {name:'same-name-ambient',selected:{SCM_TOKEN:direct},ambient:{SCM_TOKEN:ambient},secret:ambient},
  {name:'known',selected:{},ambient:{},secret:known},
  {name:'selected-proxy',selected:{HTTPS_PROXY:'https://fixture:'+proxy+'@proxy.invalid:443'},ambient:{},secret:proxy},
  {name:'ambient-proxy',selected:{},ambient:{HTTPS_PROXY:'https://fixture:'+proxy+'@proxy.invalid:443'},secret:proxy},
  {name:'selected-webhook',selected:{FIXTURE_WEBHOOK_URL:'https://hooks.invalid/service/'+webhook},ambient:{},secret:webhook},
  {name:'ambient-webhook',selected:{},ambient:{FIXTURE_WEBHOOK_URL:'https://hooks.invalid/service/'+webhook},secret:webhook},
 ];
 for(const source of sources){
  for(const key of ['SCM_TOKEN','HTTPS_PROXY','FIXTURE_WEBHOOK_URL'])delete process.env[key];
  Object.assign(process.env,source.ambient);
  const forms=[['raw',source.secret],['url',encodeURIComponent(source.secret)],['url-lower',encodeURIComponent(source.secret).toLowerCase()],['json',JSON.stringify(source.secret).slice(1,-1)],['base64',Buffer.from(source.secret).toString('base64')],['base64url',Buffer.from(source.secret).toString('base64url')]];
  for(const [form,value] of forms){
   const selected={DOCSFAB_CONFIG_ROOT:join(root,'mask',value),DOCSFAB_SERVICE_ENV_FILE:service,...source.selected};
   const version=registry.version(),generation=registry.environmentGeneration();let error;
   try{config.loadModelConfigurations(selected);}catch(e){error=e;}
   assert(error instanceof config.ModelProfileMigrationError);const lines=config.localMissingModelProfileLocator(error)?.join('\n')??'';
   masking.push({source:source.name,form,hidden:!lines.includes(value)&&lines.includes('[REDACTED]'),filenames:lines.includes('host.yaml')&&lines.includes('secrets.env'),jsonPrivate:!JSON.stringify(error).includes(selected.DOCSFAB_CONFIG_ROOT),registryUnchanged:version===registry.version()&&generation===registry.environmentGeneration()});
  }
 }
 for(const key of ['SCM_TOKEN','HTTPS_PROXY','FIXTURE_WEBHOOK_URL'])delete process.env[key];
 let shapeError;const shape=['nvapi','inertfixturecredentialchars00000'].join('-');
 try{config.loadModelConfigurations({DOCSFAB_CONFIG_ROOT:join(root,'display\nroot',shape),DOCSFAB_SERVICE_ENV_FILE:service});}catch(e){shapeError=e;}
 const lines=config.localMissingModelProfileLocator(shapeError)?.join('\n')??'';
 masking.push({source:'shape-and-display',form:'raw',hidden:!lines.includes(shape)&&lines.includes('[REDACTED]'),filenames:lines.includes('host.yaml')&&lines.includes('secrets.env'),jsonPrivate:!JSON.stringify(shapeError).includes(shape),registryUnchanged:true,displayEscaped:lines.includes('display\\u{a}root')&&!lines.includes('display\nroot')});
}
let policy;
if(which==='policy'){
 const {LIMIT_DEFINITION_BY_NAME}=await load('src/config/limits.generated.ts');
 const fragment=LIMIT_DEFINITION_BY_NAME['secrets.configuredCredentialFragmentChars'];
 const validated=credentials.resolveConfiguredCredentialMatchingDefaults({...process.env,[fragment.override]:String(fragment.value+1)});
 credentials.activateConfiguredCredentialMatchingDefaults(process.env,validated);
 const piece=known.slice(0,fragment.value);
 const beforeVersion=registry.version(),beforeGeneration=registry.environmentGeneration();
 io.splice(0);watching=true;
 const active=credentials.redactDirectConfiguredCredentials('root/'+piece,{DOCSFAB_SERVICE_ENV_FILE:service});
 const overridden=credentials.redactDirectConfiguredCredentials('root/'+piece,{DOCSFAB_SERVICE_ENV_FILE:service,[fragment.override]:String(fragment.value)});
 watching=false;
 policy={activeDefaultPreserved:active==='root/'+piece,directOverrideApplied:!overridden.includes(piece),io:[...io],registryUnchanged:beforeVersion===registry.version()&&beforeGeneration===registry.environmentGeneration()};
}
const result={policy,masking,case:which,reason:failure.reason,locatorExists:locator!==undefined,locatorFrozen:locator?Object.isFrozen(locator):null,credentialIo,hostLimitIo:serviceIo,fileGloballyRegistered,directoryGloballyRegistered,directGloballyRegistered,ambientGloballyRegistered,providerCalls,registryUnchanged,knownValueStillRegistered:credentials.containsConfiguredCredential(known),weakMapLookalikeExcluded:config.localMissingModelProfileLocator(Object.assign(Object.create(config.ModelProfileMigrationError.prototype),{reason:'no-profile',code:'migration-required'}))===undefined,rootValidationStats:io.filter(x=>x.operation==='stat'&&x.path==='/locator').length};
console.log(JSON.stringify(result));
`;

async function observeIsolatedLocator(which: string): Promise<LocatorProbeObservation> {
  const root = mkdtempSync(join(tmpdir(), "docsfab-locator-discovery-"));
  try {
    const runtime = resolve(import.meta.dirname, "..");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        isolatedLocatorChild,
        runtime,
        root,
        which,
      ],
      {
        cwd: runtime,
        // All credential discovery, including the negative control's registry
        // lookups, is confined to this child's harmless synthetic host.
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          TMPDIR: root,
          LANG: "C.UTF-8",
          DOCSFAB_SERVICE_ENV_FILE: join(root, "owned-service.env"),
        },
      },
    );
    return JSON.parse(stdout) as LocatorProbeObservation;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("DocsFab roots", () => {
  it("keeps installed assets immutable while accepting one external configuration root", () => {
    const installedRoot = resolveDocsFabProjectRoot();
    expect(
      resolveDocsFabConfigurationRoot({
        DOCSFAB_PROJECT_ROOT: "/tmp/legacy-must-not-redirect-assets",
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root",
      }),
    ).toBe("/tmp/docsfab-config-root");
    expect(resolveDocsFabProjectRoot()).toBe(installedRoot);
    expect(() =>
      resolveDocsFabConfigurationRoot({
        DOCSFAB_CONFIG_ROOT: "relative/config",
      }),
    ).toThrow("normalized absolute directory path");
    expect(() =>
      resolveDocsFabConfigurationRoot({
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root/",
      }),
    ).toThrow("normalized absolute directory path");
    expect(
      resolveDocsFabStateDirectory({
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root",
      }),
    ).toBe("/tmp/docsfab-config-root/.docsfab/runs");
    expect(
      resolveDocsFabStateDirectory({
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root",
        DOCSFAB_STATE_DIR: "/tmp/override-runs",
      }),
    ).toBe("/tmp/override-runs");
    expect(
      resolveDocsFabStateDirectory({
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root",
        DOCSFAB_STATE_DIR: "./.docsfab/runs",
      }),
    ).toBe("/tmp/docsfab-config-root/.docsfab/runs");
    expect(resolve("./.docsfab/runs")).not.toBe("/tmp/docsfab-config-root/.docsfab/runs");
    expect(() =>
      resolveDocsFabStateDirectory({
        DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root",
        DOCSFAB_STATE_DIR: "",
      }),
    ).toThrow("DOCSFAB_STATE_DIR must be one directory path without NUL bytes.");
  });

  it("reads the state directory the host env file names, as docsfab run does after loading that file (#1688)", () => {
    const root = mkdtempSync(join(tmpdir(), "docsfab-state-env-file-"));
    try {
      const legacy = join(root, "legacy");
      mkdirSync(legacy, { mode: 0o700 });
      writeFileSync(join(legacy, ".env"), "DOCSFAB_STATE_DIR=./elsewhere/runs\n");
      const environment = { DOCSFAB_CONFIG_ROOT: legacy };
      const loaded: NodeJS.ProcessEnv = { ...environment };
      loadDocsFabEnvironment(loaded);
      expect(resolveDocsFabStateDirectory(environment)).toBe(join(legacy, "elsewhere", "runs"));
      expect(resolveDocsFabStateDirectory(environment)).toBe(resolveDocsFabStateDirectory(loaded));
      // The process environment still wins over the file.
      expect(
        resolveDocsFabStateDirectory({ ...environment, DOCSFAB_STATE_DIR: "/tmp/ambient-runs" }),
      ).toBe("/tmp/ambient-runs");

      // Split layout: host.yaml paths.stateDir wins over secrets.env, which fills in otherwise.
      const split = join(root, "split");
      mkdirSync(split, { mode: 0o700 });
      const host = ["schemaVersion: 1", "kind: docsfab-host-config", "compositionId: fixture", ""];
      writeFileSync(join(split, "host.yaml"), host.join("\n"));
      writeFileSync(join(split, "secrets.env"), "DOCSFAB_STATE_DIR=/tmp/secrets-runs\n");
      expect(resolveDocsFabStateDirectory({ DOCSFAB_CONFIG_ROOT: split })).toBe(
        "/tmp/secrets-runs",
      );
      writeFileSync(
        join(split, "host.yaml"),
        [...host.slice(0, -1), "paths:", "  stateDir: ./host-runs", ""].join("\n"),
      );
      expect(resolveDocsFabStateDirectory({ DOCSFAB_CONFIG_ROOT: split })).toBe(
        join(split, "host-runs"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseModelEndpoint", () => {
  it("maps chat completions into Pi's API name", () => {
    expect(parseModelEndpoint(validModelEnvironment)).toEqual(validModelConfig);
  });

  it("rejects missing credentials", () => {
    let failure: unknown;
    try {
      parseModelEndpoint({ ...validModelEnvironment, MODEL_API_KEY: "" });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("missing-primary-credential");
    expect(migration.issues).toEqual([
      {
        profile: "MODEL",
        field: "MODEL_API_KEY",
        message: "missing required environment variable",
      },
    ]);
    expect(migration.message).toContain("hidden setup prompt");
    expect(migration.message).not.toContain("docsfab setup");
    expect(migration.message).not.toMatch(/profile inspect|profile approve|schema migration/iu);
  });

  it("names the selected route and the exact variable it needs when the credential is under the wrong name (#1080)", () => {
    // The operator pointed MODEL_BASE_URL at a route and left the key under a
    // route-specific name (DOCSFAB_NVIDIA_API_KEY) instead of the MODEL_API_KEY
    // this route reads. The wrong-name value must never leak either.
    const wrongNameValue = "wrong-name-credential-value";
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: "nvidia",
        MODEL_BASE_URL: "https://integrate.api.nvidia.com/v1",
        MODEL_API_KEY: "",
        DOCSFAB_NVIDIA_API_KEY: wrongNameValue,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("missing-primary-credential");
    expect(migration.message).toContain("MODEL_API_KEY");
    expect(migration.message).toContain("nvidia");
    expect(migration.message).toContain("https://integrate.api.nvidia.com/v1");
    expect(migration.message).not.toContain(wrongNameValue);
  });

  it("names the redirected variable, not just the API_KEY field, when MODEL_CREDENTIAL_ENV points at a missing name", () => {
    // MODEL_CREDENTIAL_ENV names an unpopulated variable: the report names that
    // target, not the MODEL_API_KEY field the redirect writes into internally.
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: "nvidia",
        MODEL_BASE_URL: "https://integrate.api.nvidia.com/v1",
        MODEL_API_KEY: "",
        MODEL_CREDENTIAL_ENV: "DOCSFAB_NVIDIA_API_KEY",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("missing-primary-credential");
    expect(migration.message).toContain("DOCSFAB_NVIDIA_API_KEY");
    expect(migration.message).toContain("nvidia");
    expect(migration.message).toContain("https://integrate.api.nvidia.com/v1");
  });

  it("refuses BASE_URL userinfo by name and keeps it out of the message (#1080 repair)", () => {
    // The profile collector refuses userinfo in MODEL_BASE_URL beside the
    // missing credential; the report names the field, never the URL's parts.
    const username = "opaque-user-must-not-appear";
    const password = "s3cr3t-token-value-must-not-appear";
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: "nvidia",
        MODEL_BASE_URL: `https://${username}:${password}@integrate.api.nvidia.com/v1`,
        MODEL_API_KEY: "",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("invalid-profile");
    expect(migration.message).toContain(
      "- MODEL_BASE_URL: must not carry a user name or password; DocsFab sends the model key in a request header",
    );
    expect(migration.message).toContain("- MODEL_API_KEY: missing required environment variable");
    expect(migration.message).not.toContain(username);
    expect(migration.message).not.toContain(password);
  });

  it("refuses a BASE_URL query string by name and keeps it out of the message (#1080 repair)", () => {
    // Operators sometimes put a bearer token in the query; the collector refuses it.
    const queryToken = "leaked-secret-value-in-query-must-not-appear";
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: "nvidia",
        MODEL_BASE_URL: `https://integrate.api.nvidia.com/v1?api_key=${queryToken}`,
        MODEL_API_KEY: "",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("invalid-profile");
    expect(migration.message).toContain("- MODEL_BASE_URL: must not carry a query string");
    expect(migration.message).not.toContain(queryToken);
    expect(migration.message).not.toContain("?api_key");
  });

  it("refuses a BASE_URL fragment by name and keeps it out of the message (#1080 repair)", () => {
    // The WHATWG URL parser still exposes a fragment, so it is refused too.
    const fragmentSecret = "leaked-fragment-secret-value-must-not-appear";
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: "nvidia",
        MODEL_BASE_URL: `https://integrate.api.nvidia.com/v1#${fragmentSecret}`,
        MODEL_API_KEY: "",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("invalid-profile");
    expect(migration.message).toContain("- MODEL_BASE_URL: must not carry a fragment");
    expect(migration.message).not.toContain(fragmentSecret);
    expect(migration.message).not.toContain("#");
  });

  it("strips control characters from the PROVIDER label so it cannot forge report lines (#1080 repair)", () => {
    // The collector only presence-checks MODEL_PROVIDER, so raw control bytes
    // (newline/CR, BEL, ESC) could forge a report line or an ANSI escape unless
    // the rendered error neutralizes them.
    const bell = String.fromCharCode(7);
    const escapeByte = String.fromCharCode(27);
    const forgedLine = "FORGED-REPORT-LINE-injected-must-not-stand-alone";
    const hostileProvider = "nvidia" + bell + escapeByte + "\n" + forgedLine;
    let failure: unknown;
    try {
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROVIDER: hostileProvider,
        MODEL_API_KEY: "",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("missing-primary-credential");
    expect(migration.message).not.toContain(bell);
    expect(migration.message).not.toContain(escapeByte);
    expect(migration.message).not.toContain("\n" + forgedLine);
    expect(migration.message.split("\n")).not.toContain(forgedLine);
    expect(migration.message).toContain("nvidia");
  });

  it("rejects an injection-shaped MODEL_CREDENTIAL_ENV name before any migration message can be built (#1080 repair)", () => {
    // assertCredentialEnvironmentName enforces the name grammar on
    // MODEL_CREDENTIAL_ENV first, so an injection-shaped target fails fast with a
    // plain Error; safeCredentialVariableName is defense in depth for other callers.
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_KEY: "",
        MODEL_CREDENTIAL_ENV: "nvidia key\ninjected-line",
      }),
    ).toThrow("uppercase variable name");
  });

  it("reports every field needed to migrate an old endpoint configuration", () => {
    const oldEnvironment = {
      MODEL_PROVIDER: "test-provider",
      MODEL_BASE_URL: "https://inference.example.test/v1",
      MODEL_ID: "example/model",
      MODEL_API_FORMAT: "chat_completions",
      MODEL_API_KEY: "test-secret",
    };

    let failure: unknown;
    try {
      parseModelEndpoint(oldEnvironment);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.issues).toHaveLength(16);
    expect(migration.issues.map((issue) => issue.field)).toEqual([
      "MODEL_CONTEXT_WINDOW",
      "MODEL_MAX_OUTPUT_TOKENS",
      "MODEL_API_MIN_OUTPUT_TOKENS",
      "MODEL_CONTEXT_RESERVE_TOKENS",
      "MODEL_REASONING",
      "MODEL_INPUT_TYPES",
      "MODEL_SUPPORTS_DEVELOPER_ROLE",
      "MODEL_SUPPORTS_REASONING_EFFORT",
      "MODEL_COMPATIBLE_API_FORMATS",
      "MODEL_INPUT_COST_PER_MILLION",
      "MODEL_OUTPUT_COST_PER_MILLION",
      "MODEL_CACHE_READ_COST_PER_MILLION",
      "MODEL_CACHE_WRITE_COST_PER_MILLION",
      "MODEL_PROFILE_APPROVED_SOURCE",
      "MODEL_PROFILE_EFFECTIVE_DATE",
      "MODEL_PROFILE_REVIEW_AFTER",
    ]);
    expect(migration.message).toMatchInlineSnapshot(`
      "Model profile migration required. DocsFab did not register an invalid or incompatible profile.
      MODEL profile (16 issues):
      - MODEL_CONTEXT_WINDOW: missing required environment variable
      - MODEL_MAX_OUTPUT_TOKENS: missing required environment variable
      - MODEL_API_MIN_OUTPUT_TOKENS: missing required environment variable
      - MODEL_CONTEXT_RESERVE_TOKENS: missing required environment variable
      - MODEL_REASONING: missing required environment variable
      - MODEL_INPUT_TYPES: missing required environment variable
      - MODEL_SUPPORTS_DEVELOPER_ROLE: missing required environment variable
      - MODEL_SUPPORTS_REASONING_EFFORT: missing required environment variable
      - MODEL_COMPATIBLE_API_FORMATS: missing required environment variable
      - MODEL_INPUT_COST_PER_MILLION: missing required environment variable
      - MODEL_OUTPUT_COST_PER_MILLION: missing required environment variable
      - MODEL_CACHE_READ_COST_PER_MILLION: missing required environment variable
      - MODEL_CACHE_WRITE_COST_PER_MILLION: missing required environment variable
      - MODEL_PROFILE_APPROVED_SOURCE: missing required environment variable
      - MODEL_PROFILE_EFFECTIVE_DATE: missing required environment variable
      - MODEL_PROFILE_REVIEW_AFTER: missing required environment variable
      Action: add or correct the listed fields using .env.example. Keep the three *_PROFILE_* provenance fields set to unknown unless an operator has approved a source and dates.
      No credential values are included in this report."
    `);
  });

  it("aggregates malformed fields without echoing their values", () => {
    const secret = "credential-that-must-not-appear";
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_KEY: secret,
        MODEL_CONTEXT_WINDOW: "many",
        MODEL_MAX_OUTPUT_TOKENS: "also-many",
        MODEL_REASONING: "sometimes",
        MODEL_INPUT_COST_PER_MILLION: "cheap",
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ field: "MODEL_CONTEXT_WINDOW" }),
          expect.objectContaining({ field: "MODEL_MAX_OUTPUT_TOKENS" }),
          expect.objectContaining({ field: "MODEL_REASONING" }),
          expect.objectContaining({ field: "MODEL_INPUT_COST_PER_MILLION" }),
        ]),
        message: expect.not.stringContaining(secret),
      }),
    );
  });

  it("rejects invalid profile metadata", () => {
    expect(() =>
      parseModelEndpoint({ ...validModelEnvironment, MODEL_CONTEXT_WINDOW: "a lot" }),
    ).toThrow("MODEL_CONTEXT_WINDOW");
    expect(() =>
      parseModelEndpoint({ ...validModelEnvironment, MODEL_REASONING: "sometimes" }),
    ).toThrow("MODEL_REASONING");
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_CONTEXT_WINDOW: "100",
        MODEL_MAX_OUTPUT_TOKENS: "101",
      }),
    ).toThrow("must not exceed");
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_MIN_OUTPUT_TOKENS: "sixteen",
        MODEL_CONTEXT_RESERVE_TOKENS: "some",
      }),
    ).toThrow("MODEL_API_MIN_OUTPUT_TOKENS");
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_MAX_OUTPUT_TOKENS: "15",
        MODEL_API_MIN_OUTPUT_TOKENS: "16",
      }),
    ).toThrow("must be at least MODEL_API_MIN_OUTPUT_TOKENS");
  });

  it("requires a complete approved-source and effective-date contract", () => {
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROFILE_APPROVED_SOURCE: "unknown",
      }),
    ).toThrow("must all be supplied or all be unknown");
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROFILE_APPROVED_SOURCE: "http://metadata.example.test/model",
      }),
    ).toThrow("must be an HTTPS URL without credentials");
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_PROFILE_EFFECTIVE_DATE: "2026-02-30",
      }),
    ).toThrow("must be a valid YYYY-MM-DD date");
  });

  it("uses conservative capabilities and unknown economics without a source", () => {
    const profile = parseModelEndpoint({
      ...validModelEnvironment,
      MODEL_PROFILE_APPROVED_SOURCE: "unknown",
      MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
      MODEL_PROFILE_REVIEW_AFTER: "unknown",
    }).profile;

    expect(profile.metadata.status).toBe("unknown");
    expect(profile.configuredLimits).toEqual({
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(profile.contextWindow).toBe(128_000);
    expect(profile.maxInputTokens).toBe(128_000);
    expect(profile.maxOutputTokens).toBe(16_384);
    expect(profile.effectiveLimitReason).toBe("metadata-unknown");
    expect(profile.reasoning).toBe(false);
    expect(profile.input).toEqual(["text"]);
    expect(profile.compatibility.supportsDeveloperRole).toBe(false);
    expect(profile.compatibility.supportsReasoningEffort).toBe(false);
    expect(profile.costPerMillionTokens).toEqual({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    });
  });

  it("defaults legacy profiles to the context input cap and accepts a lower explicit cap", () => {
    const legacy = parseModelEndpoint(validModelEnvironment).profile;
    const bounded = parseModelEndpoint({
      ...validModelEnvironment,
      MODEL_MAX_INPUT_TOKENS: "96000",
    }).profile;

    expect(legacy.configuredLimits.maxInputTokens).toBe(128_000);
    expect(legacy.maxInputTokens).toBe(128_000);
    expect(bounded.configuredLimits.maxInputTokens).toBe(96_000);
    expect(bounded.maxInputTokens).toBe(96_000);
  });

  it("rejects an explicit input cap above the configured context", () => {
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_MAX_INPUT_TOKENS: "128001",
      }),
    ).toThrow("must not exceed MODEL_CONTEXT_WINDOW");
  });

  describe("a passed review date is advisory", () => {
    const REVIEW_AFTER = "2026-07-31";
    // Non-default values throughout, so "equals configured" cannot pass
    // against the stripped false / ["text"] / null defaults.
    const environment = {
      ...validModelEnvironment,
      MODEL_REASONING: "true",
      MODEL_INPUT_TYPES: "text,image",
      MODEL_SUPPORTS_DEVELOPER_ROLE: "true",
      MODEL_SUPPORTS_REASONING_EFFORT: "true",
      MODEL_INPUT_COST_PER_MILLION: "1.25",
      MODEL_OUTPUT_COST_PER_MILLION: "10",
      MODEL_CACHE_READ_COST_PER_MILLION: "0.5",
      MODEL_CACHE_WRITE_COST_PER_MILLION: "0.75",
      MODEL_PROFILE_REVIEW_AFTER: REVIEW_AFTER,
    };

    it("keeps every configured claim and stays current after the review date", () => {
      const now = new Date("2026-08-03T12:00:00.000Z");
      expect(REVIEW_AFTER < now.toISOString().slice(0, 10)).toBe(true);
      const profile = parseModelEndpoint(environment, "MODEL", now).profile;

      expect(profile.metadata.status).toBe("current");
      expect(profile.effectiveLimitReason).toBe("none");
      expect(profile.contextWindow).toBe(128_000);
      expect(profile.maxOutputTokens).toBe(16_384);
      expect(profile.reasoning).toBe(true);
      expect(profile.input).toEqual(["text", "image"]);
      expect(profile.compatibility.supportsDeveloperRole).toBe(true);
      expect(profile.compatibility.supportsReasoningEffort).toBe(true);
      expect(profile.costPerMillionTokens).toEqual({
        input: 1.25,
        output: 10,
        cacheRead: 0.5,
        cacheWrite: 0.75,
      });
      expect(isReviewOverdue(profile.metadata.reviewAfter, now)).toBe(true);
    });

    it("parses the same profile on both sides of the review date", () => {
      const before = parseModelEndpoint(environment, "MODEL", new Date("2026-07-30T12:00:00Z"));
      const after = parseModelEndpoint(environment, "MODEL", new Date("2026-08-01T12:00:00Z"));
      expect(after).toEqual(before);
    });

    it("keeps refusing a future effective date and a review date before it", () => {
      // Adjacent conditions the date change must not relax.
      const now = new Date("2026-08-03T12:00:00.000Z");
      expect(() =>
        parseModelEndpoint(
          { ...environment, MODEL_PROFILE_EFFECTIVE_DATE: "2026-08-04" },
          "MODEL",
          now,
        ),
      ).toThrow("MODEL_PROFILE_EFFECTIVE_DATE: must not be in the future");
      expect(() =>
        parseModelEndpoint(
          { ...environment, MODEL_PROFILE_EFFECTIVE_DATE: "2026-08-01" },
          "MODEL",
          now,
        ),
      ).toThrow("MODEL_PROFILE_REVIEW_AFTER: must not precede MODEL_PROFILE_EFFECTIVE_DATE");
    });
  });

  describe("isReviewOverdue", () => {
    it("is false through the last second of the review day, in UTC", () => {
      expect(isReviewOverdue("2026-09-29", new Date("2026-09-29T23:59:59Z"))).toBe(false);
      expect(isReviewOverdue("2026-09-29", new Date("2026-09-29T00:00:00Z"))).toBe(false);
    });

    it("is true from the first second of the next UTC day", () => {
      // With the not-overdue 23:59:59Z case above, a local-date reading fails
      // on any host whose zone is not UTC: west of UTC here, east of it above.
      expect(isReviewOverdue("2026-09-29", new Date("2026-09-30T00:00:00Z"))).toBe(true);
    });

    it("is false before the review date and for absent metadata", () => {
      expect(isReviewOverdue("2026-09-29", new Date("2026-09-28T12:00:00Z"))).toBe(false);
      expect(isReviewOverdue(null, new Date("2099-01-01T00:00:00Z"))).toBe(false);
      expect(isReviewOverdue(undefined, new Date("2099-01-01T00:00:00Z"))).toBe(false);
    });

    it("refuses an invalid clock instead of guessing", () => {
      expect(() => isReviewOverdue("2026-09-29", new Date(Number.NaN))).toThrow(RangeError);
    });
  });

  it("diagnoses judge profile fields with an independent prefix", () => {
    const judgeEnvironment = Object.fromEntries(
      Object.entries(validModelEnvironment).map(([name, value]) => [
        name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/, "JUDGE_"),
        value,
      ]),
    );
    delete judgeEnvironment.JUDGE_CONTEXT_WINDOW;

    expect(() => parseModelEndpoint(judgeEnvironment, "JUDGE")).toThrowError(
      expect.objectContaining({
        issues: [
          {
            profile: "JUDGE",
            field: "JUDGE_CONTEXT_WINDOW",
            message: "missing required environment variable",
          },
        ],
      }),
    );
  });

  it("keeps a lone missing JUDGE_API_KEY on the invalid judge-profile path", () => {
    const judgeEnvironment = Object.fromEntries(
      Object.entries(validModelEnvironment).map(([name, value]) => [
        name === "MODEL_ID" ? "JUDGE_MODEL_ID" : name.replace(/^MODEL_/, "JUDGE_"),
        value,
      ]),
    );
    delete judgeEnvironment.JUDGE_API_KEY;

    let failure: unknown;
    try {
      parseModelEndpoint(judgeEnvironment, "JUDGE");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("invalid-profile");
    expect(migration.issues).toEqual([
      {
        profile: "JUDGE",
        field: "JUDGE_API_KEY",
        message: "missing required environment variable",
      },
    ]);
    expect(migration.message).toMatch(/^Model profile migration required\./u);
  });

  it("classifies a fully empty MODEL_* block as a missing profile, not a schema migration", () => {
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", "/tmp/docsfab-config-root-fixture");
    try {
      let failure: unknown;
      try {
        parseModelEndpoint({ DOCSFAB_CONFIG_ROOT: "/tmp/docsfab-config-root-fixture" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelProfileMigrationError);
      const migration = failure as ModelProfileMigrationError;
      expect(migration.reason).toBe("no-profile");
      expect(migration.issues).toHaveLength(21);
      expect(migration.message).toMatch(/no loadable model profile/iu);
      expect(migration.message).not.toMatch(/migration required/iu);
      expect(migration.message).toContain("host.yaml and secrets.env");
      expect(migration.message).not.toContain("/tmp/docsfab-config-root-fixture/.env");
      expect(localMissingModelProfileLocator(migration)).toEqual([
        "Configuration root: /tmp/docsfab-config-root-fixture",
        "Host configuration: /tmp/docsfab-config-root-fixture/host.yaml",
        "Credential file: /tmp/docsfab-config-root-fixture/secrets.env",
      ]);
      expect(migration.message).toContain("docsfab profile seed");
      expect(migration.message).not.toContain("profile inspect");
      expect(migration.message).not.toContain("profile approve");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the profile loader's selected root when the ambient root differs", () => {
    const selectedRoot = "/tmp/docsfab selected root";
    vi.stubEnv("DOCSFAB_CONFIG_ROOT", "/tmp/ambient-docsfab-root");
    try {
      let failure: unknown;
      try {
        loadModelConfigurations({
          DOCSFAB_CONFIG_ROOT: selectedRoot,
          UNRELATED_SECRET: "inert-test-secret-value",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelProfileMigrationError);
      const migration = failure as ModelProfileMigrationError;
      const locator = localMissingModelProfileLocator(migration)?.join("\n") ?? "";
      expect(locator).toContain(selectedRoot);
      expect(locator).toContain(`${selectedRoot}/host.yaml`);
      expect(locator).toContain(`${selectedRoot}/secrets.env`);
      expect(locator).not.toContain("/tmp/ambient-docsfab-root");
      expect(locator).not.toContain("inert-test-secret-value");
      expect(migration.message).not.toContain(selectedRoot);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("screens a credential supplied only in the effective environment from local paths", () => {
    const marker = ["inert", "effective", "synthetic", "password"].join("-");
    const root = `/synthetic-config/${marker}`;
    let failure: unknown;
    try {
      loadModelConfigurations({ DOCSFAB_CONFIG_ROOT: root, SCM_TOKEN: marker });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const locator = localMissingModelProfileLocator(failure)?.join("\n") ?? "";
    expect(locator).not.toContain(marker);
    expect(locator).toContain("[REDACTED]");
    expect(locator).toContain("host.yaml");
    expect(locator).toContain("secrets.env");
    expect((failure as ModelProfileMigrationError).message).not.toContain(marker);
  });

  it("keeps canonical filenames when a short supplied credential needs exact masking", () => {
    let failure: unknown;
    try {
      loadModelConfigurations({ DOCSFAB_CONFIG_ROOT: "/synthetic-config/qz", SCM_TOKEN: "qz" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const locator = localMissingModelProfileLocator(failure)?.join("\n") ?? "";
    expect(locator).not.toContain("/synthetic-config/qz");
    expect(locator).toContain("[REDACTED]");
    expect(locator).toContain("host.yaml");
    expect(locator).toContain("secrets.env");
  });

  it("closes proxy and short-encoded effective-environment locator disclosures", () => {
    const password = ["inert", "critic", "proxy", "password"].join("-");
    const sources = [
      {
        environment: { HTTPS_PROXY: `https://fixture:${password}@proxy.invalid:443` },
        forms: [password, encodeURIComponent(password), Buffer.from(password).toString("base64")],
      },
      {
        environment: { SCM_TOKEN: "q z" },
        forms: ["q z", encodeURIComponent("q z"), Buffer.from("q z").toString("base64")],
      },
    ];
    for (const { environment, forms } of sources) {
      for (const form of forms) {
        let failure: unknown;
        try {
          loadModelConfigurations({
            ...environment,
            DOCSFAB_CONFIG_ROOT: `/synthetic-config/${form}`,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ModelProfileMigrationError);
        const locator = localMissingModelProfileLocator(failure);
        expect(Object.isFrozen(locator)).toBe(true);
        expect(locator?.join("\n").includes(form)).toBe(false);
        expect(locator?.join("\n")).toContain("[REDACTED]");
        expect(locator?.join("\n")).toContain("host.yaml");
        expect(locator?.join("\n")).toContain("secrets.env");
        expect(JSON.stringify(failure).includes(form)).toBe(false);
      }
    }
  });

  it("screens the encoded form of a supplied credential in a selected root", () => {
    const marker = "inert effective synthetic password";
    const encoded = encodeURIComponent(marker);
    let failure: unknown;
    try {
      loadModelConfigurations({
        DOCSFAB_CONFIG_ROOT: `/synthetic-config/${encoded}`,
        SCM_TOKEN: marker,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const locator = localMissingModelProfileLocator(failure)?.join("\n") ?? "";
    expect(locator).not.toContain(encoded);
    expect(locator).toContain("host.yaml");
    expect(locator).toContain("secrets.env");
  });

  it("continues screening credentials configured only in the ambient environment", () => {
    const marker = ["inert", "ambient", "synthetic", "password"].join("-");
    vi.stubEnv("SCM_TOKEN", marker);
    refreshConfiguredCredentials();
    try {
      let failure: unknown;
      try {
        loadModelConfigurations({ DOCSFAB_CONFIG_ROOT: `/synthetic-config/${marker}` });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ModelProfileMigrationError);
      expect(localMissingModelProfileLocator(failure)?.join("\n")).not.toContain(marker);
    } finally {
      vi.unstubAllEnvs();
      refreshConfiguredCredentials();
    }
  });

  it("escapes control characters and hides credential-shaped segments in a selected root", () => {
    const token = "nvapi-inertfixturecredentialchars00000";
    let failure: unknown;
    try {
      loadModelConfigurations({
        DOCSFAB_CONFIG_ROOT: `/tmp/config\nroot/${token}`,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    const locator = localMissingModelProfileLocator(migration)?.join("\n") ?? "";
    expect(locator).toContain("/tmp/config\\u{a}root/");
    expect(locator).toContain("[REDACTED]");
    expect(locator).not.toContain(token);
    expect(locator).not.toContain("/tmp/config\nroot");
    expect(migration.message).not.toContain(token);
  });

  it("keeps invalid configuration-root input on its own refusal path", () => {
    expect(() => loadModelConfigurations({ DOCSFAB_CONFIG_ROOT: "relative/root" })).toThrow(
      "DOCSFAB_CONFIG_ROOT must be one normalized absolute directory path.",
    );
  });

  it("keeps a partially configured legacy profile on the migration-required (not missing-profile) path", () => {
    const oldEnvironment = {
      MODEL_PROVIDER: "test-provider",
      MODEL_BASE_URL: "https://inference.example.test/v1",
      MODEL_ID: "example/model",
      MODEL_API_FORMAT: "chat_completions",
      MODEL_API_KEY: "test-secret",
    };
    let failure: unknown;
    try {
      parseModelEndpoint(oldEnvironment);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    const migration = failure as ModelProfileMigrationError;
    expect(migration.reason).toBe("invalid-profile");
    expect(migration.message).toMatch(/^Model profile migration required\./u);
  });

  it("rejects incompatible model and API-format combinations", () => {
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_COMPATIBLE_API_FORMATS: "messages",
      }),
    ).toThrow('MODEL_API_FORMAT "chat_completions" is incompatible');
    expect(() =>
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_FORMAT: "openai-completions",
      }),
    ).toThrow("must select either chat_completions or messages");
    expect(
      parseModelEndpoint({
        ...validModelEnvironment,
        MODEL_API_FORMAT: "messages",
        MODEL_COMPATIBLE_API_FORMATS: "messages",
      }).apiFormat,
    ).toBe("messages");
  });
});

describe("bindModelExecutionProfile", () => {
  it("bridges the legacy endpoint without inferring a route from the model ID", () => {
    const bound = bindModelExecutionProfile({
      ...validModelConfig,
      providerId: "configured-route",
      modelId: "vendor/model-name-that-does-not-select-a-route",
    });

    expect(bound.profile).toMatchObject({
      routeId: "configured-route",
      providerId: "configured-route",
      modelId: "vendor/model-name-that-does-not-select-a-route",
      transport: "openai-chat-completions",
      apiFormat: "chat_completions",
    });
    expect(bound.profile).not.toHaveProperty("apiKey");
    expect(bound.credential).toEqual({
      family: "legacy-configured-endpoint",
      apiKey: validModelConfig.apiKey,
    });
  });
});

describe("parseRetryPolicy", () => {
  it("defaults to three read-only retries while retaining the delays and closed safe classes", () => {
    expect(parseRetryPolicy({})).toEqual({
      maxRetries: 3,
      // `timeout` and a cut answer each keep a smaller budget of their own,
      // inside `maxRetries`: one retry by default.
      maxTimeoutRetries: 1,
      maxCutAnswerRetries: 1,
      maxNoProgressRetries: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 2_000,
      retryableCategories: [
        "blank-response",
        "malformed-response",
        "timeout",
        "throttled",
        "provider-transient",
        "no-progress",
      ],
      // Throttles and transport faults spend this budget, not `maxRetries`.
      transport: { maxRetries: 6, maxDelayMs: 60_000, maxElapsedMs: 3_600_000 },
      maxRetriesSource: "config/limits.yaml",
    });
  });

  it("parses bounded retry count, backoff, and a safe class subset", () => {
    expect(
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_RETRIES: "3",
        DOCSFAB_RETRY_BASE_DELAY_MS: "100",
        DOCSFAB_RETRY_MAX_DELAY_MS: "500",
        DOCSFAB_RETRYABLE_CATEGORIES: "timeout,throttled",
      }),
    ).toEqual({
      maxRetries: 3,
      maxTimeoutRetries: 1,
      maxCutAnswerRetries: 1,
      maxNoProgressRetries: 1,
      baseDelayMs: 100,
      maxDelayMs: 500,
      retryableCategories: ["timeout", "throttled"],
      transport: { maxRetries: 6, maxDelayMs: 60_000, maxElapsedMs: 3_600_000 },
      maxRetriesSource: "host",
    });
  });

  it("rejects unbounded, terminal, duplicate, and inverted settings", () => {
    expect(() => parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "4" })).toThrow("0 through 3");
    expect(() => parseRetryPolicy({ DOCSFAB_RETRYABLE_CATEGORIES: "provider-terminal" })).toThrow(
      "must contain only",
    );
    expect(() => parseRetryPolicy({ DOCSFAB_RETRYABLE_CATEGORIES: "timeout,timeout" })).toThrow(
      "must not contain duplicates",
    );
    expect(() =>
      parseRetryPolicy({
        DOCSFAB_RETRY_BASE_DELAY_MS: "501",
        DOCSFAB_RETRY_MAX_DELAY_MS: "500",
      }),
    ).toThrow("greater than or equal");
  });
});

describe("isolated missing-profile locator discovery", () => {
  it("keeps active matching defaults and direct overrides without reading their file", async () => {
    const observed = await observeIsolatedLocator("policy");
    expect(observed.policy).toEqual({
      activeDefaultPreserved: true,
      directOverrideApplied: true,
      io: [],
      registryUnchanged: true,
    });
  });
  it.each(["loader", "constructor"])(
    "does not refresh ambient credential sources through the public %s",
    async (which) => {
      const observed = await observeIsolatedLocator(which);
      expect(observed.reason).toBe("no-profile");
      expect(observed.locatorExists).toBe(true);
      expect(observed.locatorFrozen).toBe(true);
      expect(observed.credentialIo).toEqual([]);
      expect(observed.hostLimitIo).toEqual([]);
      expect(observed.rootValidationStats).toBe(1);
      expect(observed.fileGloballyRegistered).toBe(false);
      expect(observed.directoryGloballyRegistered).toBe(false);
      expect(observed.directGloballyRegistered).toBe(false);
      expect(observed.ambientGloballyRegistered).toBe(false);
      expect(observed.registryUnchanged).toBe(true);
      expect(observed.knownValueStillRegistered).toBe(true);
      expect(observed.weakMapLookalikeExcluded).toBe(true);
      expect(observed.providerCalls).toBe(0);
      if (which === "loader") {
        expect(observed.masking).toHaveLength(49);
        for (const row of observed.masking) {
          expect(row.hidden, `${row.source}/${row.form}`).toBe(true);
          expect(row.filenames, `${row.source}/${row.form}`).toBe(true);
          expect(row.jsonPrivate, `${row.source}/${row.form}`).toBe(true);
          expect(row.registryUnchanged, `${row.source}/${row.form}`).toBe(true);
        }
        expect(observed.masking.at(-1)?.displayEscaped).toBe(true);
      }
    },
  );

  it.each([
    ["invalid", "invalid-profile"],
    ["missing-credential", "missing-primary-credential"],
  ])("keeps %s outside the private locator path", async (which, reason) => {
    const observed = await observeIsolatedLocator(which);
    expect(observed.reason).toBe(reason);
    expect(observed.locatorExists).toBe(false);
    expect(observed.credentialIo).toEqual([]);
    expect(observed.hostLimitIo).toEqual([]);
    expect(observed.rootValidationStats).toBe(0);
    expect(observed.registryUnchanged).toBe(true);
    expect(observed.fileGloballyRegistered).toBe(false);
    expect(observed.directoryGloballyRegistered).toBe(false);
    expect(observed.providerCalls).toBe(0);
  });
});
