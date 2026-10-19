// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

import {
  DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS,
  documentationSourceAdapterForConfiguration,
  documentationSourceRstUpdateCapability,
  type DocumentationSourceAdapterId,
} from "../repository/documentation-source-support.js";

export type RstConfigurationCandidate = Readonly<{
  configurationPath: string;
  documentationRoot: string;
  adapterId: DocumentationSourceAdapterId;
}>;

/** Candidate owners for one exact RST file root, including competing adapters. */
export function rstConfigurationCandidates(
  pagePath: string,
  selectedRoot: string,
): readonly RstConfigurationCandidate[] {
  if (selectedRoot !== pagePath || !pagePath.endsWith(".rst")) return [];
  const directories: string[] = [];
  let directory = posix.dirname(pagePath);
  while (directory !== ".") {
    directories.push(directory);
    directory = posix.dirname(directory);
  }
  directories.push("");
  const candidates = new Map<string, RstConfigurationCandidate>();
  for (const ancestor of directories) {
    for (const location of DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS) {
      const adapterId = documentationSourceAdapterForConfiguration(location);
      if (!adapterId) continue;
      const configurationPath = ancestor ? `${ancestor}/${location}` : location;
      const parent = posix.dirname(configurationPath);
      const documentationRoot = parent === "." ? "" : parent;
      if (documentationRoot !== "" && !pagePath.startsWith(`${documentationRoot}/`)) continue;
      candidates.set(configurationPath, { configurationPath, documentationRoot, adapterId });
    }
  }
  return [...candidates.values()];
}

/** Existing RST pages owned by an unambiguous, configured Sphinx documentation root. */
export function eligibleRstUpdatePaths(
  entries: readonly { readonly path?: string; readonly kind: string }[],
  roots: readonly string[] | undefined,
): readonly string[] {
  const regular = new Set(
    entries.flatMap((entry) => (entry.kind === "regular" && entry.path ? [entry.path] : [])),
  );
  if (documentationSourceRstUpdateCapability("sphinx").state !== "supported") return [];
  const effectiveRoots = roots ?? ["docs/", "fern/"];
  const admitted = new Set<string>();
  for (const root of effectiveRoots) {
    const fileRoot = root.endsWith(".rst");
    if (fileRoot) {
      if (!regular.has(root)) continue;
      const configurations = rstConfigurationCandidates(root, root).filter((candidate) =>
        regular.has(candidate.configurationPath),
      );
      if (configurations.length === 1 && configurations[0]!.adapterId === "sphinx") {
        admitted.add(root);
      }
      continue;
    }
    const directory = root.endsWith("/") ? root : `${root}/`;
    const candidatePages = [...regular].filter(
      (path) => path.endsWith(".rst") && path.startsWith(directory),
    );
    if (candidatePages.length === 0) continue;
    // The registry's configuration names and classifier define ownership.
    // A project-relative configured root can own its own conf.py; the default
    // docs/ root can also be owned by a repository-root conf.py.
    const configurations = DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS.flatMap((location) => {
      const prefixed = `${directory}${location}`;
      const paths = directory === "docs/" ? [location, prefixed] : [prefixed];
      return paths.filter((path) => regular.has(path)).map((path) => ({ path, location }));
    });
    const unique = new Map(configurations.map((entry) => [entry.path, entry.location]));
    if (unique.size !== 1) continue;
    const owner = unique.entries().next().value;
    if (!owner) continue;
    const [ownerPath, location] = owner;
    if (location && documentationSourceAdapterForConfiguration(location) === "sphinx") {
      for (const page of candidatePages) {
        const pageOwners = rstConfigurationCandidates(page, page).filter((candidate) =>
          regular.has(candidate.configurationPath),
        );
        if (pageOwners.length === 1 && pageOwners[0]!.configurationPath === ownerPath)
          admitted.add(page);
      }
    }
  }
  return [...admitted].sort();
}
