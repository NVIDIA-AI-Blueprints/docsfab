// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  requiredSecretNamesForExecutionProfile,
  resolveSetupExecutionProfile,
  retiredModelSelectionRefusal,
} from "../config/execution-profile.js";
import { parseDotenvAssignments } from "../config/dotenv.js";
import { ensureDocsFabConfigurationRoot } from "../config/host-paths.js";
import { providerRequestUrl } from "../config/model-providers.js";
import {
  DEFAULT_PURPOSE_SLOT_QUALIFICATION,
  defaultExecutionHostConfig,
  defaultHostConfig,
  decodeHostConfig,
  decodeModelProfile,
  resolveHostExecutionProfileId,
  resolveHostYamlPolicyProfile,
  SECRET_ENV_KEYS,
  type DocsFabHostConfigV1,
} from "../config/profile-projection.js";
import {
  commitConfigurationRootChange,
  migrateMonolithicEnvToSplitLayout,
  resolveHostConfigPath,
  resolveSecretsEnvPath,
  resolveProfilePath,
  resolveSecretsEnvLockLimits,
  SECRETS_ENV_FILE,
  usesSplitLayout,
  type ConfigurationRootChange,
  type SecretsEnvChange,
} from "../config/split-layout.js";
import { loadConfig, type DocsFabConfig } from "../config/runtime-loader.js";
import { ModelProfileMigrationError } from "../model/configuration.js";
import { resolveOperatorExecutionBinding } from "../model/operator-execution-binding.js";
import {
  presentResult,
  readPresentationEnvironmentFacts,
  renderPresentation,
  resolvePresentationCapabilities,
  type PresentationDocument,
  type PresentationField,
  type PresentationOptions,
} from "../operator/index.js";
import { SETUP_MODEL_CHOICES, SetupModelChoiceRequiredError } from "./model-choice.js";
import {
  assertRawModelIdNotRetired,
  gpt5BringYourOwnWarning,
  isOtherGpt5ModelId,
} from "./retired-selections.js";
import { inspectLegacyPolicyProfileReadiness } from "./profile-readiness.js";
import {
  buildPolicyProfileFromEndpoint,
  buildPolicyProfileFromPreset,
  profileRelativePathFromModelId,
  resolvePresetProfilePath,
  resolveSetupPreset,
  type SetupModelEndpoint,
} from "./split-layout-presets.js";
import { parse as parseYaml } from "yaml";

export type SetupBootstrapStatus =
  | "ready"
  | "blocked-model-choice-required"
  | "blocked-missing-credential"
  | "blocked-invalid-profile"
  | "blocked-unapproved-profile";

export interface SetupBootstrapResult {
  schemaVersion: 1;
  kind: "docsfab-setup-bootstrap";
  status: SetupBootstrapStatus;
  configurationRoot: string;
  layout: "split" | "legacy";
  hostConfigPath?: string;
  secretsPath?: string;
  envPath: string;
  activePolicyProfile?: string;
  activeExecutionProfile?: string;
  requiredSecretNames?: readonly string[];
  seeded: boolean;
  migrated: boolean;
  credentialSource: "existing-env" | "ambient" | "none";
  profile?: {
    providerId: string;
    modelId: string;
    transport?: DocsFabConfig["model"]["transport"];
    endpointUrl?: string;
    requestUrl?: string;
    configuredContextWindow: number;
    effectiveContextWindow: number;
    effectiveLimitReason: DocsFabConfig["model"]["profile"]["effectiveLimitReason"];
    contextAdmission?: "host-window" | "provider";
  };
  nextCommand: string;
  explanation: string;
  /**
   * Visible, non-blocking warnings, such as a bring-your-own GPT-5.x model
   * outside the retired GPT-5.6 family (#1512). Absent when there are none.
   */
  warnings?: readonly string[];
}

type SetupBootstrapInput = Parameters<typeof runSetupBootstrapSelection>[0];

export async function runSetupBootstrap(
  input: SetupBootstrapInput = {},
): Promise<SetupBootstrapResult> {
  const result = await runSetupBootstrapSelection(input);
  // GPT-5.6 family ids are refused before any write; other GPT-5.x ids brought
  // through a provider option still run, with a visible warning (#1512).
  const modelId = input.model?.modelId;
  if (modelId === undefined || !isOtherGpt5ModelId(modelId)) return result;
  return { ...result, warnings: [...(result.warnings ?? []), gpt5BringYourOwnWarning(modelId)] };
}

