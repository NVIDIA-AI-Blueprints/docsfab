// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ARTIFACT_KINDS,
  ArtifactValidationError,
  type Artifact,
  type ArtifactValidationOptions,
} from "./contracts.js";
import { canonicalArtifactDigest } from "./canonical.js";
import { validateArtifact } from "./validate.js";

export const CURRENT_ARTIFACT_SCHEMA_VERSION = 1;

export type MigrationCompatibility = "additive" | "breaking";

export interface ArtifactMigration {
  kind: string;
  fromVersion: number;
  toVersion: number;
  compatibility: MigrationCompatibility;
  migrate: (value: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

export interface MigrateArtifactOptions {
  allowBreaking?: boolean;
  registry?: ArtifactMigrationRegistry;
  validation: ArtifactValidationOptions;
}

type RegistryMigrationOptions = Pick<MigrateArtifactOptions, "allowBreaking">;

function migrationKey(kind: string, version: number): string {
  return `${kind}\u0000${version}`;
}

function migrationRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ArtifactValidationError("invalid-type", "$");
  }
  return value as Record<string, unknown>;
}

export class ArtifactMigrationRegistry {
  private readonly migrations = new Map<string, ArtifactMigration>();

  public register(migration: ArtifactMigration): void {
    if (
      !Number.isSafeInteger(migration.fromVersion) ||
      !Number.isSafeInteger(migration.toVersion) ||
      migration.fromVersion < 0 ||
      migration.toVersion !== migration.fromVersion + 1
    ) {
      throw new ArtifactValidationError("migration-missing", "$.schemaVersion");
    }
    const key = migrationKey(migration.kind, migration.fromVersion);
    if (this.migrations.has(key)) {
      throw new ArtifactValidationError("migration-missing", "$.schemaVersion");
    }
    this.migrations.set(key, migration);
  }

  public migrate(value: unknown, options: RegistryMigrationOptions = {}): Record<string, unknown> {
    let artifact = migrationRecord(value);
    const version = artifact.schemaVersion;
    if (!Number.isSafeInteger(version) || (version as number) < 0) {
      throw new ArtifactValidationError("invalid-type", "$.schemaVersion");
    }
    if ((version as number) > CURRENT_ARTIFACT_SCHEMA_VERSION) {
      throw new ArtifactValidationError("future-version", "$.schemaVersion");
    }
    const kind = artifact.kind;
    if (typeof kind !== "string" || !kind) {
      throw new ArtifactValidationError("invalid-type", "$.kind");
    }

    while ((artifact.schemaVersion as number) < CURRENT_ARTIFACT_SCHEMA_VERSION) {
      const currentVersion = artifact.schemaVersion as number;
      const migration = this.migrations.get(migrationKey(kind, currentVersion));
      if (!migration) {
        throw new ArtifactValidationError("migration-missing", "$.schemaVersion");
      }
      if (migration.compatibility === "breaking" && !options.allowBreaking) {
        throw new ArtifactValidationError("breaking-migration-required", "$.schemaVersion");
      }
      const migrated = migrationRecord(migration.migrate(artifact));
      if (migrated.schemaVersion !== migration.toVersion) {
        throw new ArtifactValidationError("migration-missing", "$.schemaVersion");
      }
      artifact = migrated;
    }
    return artifact;
  }
}

export const artifactMigrationRegistry = new ArtifactMigrationRegistry();

for (const kind of ARTIFACT_KINDS) {
  artifactMigrationRegistry.register({
    kind,
    fromVersion: 0,
    toVersion: 1,
    compatibility: "additive",
    migrate: (value) => {
      const migrated: Record<string, unknown> = { ...value, schemaVersion: 1 };
      migrated.digest = canonicalArtifactDigest(migrated);
      return migrated;
    },
  });
}

export function registerArtifactMigration(migration: ArtifactMigration): void {
  artifactMigrationRegistry.register(migration);
}

export function migrateArtifact(value: unknown, options: MigrateArtifactOptions): Artifact {
  const migrated = (options.registry ?? artifactMigrationRegistry).migrate(value, options);
  return validateArtifact(migrated, options.validation);
}
