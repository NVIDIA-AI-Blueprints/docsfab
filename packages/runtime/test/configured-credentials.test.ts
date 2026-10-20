// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const credentialIo = vi.hoisted(() => [] as Array<{ operation: string; path: string }>);
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      credentialIo.push({ operation: "stat", path: String(args[0]) });
      return actual.statSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      credentialIo.push({ operation: "read", path: String(args[0]) });
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      credentialIo.push({ operation: "list", path: String(args[0]) });
      return actual.readdirSync(...args);
    },
  };
});

import { limit } from "../src/config/limits.js";
import { SECRET_ENV_KEYS } from "../src/config/profile-projection.js";
import {
  loadModelConfigurations,
  localMissingModelProfileLocator,
  ModelProfileMigrationError,
} from "../src/model/configuration.js";
import {
  type ConfiguredCredentialMatch,
  configuredCredentialInventory,
  containsConfiguredCredential,
  createConfiguredCredentialRegistry,
  describeConfiguredCredentialMatch,
  findConfiguredCredential,
  isConfiguredCredentialFileName,
  isConfiguredCredentialName,
  redactConfiguredCredentials,
  redactDirectConfiguredCredentials,
  refreshConfiguredCredentials,
  registerConfiguredCredential,
} from "../src/security/configured-credentials.js";
import { detectCredentialRuleIds } from "../src/security/repository-scanner.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";

const MIN_CHARS = limit("secrets.configuredCredentialMinChars").value;
const PIECE_CHARS = limit("secrets.configuredCredentialFragmentChars").value;

// Obviously fake values, assembled from words so no source line holds a
// credential-shaped literal.
/** A configured value that deliberately does not look like a credential. */
const PLAIN = ["fixture", "orchard", "lamp", "quietly", "hums"].join("-");
/** Every piece of the piece length holds a character that URL encoding changes. */
const RESERVED = ["fixture", "a+b", "c+d", "e+f", "g+h", "i+j", "k+l"].join("/");
/** Every piece of the piece length holds a character that JSON escaping changes. */
const QUOTED = ['fixture"orchard', 'lamp"quiet', "hums"].join("\\");
/** Its base64 holds `/`, so the URL-safe form differs from the standard one. */
const SLASHED = ["fixture", "???", ">>>", "orchard", "???", ">>>", "lamp"].join("");

function registryWith(variables: NodeJS.ProcessEnv) {
  return createConfiguredCredentialRegistry({ environment: () => variables });
}