async function runSetupBootstrapSelection(
  input: {
    preset?: string;
    profile?: string;
    model?: SetupModelEndpoint;
    migrate?: boolean;
    environment?: NodeJS.ProcessEnv;
    /**
     * 'setup' (the default) is explicit or interactive docsfab setup. It may
     * write host.yaml, profiles, and secrets.env, and it migrates a stored
     * credential into the split layout.
     *
     * 'startup-check' is a readiness check such as live-agent start. It never
     * writes secrets.env and never changes a root that already holds
     * configuration, so it cannot strand a credential stored in a root .env
     * behind a new host.yaml. A root with no model selection reports
     * blocked-model-choice-required instead of a refusal, so an interactive
     * caller can go on to ask for a provider.
     */
    purpose?: "setup" | "startup-check";
  } = {},
): Promise<SetupBootstrapResult> {
  const environment = input.environment ?? process.env;
  const startupCheck = input.purpose === "startup-check";

  if (
    startupCheck &&
    (input.preset !== undefined ||
      input.profile !== undefined ||
      input.model !== undefined ||
      input.migrate)
  ) {
    throw new Error("A startup readiness check cannot select or migrate a model configuration.");
  }
  const preset = resolveSetupPreset(input.preset);
  const profile = resolveSetupExecutionProfile(input.profile);
  // A provider selection naming a retired model refuses before any write.
  if (input.model) assertRawModelIdNotRetired(input.model.modelId);
  // Validate the full endpoint selection before touching any saved configuration.
  const endpointProfile = input.model ? buildPolicyProfileFromEndpoint(input.model) : undefined;
  const endpointSecretNames = endpointProfile?.credentialEnv
    ? [endpointProfile.credentialEnv]
    : undefined;
  if (endpointSecretNames && !environment[endpointSecretNames[0]!]?.trim()) {
    throw new Error(
      `Set ${endpointSecretNames[0]} or enter the API key through interactive setup before selecting this endpoint.`,
    );
  }
  if (preset !== undefined && profile !== undefined) {
    throw new Error("DocsFab setup accepts either --profile or --preset, not both.");
  }
  if (preset !== undefined && input.model !== undefined) {
    throw new Error(
      "DocsFab setup accepts either an installed preset or a model endpoint, not both.",
    );
  }
  if (profile !== undefined && input.model !== undefined) {
    throw new Error(
      "DocsFab setup accepts either an installed execution profile or a model endpoint, not both.",
    );
  }
  if (
    input.migrate &&
    (preset !== undefined || profile !== undefined || input.model !== undefined)
  ) {
    throw new Error("DocsFab setup migration cannot also select a new model endpoint.");
  }

  const configurationRoot = await ensureDocsFabConfigurationRoot(environment);
  // Refuse an invalid secrets lock override, from any tier doctor --limits
  // reads, before touching any configuration file.
  resolveSecretsEnvLockLimits(environment, configurationRoot);
  const envPath = resolve(configurationRoot, ".env");
  let seeded = false;
  let migrated = false;
  let activePolicyProfile: string | undefined;
  let activeExecutionProfile: string | undefined;

  // Only called for an explicit --preset or --model selection.
  const selectedProfilePath = (): string =>
    input.model
      ? profileRelativePathFromModelId(input.model.modelId)
      : resolvePresetProfilePath(requirePreset(preset));
  const selectedPolicyProfile = (): ReturnType<typeof buildPolicyProfileFromPreset> =>
    endpointProfile ? endpointProfile : buildPolicyProfileFromPreset(requirePreset(preset));

  if (input.migrate) {
    const migration = await migrateMonolithicEnvToSplitLayout(configurationRoot, { environment });
    migrated = true;
    activePolicyProfile = migration.policyRelative;
    return finalizeSetupResult({
      environment,
      configurationRoot,
      envPath,
      seeded,
      migrated,
      activePolicyProfile,
      credentialSource: resolveCredentialSource(environment, configurationRoot),
      migrationPaths: migration,
    });
  }

  if (profile !== undefined) {
    return selectExecutionProfile({
      environment,
      configurationRoot,
      envPath,
      profileId: profile,
    });
  }

  const split = usesSplitLayout(configurationRoot);
  if (split) {
    const existingHost = readHostConfig(configurationRoot);
    activeExecutionProfile = existingHost ? resolveHostExecutionProfileId(existingHost) : undefined;
    const yamlPath = existingHost ? resolveHostYamlPolicyProfile(existingHost) : undefined;
    const existingCredentialEnv =
      !input.model && !preset && yamlPath
        ? readProfileCredentialEnv(configurationRoot, yamlPath)
        : undefined;
    const configuredSplitHost = hasConfiguredSplitHost(configurationRoot);
    const retiredSelection =
      configuredSplitHost && existingHost
        ? hostSelectionRefusal(configurationRoot, existingHost)
        : undefined;
    if (retiredSelection && preset === undefined && input.model === undefined) {
      // A retired selection is not usable configuration, and bare setup has no
      // default to replace it with. Both purposes refuse it by name; the
      // refusal names the successor to select explicitly.
      throw retiredSelection;
    }
    // Rerunning setup with no --profile/--preset/--model against a host that
    // already has an active execution profile retains that composition. When
    // it has no YAML policy profile (a split execution-profile host), the
    // required credential names come from the active composition itself
    // rather than a policy profile file. That composition is just as much an
    // explicit, single-target selection as --profile or --model above: the
    // exact declared name is required, and MODEL_API_KEY is never treated as
    // a stand-in for a different declared name (see resolveCompositionCredential
    // in model/operator-execution-binding.ts and resolveSelectedCredential in
    // cli/run/composition-runtime.ts). If the active composition cannot be
    // resolved to its declared names, selection falls back to undefined below
    // rather than guessing, which keeps the generic-fallback check strict.
    const retainedExecutionProfile =
      preset === undefined && input.model === undefined && configuredSplitHost
        ? activeExecutionProfile
        : undefined;
    const executionProfileSecretNames = retainedExecutionProfile
      ? requiredSecretNamesForExecutionProfile(retainedExecutionProfile)
      : undefined;
    const selectedSecretNames =
      endpointSecretNames ??
      (existingCredentialEnv ? [existingCredentialEnv] : undefined) ??
      executionProfileSecretNames;
    const credentialSource = resolveCredentialSource(
      environment,
      configurationRoot,
      selectedSecretNames,
      selectedSecretNames !== undefined,
    );
    if (startupCheck && !configuredSplitHost) {
      // A startup check never rewrites an existing host.yaml; report it as found.
      return finalizeSetupResult({
        environment,
        configurationRoot,
        envPath,
        seeded,
        migrated,
        ...(existingHost && resolveHostYamlPolicyProfile(existingHost)
          ? { activePolicyProfile: resolveHostYamlPolicyProfile(existingHost) }
          : {}),
        ...(activeExecutionProfile ? { activeExecutionProfile } : {}),
        ...(selectedSecretNames ? { requiredSecretNames: selectedSecretNames } : {}),
        credentialSource,
      });
    }
    if (preset === undefined && input.model === undefined && !configuredSplitHost) {
      // Explicit setup with no option naming a model, on a split root with no
      // usable selection. The startup check returned above.
      throw new SetupModelChoiceRequiredError();
    }
    let change: ConfigurationRootChange = {};
    if (preset !== undefined || input.model !== undefined) {
      const policyProfilePath = selectedProfilePath();
      activePolicyProfile = policyProfilePath;
      activeExecutionProfile = undefined;
      change = {
        profiles: [[policyProfilePath, selectedPolicyProfile()]],
        host: (current) => {
          const host = current ?? defaultHostConfig(policyProfilePath);
          host.activePolicyProfile = policyProfilePath;
          delete host.activeExecutionProfile;
          delete host.compositionId;
          if (host.active) {
            host.active.writing = { qualification: DEFAULT_PURPOSE_SLOT_QUALIFICATION };
          }
          return host;
        },
      };
      seeded = true;
    } else {
      activePolicyProfile = resolveHostYamlPolicyProfile(existingHost!) ?? undefined;
      activeExecutionProfile = resolveHostExecutionProfileId(existingHost!);
    }

    // selectedSecretNames already folds in the active-execution-profile
    // fallback above for the retained-path case, so it is the exact required
    // set here too -- no separate re-derivation needed.
    const requiredSecretNames = selectedSecretNames;
    if (!startupCheck) {
      const secrets =
        credentialSource !== "none"
          ? secretsFromSources(environment, envPath, requiredSecretNames)
          : seeded
            ? { merge: emptySecretAssignments, onlyWhenAbsent: true }
            : undefined;
      if (secrets) change = { ...change, secrets };
    }
    // The profile, host.yaml, and secrets.env change as one unit, so a refused
    // credential cannot leave the host switched to the new selection.
    await commitConfigurationRootChange(configurationRoot, change, { environment });

    return finalizeSetupResult({
      environment,
      configurationRoot,
      envPath,
      seeded,
      migrated,
      activePolicyProfile,
      activeExecutionProfile,
      requiredSecretNames,
      credentialSource,
    });
  }

  const credentialSource = resolveCredentialSource(
    environment,
    configurationRoot,
    endpointSecretNames,
    endpointSecretNames !== undefined,
  );
  if (
    hasModelProfile(envPath) &&
    preset === undefined &&
    profile === undefined &&
    input.model === undefined
  ) {
    const retiredLegacySelection = legacyEnvSelectionRefusal(envPath);
    if (!retiredLegacySelection) {
      return finalizeSetupResult({
        environment,
        configurationRoot,
        envPath,
        seeded,
        migrated,
        credentialSource,
      });
    }
    // A legacy root naming a retired model refuses by name for both purposes.
    throw retiredLegacySelection;
  }

  if (preset === undefined && input.model === undefined) {
    // No option names a model and the root has no model selection. Only a
    // stored or ambient credential may exist here, and no credential chooses
    // a model. The startup check reports it; explicit setup refuses.
    if (!startupCheck) throw new SetupModelChoiceRequiredError();
    return finalizeSetupResult({
      environment,
      configurationRoot,
      envPath,
      seeded,
      migrated,
      credentialSource: "none",
      modelChoiceRequired: true,
    });
  }
  // A startup check never gets here: it cannot pass --preset or --model.

  activePolicyProfile = selectedProfilePath();
  await commitConfigurationRootChange(
    configurationRoot,
    {
      profiles: [[activePolicyProfile, selectedPolicyProfile()]],
      host: defaultHostConfig(activePolicyProfile),
      secrets:
        credentialSource !== "none"
          ? secretsFromSources(environment, envPath)
          : { merge: emptySecretAssignments },
    },
    { environment },
  );
  seeded = true;

  return finalizeSetupResult({
    environment,
    configurationRoot,
    envPath,
    seeded,
    migrated,
    activePolicyProfile,
    credentialSource,
    ...(endpointSecretNames ? { requiredSecretNames: endpointSecretNames } : {}),
  });
}

/**
 * Select one installed composition as the host writing profile. This is the
 * whole of `setup --profile <id>`.
 */
async function selectExecutionProfile(input: {
  environment: NodeJS.ProcessEnv;
  configurationRoot: string;
  envPath: string;
  profileId: string;
}): Promise<SetupBootstrapResult> {
  const { environment, configurationRoot, envPath, profileId } = input;
  const requiredSecretNames = requiredSecretNamesForExecutionProfile(profileId);
  // An installed composition is an explicit, single-target selection, the
  // same kind as --model. Both require the credential under the name that
  // selection declares: MODEL_API_KEY is read only when it is itself one of
  // requiredSecretNames, never treated as a stand-in for a different declared
  // name. This keeps setup aligned with how the runtime actually resolves a
  // composition credential (exact source-name match only, no cross-name
  // fallback -- see resolveCompositionCredential in
  // model/operator-execution-binding.ts and resolveSelectedCredential in
  // cli/run/composition-runtime.ts).
  const credentialSource = resolveCredentialSource(
    environment,
    configurationRoot,
    requiredSecretNames,
    /* explicitSelection */ true,
  );
  await commitConfigurationRootChange(
    configurationRoot,
    {
      host: (current) => executionProfileHost(current, profileId),
      secrets:
        credentialSource !== "none"
          ? secretsFromSources(environment, envPath, requiredSecretNames)
          : {
              merge: () => namedSecretAssignments(requiredSecretNames, environment),
              onlyWhenAbsent: true,
            },
    },
    { environment },
  );
  return finalizeSetupResult({
    environment,
    configurationRoot,
    envPath,
    seeded: true,
    migrated: false,
    activeExecutionProfile: profileId,
    requiredSecretNames,
    credentialSource,
  });
}