describe("configured credentials", () => {
  const roots = temporaryRoots();

  afterEach(() => {
    vi.unstubAllEnvs();
    credentialIo.splice(0);
  });

  it("screens only canonical direct/proxy/webhook sources in every supported whole form", () => {
    const secret = ['inert"direct', "proxy", "password"].join(" ");
    const ordinaryUser = "ordinary-proxy-user";
    const sources = [
      { SCM_TOKEN: secret },
      ...["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"].map((name) => ({
        [name]: `http://${ordinaryUser}:${encodeURIComponent(secret)}@proxy.example.invalid`,
      })),
      { HTTPS_PROXY: `http://${encodeURIComponent(secret)}@proxy.example.invalid` },
      { HTTPS_PROXY: `http://${encodeURIComponent(secret)}:x@proxy.example.invalid` },
    ];
    const forms = [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(secret).toLowerCase(),
      JSON.stringify(secret).slice(1, -1),
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
    ];
    for (const [sourceIndex, environment] of sources.entries()) {
      for (const [formIndex, form] of forms.entries()) {
        expect(
          redactDirectConfiguredCredentials(`root/${form}`, environment).includes(form),
          `direct source ${sourceIndex}, whole form ${formIndex}`,
        ).toBe(false);
      }
    }
    const proxy = {
      HTTPS_PROXY: `http://${ordinaryUser}:${encodeURIComponent(secret)}@proxy.example.invalid`,
    };
    expect(redactDirectConfiguredCredentials(`root/${ordinaryUser}`, proxy)).toBe(
      `root/${ordinaryUser}`,
    );
    expect(
      redactDirectConfiguredCredentials("root/x", {
        HTTPS_PROXY: `http://${encodeURIComponent(secret)}:x@proxy.example.invalid`,
      }),
    ).toBe("root/x");
    const segment = ["inert", "webhook", "secret", "segment"].join("-");
    const webhook = {
      DOCSFAB_SLACK_WEBHOOK_URL: `https://hooks.example.invalid/public/workspace/${segment}`,
    };
    for (const form of [
      segment,
      Buffer.from(segment).toString("base64"),
      encodeURIComponent(segment),
    ]) {
      expect(redactDirectConfiguredCredentials(`root/${form}`, webhook).includes(form)).toBe(false);
    }
    expect(redactDirectConfiguredCredentials("root/public/workspace", webhook)).toBe(
      "root/public/workspace",
    );
    expect(
      redactDirectConfiguredCredentials("root/safe", { HTTPS_PROXY: "malformed proxy setting" }),
    ).toBe("root/safe");
  });

  it("screens whole short/low-diversity forms without changing global minimums or matching shorter fragments", () => {
    for (const secret of ['q" z', "qz", "q z", "ÿ?", "xxxx"]) {
      const environments = [
        { SCM_TOKEN: secret },
        { HTTPS_PROXY: `http://${encodeURIComponent(secret)}@proxy.example.invalid` },
        { HTTPS_PROXY: `http://${encodeURIComponent(secret)}:x@proxy.example.invalid` },
        { http_proxy: `http://:${encodeURIComponent(secret)}@proxy.example.invalid` },
      ];
      const forms = [
        secret,
        encodeURIComponent(secret),
        encodeURIComponent(secret).toLowerCase(),
        JSON.stringify(secret).slice(1, -1),
        Buffer.from(secret).toString("base64"),
        Buffer.from(secret).toString("base64url"),
      ];
      for (const environment of environments) {
        for (const form of forms) {
          expect(registryWith(environment).find(form)).toBeNull();
          expect(
            redactDirectConfiguredCredentials(`root/${form}`, environment).includes(form),
          ).toBe(false);
          expect(registryWith(environment).find(form)).toBeNull();
        }
      }
    }
    const longerShort = "q z A";
    const partialBase64 = Buffer.from(longerShort.slice(0, -2)).toString("base64");
    expect(
      redactDirectConfiguredCredentials(`root/${partialBase64}`, { SCM_TOKEN: longerShort }),
    ).toBe(`root/${partialBase64}`);
  });

  it("keeps diagnostic direct matching off the host limits file while ordinary registries read it", async () => {
    const root = await roots.create("docsfab-direct-limits-io-");
    const service = join(root, "owned-service.env");
    await writeFile(service, "# Harmless owned matching-policy sentinel.\n");
    const environment = { DOCSFAB_SERVICE_ENV_FILE: service, SCM_TOKEN: PLAIN };
    credentialIo.splice(0);
    expect(redactDirectConfiguredCredentials(`root/${PLAIN}`, environment)).toBe("root/[REDACTED]");
    expect(credentialIo.some(({ path }) => path === service)).toBe(false);
    // The general registry retains its existing explicitly selected file policy.
    expect(registryWith(environment).redact(PLAIN)).toBe("[REDACTED]");
    expect(
      credentialIo.some(({ operation, path }) => operation === "read" && path === service),
    ).toBe(true);
  });

  it("does not discover credential files/directories or register supplied values globally", async () => {
    const root = await roots.create("docsfab-direct-credential-io-");
    const tokenFile = join(root, "owned-token");
    const directory = join(root, "owned-systemd");
    await mkdir(directory);
    const fileSecret = ["inert", "file", "only", "material"].join("-");
    const directSecret = ["inert", "transient", "only", "material"].join("-");
    await writeFile(tokenFile, fileSecret);
    await writeFile(join(directory, "owned-secret"), fileSecret);
    const environment = {
      SCM_TOKEN: directSecret,
      SCM_TOKEN_FILE: tokenFile,
      CREDENTIALS_DIRECTORY: directory,
    };
    credentialIo.splice(0);
    expect(
      redactDirectConfiguredCredentials(`root/${directSecret}`, environment).includes(directSecret),
    ).toBe(false);
    expect(redactDirectConfiguredCredentials(`root/${fileSecret}`, environment)).toBe(
      `root/${fileSecret}`,
    );
    let failure: unknown;
    try {
      loadModelConfigurations({ ...environment, DOCSFAB_CONFIG_ROOT: join(root, "safe-root") });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    expect(localMissingModelProfileLocator(failure)?.join("\n")).toContain("safe-root");
    expect(JSON.stringify(failure).includes(directSecret)).toBe(false);
    expect(credentialIo.some(({ path }) => path === tokenFile || path.startsWith(directory))).toBe(
      false,
    );
    expect(findConfiguredCredential(directSecret)).toBeNull();
    // The same observation hook sees the existing public registry's permitted file reads.
    expect(registryWith(environment).redact(fileSecret).includes(fileSecret)).toBe(false);
    expect(
      credentialIo.some(({ operation, path }) => operation === "read" && path === tokenFile),
    ).toBe(true);
    expect(
      credentialIo.some(({ operation, path }) => operation === "list" && path === directory),
    ).toBe(true);
  });

  it("matches a configured value that does not look like a credential, and no unconfigured credential shape", () => {
    const registry = registryWith({ DOCSFAB_FIXTURE_API_KEY: PLAIN });
    const text = `The setup page says ${PLAIN} once.`;
    expect(detectCredentialRuleIds(text)).toEqual([]);
    expect(registry.find(text)).toEqual({
      source: "environment variable DOCSFAB_FIXTURE_API_KEY",
      form: "value",
      index: text.indexOf(PLAIN),
    });
    const shaped = `api_key = "${plantedCredentialValue(11, 32)}"`;
    expect(detectCredentialRuleIds(shaped)).not.toEqual([]);
    expect(registry.find(shaped)).toBeNull();
    expect(registry.find(PLAIN.replaceAll("-", " "))).toBeNull();
  });

  it("matches a piece of the piece length and not one character shorter", () => {
    const registry = registryWith({ DOCSFAB_FIXTURE_TOKEN: PLAIN });
    const piece = PLAIN.slice(3, 3 + PIECE_CHARS);
    expect(registry.find(`bad key ${piece}...`)).toEqual({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "fragment",
      index: "bad key ".length,
    });
    expect(registry.find(`bad key ${piece.slice(0, -1)}...`)).toBeNull();
    // The first and the last piece, as a truncated or masked echo shows them.
    const first = PLAIN.slice(0, PIECE_CHARS);
    const last = PLAIN.slice(-PIECE_CHARS);
    expect(registry.find(`key ${first}**** was refused`)).toMatchObject({ form: "fragment" });
    expect(registry.find(`key ****${last} was refused`)).toMatchObject({ form: "fragment" });
  });

  it("matches the URL-encoded and JSON-escaped forms", () => {
    const registry = registryWith({
      DOCSFAB_FIXTURE_SECRET: RESERVED,
      DOCSFAB_FIXTURE_PASSWORD: QUOTED,
    });
    const encoded = encodeURIComponent(RESERVED);
    const lowercase = encoded.replace(/%[0-9A-F]{2}/gu, (hex) => hex.toLowerCase());
    expect(encoded).not.toBe(lowercase);
    for (const form of [encoded, lowercase]) {
      expect(registry.find(`https://example.invalid/?key=${form}&page=1`)).toMatchObject({
        source: "environment variable DOCSFAB_FIXTURE_SECRET",
        form: "url-encoded",
      });
    }
    expect(registry.find(JSON.stringify({ note: QUOTED }))).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_PASSWORD",
      form: "json-escaped",
    });
  });

  it("matches the standard and URL-safe base64 forms at every byte alignment", () => {
    const registry = registryWith({
      DOCSFAB_FIXTURE_TOKEN: PLAIN,
      DOCSFAB_FIXTURE_SECRET: SLASHED,
    });
    for (const prefix of ["", "a", "ab"]) {
      for (const suffix of ["", "c", "cd"]) {
        const encoded = Buffer.from(`${prefix}${PLAIN}${suffix}`).toString("base64");
        expect(registry.find(`Basic ${encoded}`), `${prefix}|${suffix}`).toMatchObject({
          source: "environment variable DOCSFAB_FIXTURE_TOKEN",
          form: "base64",
        });
      }
    }
    const standard = Buffer.from(SLASHED).toString("base64");
    const urlSafe = Buffer.from(SLASHED).toString("base64url");
    expect(standard).toContain("/");
    expect(registry.find(standard)).toMatchObject({ form: "base64" });
    expect(registry.find(urlSafe)).toMatchObject({ form: "base64url" });
  });

  it("loads credential files, a JSON credential map, and systemd credentials", async () => {
    const root = await roots.create("docsfab-configured-credentials-");
    const tokenFile = join(root, "slack-bot-token");
    await writeFile(tokenFile, `${PLAIN}\n`);
    const mapValue = ["fixture", "map", "value", "orchard"].join("-");
    const mapFile = join(root, "model-credentials.json");
    await writeFile(
      mapFile,
      JSON.stringify({ schemaVersion: 1, credentials: { "nvidia-api-catalog": mapValue } }),
    );
    const clientSecret = ["fixture", "client", "secret", "orchard"].join("-");
    const accountFile = join(root, "account.json");
    await writeFile(
      accountFile,
      JSON.stringify({
        type: "service_account",
        token_uri: "https://oauth2.example.invalid/token",
        client_secret: clientSecret,
      }),
    );
    const systemd = join(root, "credentials");
    await mkdir(systemd);
    const systemdValue = ["fixture", "systemd", "value", "orchard"].join("-");
    await writeFile(join(systemd, "gitlab-review-note-credential"), systemdValue);
    const oversized = join(root, "oversized");
    await writeFile(oversized, "x".repeat(limit("authority.credentialFileBytes").value + 1));
    const registry = registryWith({
      DOCSFAB_SLACK_BOT_TOKEN_FILE: tokenFile,
      DOCSFAB_MODEL_PROVIDER_CREDENTIAL_FILE: mapFile,
      DOCSFAB_FIXTURE_CREDENTIALS_FILE: accountFile,
      DOCSFAB_MISSING_TOKEN_FILE: join(root, "missing"),
      DOCSFAB_OVERSIZED_SECRET_FILE: oversized,
      CREDENTIALS_DIRECTORY: systemd,
    });
    expect(registry.find(`x ${PLAIN}`)?.source).toBe(
      "credential file named by DOCSFAB_SLACK_BOT_TOKEN_FILE",
    );
    expect(registry.find(`x ${mapValue}`)?.source).toBe(
      "credential file named by DOCSFAB_MODEL_PROVIDER_CREDENTIAL_FILE",
    );
    expect(registry.find(`x ${clientSecret}`)?.source).toBe(
      "credential file named by DOCSFAB_FIXTURE_CREDENTIALS_FILE",
    );
    expect(registry.find(`x ${systemdValue}`)?.source).toBe(
      "systemd credential gitlab-review-note-credential",
    );
    // The structure around a credential is not a credential.
    expect(
      registry.find(
        '{"schemaVersion": 1, "credentials": {"nvidia-api-catalog": ""}, "type": "service_account", "token_uri": "https://oauth2.example.invalid/token"}',
      ),
    ).toBeNull();
    expect(registry.inventory()).toEqual([
      { source: "credential file named by DOCSFAB_FIXTURE_CREDENTIALS_FILE", status: "screened" },
      { source: "credential file named by DOCSFAB_MISSING_TOKEN_FILE", status: "unreadable" },
      {
        source: "credential file named by DOCSFAB_MODEL_PROVIDER_CREDENTIAL_FILE",
        status: "screened",
      },
      {
        source: "credential file named by DOCSFAB_OVERSIZED_SECRET_FILE",
        status: "over-read-bound",
      },
      { source: "credential file named by DOCSFAB_SLACK_BOT_TOKEN_FILE", status: "screened" },
      { source: "systemd credential gitlab-review-note-credential", status: "screened" },
    ]);
  });

  it("takes no piece from a PEM header, a URL host, or a JWT header", () => {
    const header = ["-----BEGIN", "FIXTURE", "PRIVATE", "KEY-----"].join(" ");
    const pem = [header, plantedCredentialValue(21, 64), header.replace("BEGIN", "END")].join("\n");
    const url = `https://fixture-user:${PLAIN}@docs.example.invalid/orchard/path`;
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwtHeader = segment({ alg: "HS256", typ: "JWT" });
    const signature = plantedCredentialValue(31, 43);
    const jwt = [jwtHeader, segment({ fixture: "orchard" }), signature].join(".");
    const registry = registryWith({
      DOCSFAB_FIXTURE_PRIVATE_KEY: pem,
      DOCSFAB_FIXTURE_TOKEN: url,
      DOCSFAB_FIXTURE_ID_TOKEN: jwt,
    });
    expect(registry.find(`An example key starts with ${header}.`)).toBeNull();
    expect(
      registry.find("Clone https://docs.example.invalid/orchard/path as fixture-user."),
    ).toBeNull();
    const otherJwt = [jwtHeader, segment({ sample: true }), plantedCredentialValue(41, 43)].join(
      ".",
    );
    expect(registry.find(`Example: ${otherJwt}`)).toBeNull();
    // The secret parts still match.
    expect(registry.find(`---\n${pem}\n---`)).toMatchObject({ form: "value" });
    expect(registry.find(`password ${PLAIN} only`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "value",
    });
    expect(registry.find(signature.slice(4, 4 + PIECE_CHARS))).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_ID_TOKEN",
      form: "fragment",
    });
    expect(registry.find(` ${jwt} `)).toMatchObject({ form: "value" });
  });

  it("takes a URL's user name when it has no password, as in a token-only clone URL", () => {
    const token = plantedCredentialValue(22, 24);
    const registry = registryWith({
      DOCSFAB_FIXTURE_TOKEN: `https://${token}@gitlab.example.invalid/group/repo.git`,
    });
    expect(registry.find(`git pushes as ${token} here`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "value",
    });
    // With a password, the user name is a name and the password is the secret.
    const withPassword = registryWith({
      DOCSFAB_FIXTURE_TOKEN: `https://fixture-user-orchard:${token}@gitlab.example.invalid/`,
    });
    expect(withPassword.find("signed in as fixture-user-orchard today")).toBeNull();
    expect(withPassword.find(`x ${token} y`)).toMatchObject({ form: "value" });
  });

  it("takes a proxy URL's password in either case, its user name only without one, and not the proxy", () => {
    const user = ["fixture", "proxy", "orchard"].join("-");
    const password = plantedCredentialValue(23, 24);
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      const registry = registryWith({
        [name]: `http://${user}:${encodeURIComponent(password)}@proxy.example.invalid:3128`,
      });
      expect(registry.find(`the password ${password} signs in`), name).toMatchObject({
        source: `the proxy password in environment variable ${name}`,
        form: "value",
      });
      // Beside a password the user name is a name, such as a CODEOWNERS entry.
      expect(registry.find(`docs/ @${user}`), name).toBeNull();
      expect(registry.find("Set http://proxy.example.invalid:3128 as the proxy."), name).toBeNull();
      expect(registry.inventory(), name).toEqual([
        { source: `the proxy password in environment variable ${name}`, status: "screened" },
      ]);
    }
    // A token-only proxy URL carries its secret in the user name, and so does
    // one whose password is a placeholder too short to compare.
    const token = plantedCredentialValue(27, 32);
    for (const userinfo of [token, `${token}:x`, `${token}:X`, `${token}:unused`]) {
      const registry = registryWith({
        HTTPS_PROXY: `http://${userinfo}@proxy.example.invalid:3128`,
      });
      expect(
        registry.find(`the token ${token} signs in`),
        userinfo.slice(token.length),
      ).toMatchObject({
        source: "the proxy user name in environment variable HTTPS_PROXY",
        form: "value",
      });
    }
    // A longer placeholder is compared, so it is taken as the credential and
    // the user name is not; docs/about/security.md names this case.
    const longPlaceholder = registryWith({
      HTTPS_PROXY: `http://${token}:x-oauth-basic@proxy.example.invalid:3128`,
    });
    expect(longPlaceholder.find(`the token ${token} signs in`)).toBeNull();
    expect(longPlaceholder.find("auth x-oauth-basic here")).toMatchObject({
      source: "the proxy password in environment variable HTTPS_PROXY",
    });
    expect(registryWith({ HTTPS_PROXY: "http://proxy.example.invalid:3128" }).inventory()).toEqual(
      [],
    );
  });

  it("decodes a percent-encoded proxy password and matches it raw and encoded", () => {
    const reserved = [plantedCredentialValue(28, 12), "/+@:", plantedCredentialValue(29, 12)].join(
      "",
    );
    const encoded = encodeURIComponent(reserved);
    expect(encoded).not.toBe(reserved);
    const registry = registryWith({
      HTTPS_PROXY: `http://fixture-user:${encoded}@proxy.example.invalid:3128`,
    });
    expect(registry.find(`raw ${reserved} here`)).toMatchObject({
      source: "the proxy password in environment variable HTTPS_PROXY",
      form: "value",
    });
    expect(registry.find(`encoded ${encoded} here`)).toMatchObject({
      source: "the proxy password in environment variable HTTPS_PROXY",
      form: "url-encoded",
    });
  });

  it("takes a webhook URL whole, and its secret last segment and pieces of it, but no piece of the rest", () => {
    const workspace = ["services", plantedCredentialValue(24, 9), plantedCredentialValue(25, 11)];
    const secret = plantedCredentialValue(26, 24);
    const path = [...workspace, secret].join("/");
    const url = `https://hooks.example.invalid/${path}`;
    expect(isConfiguredCredentialName("DOCSFAB_SLACK_WEBHOOK_URL")).toBe(true);
    const registry = registryWith({ DOCSFAB_SLACK_WEBHOOK_URL: url });
    expect(registry.find(`posted to ${url} today`)).toMatchObject({
      source: "environment variable DOCSFAB_SLACK_WEBHOOK_URL",
      form: "value",
    });
    expect(registry.find(`the path /${path} only`)).toMatchObject({
      source: "environment variable DOCSFAB_SLACK_WEBHOOK_URL",
    });
    expect(registry.find(`the secret ${secret} alone`)).toMatchObject({
      source: "environment variable DOCSFAB_SLACK_WEBHOOK_URL",
      form: "value",
    });
    expect(registry.find(`its tail ${path.slice(-PIECE_CHARS - 2)}`)).toMatchObject({
      form: "fragment",
    });
    // The same workspace's webhook with a placeholder secret holds no secret.
    const placeholder = "X".repeat(secret.length);
    expect(
      registry.find(
        `Post to https://hooks.example.invalid/${[...workspace, placeholder].join("/")} as documented.`,
      ),
    ).toBeNull();
    expect(registry.find(`The bot path is /${workspace.join("/")}/.`)).toBeNull();
    expect(
      registry.find("Post to https://hooks.example.invalid/services/ as documented."),
    ).toBeNull();
  });

  it("compares a value at the minimum length, ignores a shorter one, and reports both", () => {
    const atMinimum = PLAIN.slice(0, MIN_CHARS);
    const belowMinimum = ["short", "orchard"].join("-").slice(0, MIN_CHARS - 1);
    const registry = registryWith({
      DOCSFAB_FIXTURE_TOKEN: atMinimum,
      DOCSFAB_SHORT_TOKEN: belowMinimum,
      DOCSFAB_EMPTY_TOKEN: "",
    });
    expect(registry.find(`a ${atMinimum} b`)).toMatchObject({ form: "value" });
    expect(registry.find(`a ${belowMinimum} b`)).toBeNull();
    expect(registry.inventory()).toEqual([
      { source: "environment variable DOCSFAB_EMPTY_TOKEN", status: "empty" },
      { source: "environment variable DOCSFAB_FIXTURE_TOKEN", status: "screened" },
      { source: "environment variable DOCSFAB_SHORT_TOKEN", status: "shorter-than-minimum" },
    ]);
  });

  it("compares no mask or run of repeated characters, as a value or as a piece", () => {
    const token = `glpat-${"a".repeat(24)}`;
    const registry = registryWith({
      DOCSFAB_MASK_TOKEN: "x".repeat(24),
      DOCSFAB_ALTERNATING_TOKEN: "ab".repeat(12),
      DOCSFAB_FIXTURE_TOKEN: token,
    });
    // A mask in documentation, and a digest of one repeated letter, match nothing.
    expect(
      registry.find(`sk-${"x".repeat(32)} and ${"a".repeat(64)} and ${"ab".repeat(20)}`),
    ).toBeNull();
    // The configured token itself still matches whole.
    expect(registry.find(`x ${token} y`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "value",
    });
    expect(registry.inventory()).toEqual([
      {
        source: "environment variable DOCSFAB_ALTERNATING_TOKEN",
        status: "too-few-distinct-characters",
      },
      { source: "environment variable DOCSFAB_FIXTURE_TOKEN", status: "screened" },
      { source: "environment variable DOCSFAB_MASK_TOKEN", status: "too-few-distinct-characters" },
    ]);
  });

  it("follows a changed environment", () => {
    const variables: NodeJS.ProcessEnv = { DOCSFAB_FIXTURE_TOKEN: PLAIN };
    const registry = registryWith(variables);
    expect(registry.find(PLAIN)).not.toBeNull();
    variables.DOCSFAB_FIXTURE_TOKEN = RESERVED;
    expect(registry.find(PLAIN)).toBeNull();
    expect(registry.find(RESERVED)).not.toBeNull();
  });

  it("keeps a registered value and names its loader", async () => {
    const root = await roots.create("docsfab-configured-credentials-");
    const registry = registryWith({});
    expect(registry.register(` ${PLAIN}\n`, "the hosted model credential")).toBe("screened");
    expect(registry.register("short", "a short loader value")).toBe("shorter-than-minimum");
    expect(registry.registerFile(join(root, "missing"), "a missing loader file")).toBe(
      "unreadable",
    );
    const file = join(root, "token");
    await writeFile(file, `${RESERVED}\n`);
    expect(registry.registerFile(file, "a loader file")).toBe("screened");
    expect(registry.find(`x ${PLAIN}`)).toMatchObject({
      source: "the hosted model credential",
      form: "value",
    });
    expect(registry.find(`x ${RESERVED}`)).toMatchObject({ source: "a loader file" });
    expect(registry.inventory()).toEqual([
      { source: "the hosted model credential", status: "screened" },
      { source: "a short loader value", status: "shorter-than-minimum" },
      { source: "a missing loader file", status: "unreadable" },
      { source: "a loader file", status: "screened" },
    ]);
  });

  it("finds a configured value in any string, key, or byte array of a structured value", () => {
    const registry = registryWith({ DOCSFAB_FIXTURE_TOKEN: PLAIN });
    const cyclic: Record<string, unknown> = {
      messages: [{ role: "user", content: `see ${PLAIN}` }],
    };
    cyclic.self = cyclic;
    expect(registry.findInValue(cyclic)).toMatchObject({ form: "value" });
    expect(registry.findInValue({ [PLAIN]: 1 })).toMatchObject({ form: "value" });
    expect(registry.findInValue({ bytes: new TextEncoder().encode(`x ${PLAIN}`) })).toMatchObject({
      form: "value",
    });
    const clean: Record<string, unknown> = { messages: [{ content: "nothing configured" }] };
    clean.self = clean;
    expect(registry.findInValue(clean)).toBeNull();
  });

  it("redacts every form and piece and keeps the text around them", () => {
    const registry = registryWith({
      DOCSFAB_FIXTURE_TOKEN: PLAIN,
      DOCSFAB_FIXTURE_SECRET: RESERVED,
    });
    const piece = PLAIN.slice(2, 2 + PIECE_CHARS);
    const text = `a ${PLAIN} b ${encodeURIComponent(RESERVED)} c ${piece} d ${PLAIN}${PLAIN}`;
    expect(registry.redact(text)).toBe("a [REDACTED] b [REDACTED] c [REDACTED] d [REDACTED]");
    expect(registry.redact("nothing configured")).toBe("nothing configured");
  });

  it("names the source and the form, never the value", () => {
    const registry = registryWith({ DOCSFAB_FIXTURE_TOKEN: PLAIN });
    const match = registry.find(
      `x ${PLAIN.slice(1, 1 + PIECE_CHARS)}`,
    ) as ConfiguredCredentialMatch;
    expect(describeConfiguredCredentialMatch(match)).toBe(
      "part of the configured credential from environment variable DOCSFAB_FIXTURE_TOKEN",
    );
    const surfaces = [
      JSON.stringify(match),
      describeConfiguredCredentialMatch(match),
      JSON.stringify(registry.inventory()),
      inspect(registry, { depth: null, showHidden: true }),
    ];
    const pieces = PLAIN.split("-").filter((word) => word.length > 3);
    for (const surface of surfaces) {
      for (const word of pieces) expect(surface).not.toContain(word);
    }
  });

  it("treats every model key and SCM token variable as a credential, and not settings that mention one", () => {
    const credentials = [
      ...SECRET_ENV_KEYS,
      "GITLAB_TOKEN",
      "GLAB_TOKEN",
      "CI_JOB_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "SLACK_SIGNING_SECRET",
      "DB_PASSWORD",
    ];
    for (const name of credentials) expect(isConfiguredCredentialName(name), name).toBe(true);
    const settings = [
      "DOCSFAB_STATE_DIR",
      "MODEL_BASE_URL",
      "MODEL_MAX_OUTPUT_TOKENS",
      "AWS_ACCESS_KEY_ID",
      "TOKEN_URI",
      "CREDENTIALS_DIRECTORY",
      "DOCSFAB_SLACK_BOT_TOKEN_FILE",
    ];
    for (const name of settings) expect(isConfiguredCredentialName(name), name).toBe(false);
    const files = [
      "DOCSFAB_SLACK_BOT_TOKEN_FILE",
      "DOCSFAB_SLACK_APP_TOKEN_FILE",
      "DOCSFAB_MODEL_PROVIDER_CREDENTIAL_FILE",
      "POSTGRES_PASSWORD_FILE",
    ];
    for (const name of files) expect(isConfiguredCredentialFileName(name), name).toBe(true);
    const otherFiles = [
      "CI_SERVER_TLS_CA_FILE",
      "DOCSFAB_COMPONENT_STATUS_FILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ];
    for (const name of otherFiles) expect(isConfiguredCredentialFileName(name), name).toBe(false);
  });

  it("reads the process environment and keeps registered values for the process", () => {
    vi.stubEnv("DOCSFAB_FIXTURE_PROCESS_TOKEN", PLAIN);
    refreshConfiguredCredentials();
    expect(findConfiguredCredential(`x ${PLAIN}`)).toMatchObject({
      source: "environment variable DOCSFAB_FIXTURE_PROCESS_TOKEN",
      form: "value",
    });
    vi.unstubAllEnvs();
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(`x ${PLAIN}`)).toBe(false);
    const loaderValue = ["fixture", "loader", "orchard", "lamp"].join("-");
    expect(registerConfiguredCredential(loaderValue, "a test loader")).toBe("screened");
    expect(findConfiguredCredential(`x ${loaderValue}`)).toMatchObject({ source: "a test loader" });
    expect(redactConfiguredCredentials(`x ${loaderValue} y`)).toBe("x [REDACTED] y");
    expect(configuredCredentialInventory()).toContainEqual({
      source: "a test loader",
      status: "screened",
    });
  });

  it("reuses one process environment reading until the next microtask, unless refreshed", async () => {
    const before = ["fixture", "turn", "orchard", "lamp"].join("-");
    const after = ["fixture", "later", "orchard", "lamp"].join("-");
    vi.stubEnv("DOCSFAB_FIXTURE_TURN_TOKEN", before);
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(`x ${before}`)).toBe(true);
    process.env.DOCSFAB_FIXTURE_TURN_TOKEN = after;
    // The same turn keeps its reading, so a loop of checks reads the
    // environment once.
    expect(containsConfiguredCredential(`x ${after}`)).toBe(false);
    refreshConfiguredCredentials();
    expect(containsConfiguredCredential(`x ${after}`)).toBe(true);
    process.env.DOCSFAB_FIXTURE_TURN_TOKEN = before;
    // After a microtask the next check reads it again without a refresh, even
    // under a fake clock.
    vi.useFakeTimers();
    await Promise.resolve();
    expect(containsConfiguredCredential(`x ${before}`)).toBe(true);
    expect(containsConfiguredCredential(`x ${after}`)).toBe(false);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    refreshConfiguredCredentials();
  });

  it("shares registered values between module instances, and keeps a private registry apart", async () => {
    const value = ["fixture", "instance", "orchard", "lamp"].join("-");
    vi.resetModules();
    const other = await import("../src/security/configured-credentials.js");
    expect(other.findConfiguredCredential).not.toBe(findConfiguredCredential);
    expect(other.registerConfiguredCredential(value, "a loader in another module instance")).toBe(
      "screened",
    );
    expect(findConfiguredCredential(`x ${value}`)).toMatchObject({
      source: "a loader in another module instance",
    });
    expect(registryWith({}).find(`x ${value}`)).toBeNull();
    expect(inspect(globalThis, { depth: 1 })).not.toContain(value);
  });

  it("ends every module instance's reading when any instance refreshes", async () => {
    const value = ["fixture", "refresh", "orchard", "lamp"].join("-");
    vi.resetModules();
    const other = await import("../src/security/configured-credentials.js");
    expect(other.containsConfiguredCredential(`x ${value}`)).toBe(false);
    expect(containsConfiguredCredential(`x ${value}`)).toBe(false);
    vi.stubEnv("DOCSFAB_FIXTURE_SHARED_REFRESH_TOKEN", value);
    refreshConfiguredCredentials();
    // The same turn: the other instance read the environment above, and the
    // refresh through this instance ends that reading too.
    expect(other.containsConfiguredCredential(`x ${value}`)).toBe(true);
    vi.unstubAllEnvs();
    refreshConfiguredCredentials();
    expect(other.containsConfiguredCredential(`x ${value}`)).toBe(false);
  });

  it("finds a value after a long text outside ASCII", () => {
    const registry = registryWith({ DOCSFAB_FIXTURE_TOKEN: PLAIN });
    const filler = "Ünïcödé 🙂 text, ".repeat(100_000);
    expect(registry.find(filler)).toBeNull();
    expect(registry.find(`${filler}${PLAIN}`)).toEqual({
      source: "environment variable DOCSFAB_FIXTURE_TOKEN",
      form: "value",
      index: filler.length,
    });
  });
});