function requirePreset<T>(preset: T | undefined): T {
  if (preset === undefined) {
    throw new Error("DocsFab setup selects a YAML field block only for an explicit --preset.");
  }
  return preset;
}

/** The named refusal for a configured host whose model selection is retired. */
function hostSelectionRefusal(
  configurationRoot: string,
  host: NonNullable<ReturnType<typeof readHostConfig>>,
): Error | undefined {
  const executionProfileId = resolveHostExecutionProfileId(host);
  if (executionProfileId) return retiredModelSelectionRefusal({ executionProfileId });
  const yamlPath = resolveHostYamlPolicyProfile(host);
  if (!yamlPath) return undefined;
  try {
    const profile = decodeModelProfile(
      parseYaml(readFileSync(resolveProfilePath(configurationRoot, yamlPath), "utf8")),
    );
    return retiredModelSelectionRefusal({ provider: profile.provider, modelId: profile.modelId });
  } catch (error) {
    if (error instanceof Error && error.name === "ModelCompositionError") throw error;
    return undefined;
  }
}

/** The named refusal for a legacy monolithic .env whose model is retired. */
function legacyEnvSelectionRefusal(envPath: string): Error | undefined {
  const assignments = parseDotenvAssignments(readFileSync(envPath, "utf8"));
  return retiredModelSelectionRefusal({
    provider: assignments.get("MODEL_PROVIDER"),
    modelId: assignments.get("MODEL_ID"),
  });
}

function readHostConfig(configurationRoot: string) {
  const hostPath = resolveHostConfigPath(configurationRoot);
  if (!existsSync(hostPath)) return undefined;
  try {
    return decodeHostConfig(parseYaml(readFileSync(hostPath, "utf8")));
  } catch {
    return undefined;
  }
}

function readProfileCredentialEnv(
  configurationRoot: string,
  profilePath: string,
): string | undefined {
  try {
    return decodeModelProfile(
      parseYaml(readFileSync(resolveProfilePath(configurationRoot, profilePath), "utf8")),
    ).credentialEnv;
  } catch {
    return undefined;
  }
}

function executionProfileHost(
  existing: DocsFabHostConfigV1 | undefined,
  profileId: string,
): DocsFabHostConfigV1 {
  const host = existing ? { ...existing } : defaultExecutionHostConfig(profileId);
  host.activeExecutionProfile = profileId;
  host.compositionId = profileId;
  delete host.activePolicyProfile;
  host.active = {
    ...(existing?.active ?? {}),
    writing: {
      compositionId: profileId,
      qualification: existing?.active?.writing?.qualification ?? DEFAULT_PURPOSE_SLOT_QUALIFICATION,
      ...(existing?.active?.writing?.fallbackCompositionId
        ? {
            fallbackCompositionId: existing.active.writing.fallbackCompositionId,
          }
        : {}),
      // Operator settings belong to the slot, so selecting another preset keeps them.
      ...(existing?.active?.writing?.settings
        ? { settings: existing.active.writing.settings }
        : {}),
    },
    ...(existing?.active?.judge ? { judge: existing.active.judge } : {}),
  };
  return host;
}

function hasConfiguredSplitHost(configurationRoot: string): boolean {
  const host = readHostConfig(configurationRoot);
  if (!host) return false;
  if (resolveHostExecutionProfileId(host)) return true;
  const yamlProfile = resolveHostYamlPolicyProfile(host);
  if (!yamlProfile) return false;
  return existsSync(resolve(configurationRoot, yamlProfile));
}

async function finalizeSetupResult(input: {
  environment: NodeJS.ProcessEnv;
  configurationRoot: string;
  envPath: string;
  seeded: boolean;
  migrated: boolean;
  activePolicyProfile?: string;
  activeExecutionProfile?: string;
  requiredSecretNames?: readonly string[];
  credentialSource: SetupBootstrapResult["credentialSource"];
  /** A startup check found no model selection; nothing was written. */
  modelChoiceRequired?: true;
  migrationPaths?: {
    hostPath: string;
    secretsPath: string;
    policyProfilePath: string;
    legacyBackupPath: string;
  };
}): Promise<SetupBootstrapResult> {
  const split = usesSplitLayout(input.configurationRoot);
  const base = {
    schemaVersion: 1 as const,
    kind: "docsfab-setup-bootstrap" as const,
    configurationRoot: input.configurationRoot,
    layout: split ? ("split" as const) : ("legacy" as const),
    envPath: input.envPath,
    seeded: input.seeded,
    migrated: input.migrated,
    credentialSource: input.credentialSource,
    ...(split
      ? {
          hostConfigPath:
            input.migrationPaths?.hostPath ?? resolveHostConfigPath(input.configurationRoot),
          secretsPath:
            input.migrationPaths?.secretsPath ?? resolveSecretsEnvPath(input.configurationRoot),
          ...(input.activePolicyProfile ? { activePolicyProfile: input.activePolicyProfile } : {}),
          ...(input.activeExecutionProfile
            ? { activeExecutionProfile: input.activeExecutionProfile }
            : {}),
          ...(input.requiredSecretNames ? { requiredSecretNames: input.requiredSecretNames } : {}),
        }
      : {}),
  };

  if (input.modelChoiceRequired) {
    return {
      ...base,
      status: "blocked-model-choice-required",
      nextCommand: "docsfab setup",
      explanation: `No model is selected, and DocsFab has no default model. ${SETUP_MODEL_CHOICES}`,
    };
  }

  if (input.credentialSource === "none") {
    const required = input.requiredSecretNames?.join(", ") || "MODEL_API_KEY";
    return {
      ...base,
      status: "blocked-missing-credential",
      nextCommand: "docsfab setup",
      explanation: split
        ? `Set ${required} in the environment or ${SECRETS_ENV_FILE}, then rerun docsfab setup.`
        : `Set ${required} in the environment, then rerun docsfab setup.`,
    };
  }

  try {
    const config = loadConfig(input.environment);
    const readiness = inspectLegacyPolicyProfileReadiness(config.model.profile);
    const endpointUrl = safeEndpointUrl(config.model.baseUrl);
    let effectiveContextWindow = config.model.profile.contextWindow;
    let effectiveLimitReason = config.model.profile.effectiveLimitReason;
    let contextAdmission: "host-window" | "provider" | undefined;
    try {
      const bound = await resolveOperatorExecutionBinding({
        model: config.model,
        environment: input.environment,
        credential: {
          family: "legacy-configured-endpoint",
          apiKey: config.model.apiKey,
        },
      });
      contextAdmission = bound.profile.contextAdmission ?? "host-window";
      if (bound.profile.profile?.contextWindow !== undefined) {
        effectiveContextWindow = bound.profile.profile.contextWindow;
      }
      if (bound.profile.profile?.effectiveLimitReason !== undefined) {
        effectiveLimitReason = bound.profile.profile.effectiveLimitReason;
      }
    } catch {
      // Setup must still report local configuration when composition bind fails.
    }
    return {
      ...base,
      status: readiness.ready ? "ready" : "blocked-unapproved-profile",
      profile: {
        providerId: config.model.providerId,
        modelId: config.model.modelId,
        ...(config.model.transport ? { transport: config.model.transport } : {}),
        ...(endpointUrl ? { endpointUrl } : {}),
        ...(endpointUrl && config.model.transport
          ? { requestUrl: providerRequestUrl(endpointUrl, config.model.transport) }
          : {}),
        configuredContextWindow: config.model.profile.configuredLimits.contextWindow,
        effectiveContextWindow,
        effectiveLimitReason,
        ...(contextAdmission ? { contextAdmission } : {}),
      },
      nextCommand: readiness.nextCommand,
      explanation: readiness.explanation,
    };
  } catch (error) {
    if (error instanceof ModelProfileMigrationError) {
      return {
        ...base,
        status: "blocked-invalid-profile",
        nextCommand: "docsfab setup",
        explanation: split
          ? "The host policy profile is incomplete or invalid. Rerun docsfab setup after correcting host.yaml and profiles/."
          : "The host policy profile is incomplete or invalid. Rerun docsfab setup after correcting the configuration root .env file.",
      };
    }
    throw error;
  }
}

function secretsFromSources(
  environment: NodeJS.ProcessEnv,
  legacyEnvPath: string,
  requiredSecretNames: readonly string[] = SECRET_ENV_KEYS,
): SecretsEnvChange {
  const legacy = existsSync(legacyEnvPath)
    ? parseDotenvAssignments(readFileSync(legacyEnvPath, "utf8"))
    : new Map();

  // Each secret name is persisted only from a source that was set under that
  // exact name. A credential supplied as MODEL_API_KEY is never copied into a
  // differently named slot here: the runtime reads a composition credential
  // only under its own declared source name (see resolveCompositionCredential
  // in model/operator-execution-binding.ts and resolveSelectedCredential in
  // cli/run/composition-runtime.ts), so persisting it under any other name here
  // would be dead storage at best, or a silent cross-provider credential copy.
  //
  // The stored secrets are read inside the secrets.env lock, so a concurrent
  // writer cannot interleave a stale read with a newer write.
  const keys = [...new Set([...SECRET_ENV_KEYS, ...requiredSecretNames])];
  return {
    merge: (existing) =>
      keys.map((key) => {
        const ambient = environment[key]?.trim();
        const fromSecrets = existing.get(key)?.trim();
        const fromLegacy = legacy.get(key)?.trim();
        return [key, ambient || fromSecrets || fromLegacy || ""] as const;
      }),
  };
}

function emptySecretAssignments(): ReadonlyArray<readonly [string, string]> {
  return SECRET_ENV_KEYS.map((key) => [key, ""] as const);
}

function namedSecretAssignments(
  requiredSecretNames: readonly string[],
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<readonly [string, string]> {
  const keys = [...new Set([...SECRET_ENV_KEYS, ...requiredSecretNames])];
  return keys.map((key) => [key, environment[key]?.trim() || ""] as const);
}

function resolveCredentialSource(
  environment: NodeJS.ProcessEnv,
  configurationRoot: string,
  requiredSecretNames: readonly string[] = ["MODEL_API_KEY", "OPENAI_API_KEY"],
  explicitSelection = false,
): SetupBootstrapResult["credentialSource"] {
  if (requiredSecretNames.some((name) => environment[name]?.trim())) return "ambient";
  if (
    !explicitSelection &&
    (environment.MODEL_API_KEY?.trim() || environment.OPENAI_API_KEY?.trim())
  )
    return "ambient";
  const secretsPath = resolveSecretsEnvPath(configurationRoot);
  if (existsSync(secretsPath)) {
    try {
      const contents = readFileSync(secretsPath, "utf8");
      if (hasStoredCredential(contents, requiredSecretNames)) return "existing-env";
    } catch {
      return "none";
    }
  }
  const envPath = resolve(configurationRoot, ".env");
  if (!existsSync(envPath)) return "none";
  try {
    const contents = readFileSync(envPath, "utf8");
    return hasStoredCredential(contents, requiredSecretNames) ? "existing-env" : "none";
  } catch {
    return "none";
  }
}

function hasStoredCredential(source: string, requiredSecretNames: readonly string[]): boolean {
  const assignments = parseDotenvAssignments(source);
  return requiredSecretNames.some((name) => Boolean(assignments.get(name)?.trim()));
}

function hasModelProfile(envPath: string): boolean {
  if (!existsSync(envPath)) return false;
  try {
    const contents = readFileSync(envPath, "utf8");
    return /^\s*MODEL_PROVIDER\s*=/mu.test(contents) && /^\s*MODEL_ID\s*=/mu.test(contents);
  } catch {
    return false;
  }
}

function safeEndpointUrl(value: string): string | undefined {
  try {
    const endpoint = new URL(value);
    if (
      (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      return undefined;
    }
    return endpoint.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

export function formatSetupBootstrapResult(
  result: SetupBootstrapResult,
  terminalEnvironment?: NodeJS.ProcessEnv,
): string {
  const environment = readPresentationEnvironmentFacts(terminalEnvironment ?? {});
  const capabilities = resolvePresentationCapabilities({
    stdout: { isTTY: terminalEnvironment !== undefined },
    stderr: { isTTY: false },
    environment,
  });
  return renderPresentation(setupBootstrapPresentation(result), capabilities).stdout.trimEnd();
}

function setupField(
  label: string,
  value: string,
  detail?: PresentationField["detail"],
  importance?: PresentationField["importance"],
): PresentationField {
  return {
    label,
    evidence: { state: "known", value },
    ...(detail === undefined ? {} : { detail }),
    ...(importance === undefined ? {} : { importance }),
  };
}

/** Typed adapter for both compact and detailed setup results; it does not run setup or probes. */
export function setupBootstrapPresentation(
  result: SetupBootstrapResult,
  options: PresentationOptions = {},
): PresentationDocument {
  const guidance = setupGuidance(result);
  const credential =
    result.credentialSource === "none"
      ? "Missing"
      : result.layout === "split" && result.secretsPath
        ? `Saved in ${result.secretsPath} (value hidden)`
        : result.credentialSource === "ambient"
          ? "Loaded from the environment (value hidden)"
          : "Found in the existing configuration (value hidden)";
  const contextNote =
    result.profile?.contextAdmission === "provider"
      ? "provider-enforced; DocsFab is not applying a host context ceiling"
      : result.profile?.effectiveLimitReason === "metadata-unknown"
        ? "metadata unattested; unique composition matches use the installed window"
        : result.profile?.effectiveLimitReason === "metadata-stale"
          ? "metadata review date has passed"
          : result.profile?.effectiveLimitReason === "composition-candidate"
            ? "installed composition window"
            : undefined;
  const modelFields: PresentationField[] = [];
  if (result.activeExecutionProfile) {
    modelFields.push(setupField("Execution profile", result.activeExecutionProfile));
  }
  if (result.profile) {
    modelFields.push(
      setupField("Model", result.profile.modelId),
      setupField("Provider", result.profile.providerId),
      ...(result.profile.transport ? [setupField("API", result.profile.transport)] : []),
      ...(result.profile.endpointUrl ? [setupField("Endpoint", result.profile.endpointUrl)] : []),
      ...(result.profile.requestUrl ? [setupField("Request URL", result.profile.requestUrl)] : []),
      setupField(
        "Context limit",
        result.profile.contextAdmission === "provider"
          ? `provider-enforced${contextNote ? ` (${contextNote})` : ""}`
          : `${new Intl.NumberFormat("en-US").format(result.profile.effectiveContextWindow)} tokens${contextNote ? ` (${contextNote})` : ""}`,
      ),
      setupField(
        "Configured context",
        `${result.profile.configuredContextWindow} tokens`,
        "verbose",
      ),
      setupField("Effective limit reason", result.profile.effectiveLimitReason, "verbose"),
    );
  }
  const configurationFields: PresentationField[] = [
    ...(result.requiredSecretNames && result.requiredSecretNames.length > 0
      ? [setupField("Required secrets", result.requiredSecretNames.join(", "))]
      : []),
    setupField("API key", credential),
    setupField("Configuration", result.configurationRoot),
    setupField("Connection check", "Not run. Setup only validated the local configuration."),
    setupField("Layout", result.layout, "verbose"),
    ...(result.layout === "split"
      ? [
          ...(result.hostConfigPath
            ? [setupField("Host config", result.hostConfigPath, "verbose")]
            : []),
          ...(result.secretsPath ? [setupField("Secrets", result.secretsPath, "verbose")] : []),
          ...(result.activePolicyProfile
            ? [setupField("Active policy profile", result.activePolicyProfile, "verbose")]
            : []),
        ]
      : [setupField("Env file", result.envPath, "verbose")]),
    ...(result.migrated
      ? [
          setupField(
            "Migration",
            "Monolithic .env migrated; .env.legacy backup retained.",
            undefined,
            "material",
          ),
        ]
      : []),
    ...(result.seeded
      ? [
          setupField(
            "Configuration change",
            result.activeExecutionProfile
              ? "Wrote the active execution profile id without copying YAML MODEL_* fields."
              : "Materialized the host policy profile.",
            undefined,
            "material",
          ),
        ]
      : []),
    setupField("Explanation", result.explanation, "verbose"),
  ];
  const ready = result.status === "ready";
  const attention = ready
    ? null
    : {
        message: `Setup needs attention: ${setupStatus(result.status)}.`,
      };
  return presentResult(
    {
      title: ready ? "DocsFab setup complete" : "DocsFab setup needs attention",
      outcome: setupField("Status", setupStatus(result.status)),
      scope: setupField("Configuration", result.configurationRoot),
      effects: [
        ...(guidance
          ? [
              {
                ...setupField(ready ? "Note" : "Required action", guidance),
                importance: "material" as const,
              },
            ]
          : []),
        ...(result.warnings ?? []).map((warning) => ({
          ...setupField("Warning", warning),
          importance: "material" as const,
        })),
      ],
      sections: [
        ...(modelFields.length ? [{ title: "Model", fields: modelFields }] : []),
        { title: "Configuration details", fields: configurationFields },
      ],
      primaryAction: { kind: "instruction", text: `Next step: ${result.nextCommand}` },
      attention,
    },
    options,
  );
}

function setupGuidance(result: SetupBootstrapResult): string | undefined {
  if (result.status === "blocked-model-choice-required") {
    return `Action: ${SETUP_MODEL_CHOICES}`;
  }
  if (result.status === "blocked-missing-credential") {
    const required = result.requiredSecretNames?.join(", ") || "MODEL_API_KEY";
    return result.secretsPath
      ? `Action: Add ${required} to the environment or ${result.secretsPath}, then run setup again.`
      : `Action: Add ${required} to the environment, then run setup again.`;
  }
  if (result.status === "blocked-invalid-profile") {
    return "Action: Correct the model configuration under the configuration path shown above, then run setup again.";
  }
  if (result.status === "blocked-unapproved-profile") {
    return "Action: Refresh or approve the model metadata before running setup again.";
  }
  if (result.profile?.contextAdmission === "provider") {
    return "Note: DocsFab is not applying a host context ceiling. The provider enforces the window until a unique installed composition matches or metadata is attested.";
  }
  if (result.profile?.effectiveLimitReason === "metadata-unknown") {
    return "Note: Model metadata is unattested. Unique installed-composition matches use that composition's window.";
  }
  if (result.profile?.effectiveLimitReason === "composition-candidate") {
    return "Note: DocsFab is using the installed composition window shown above.";
  }
  return undefined;
}

function setupStatus(status: SetupBootstrapStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "blocked-model-choice-required":
      return "Model choice required";
    case "blocked-missing-credential":
      return "API key required";
    case "blocked-invalid-profile":
      return "Configuration is invalid";
    case "blocked-unapproved-profile":
      return "Model profile needs attention";
  }
}

/** Full bootstrap and profile detail for setup troubleshooting. */
export function formatSetupBootstrapResultDetailed(result: SetupBootstrapResult): string {
  const capabilities = resolvePresentationCapabilities({
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    environment: { noColorPresent: true, forceColor: false, ci: true, termDumb: true },
    unicode: false,
  });
  return renderPresentation(
    setupBootstrapPresentation(result, { detail: "verbose" }),
    capabilities,
  ).stdout.trimEnd();
}
