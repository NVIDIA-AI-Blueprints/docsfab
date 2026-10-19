// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface TerminalStreamFacts {
  readonly isTTY: boolean;
  readonly columns?: number;
}

export interface TerminalEnvironmentFacts {
  readonly noColorPresent: boolean;
  readonly forceColor: boolean;
  /** FORCE_COLOR was set to a false-like value (for example, "0"). */
  readonly forceColorDisabled?: boolean;
  readonly ci: boolean;
  readonly termDumb: boolean;
}

export interface PresentationCapabilityInput {
  readonly stdout: TerminalStreamFacts;
  readonly stderr: TerminalStreamFacts;
  readonly environment: TerminalEnvironmentFacts;
  readonly unicode?: boolean;
}

export interface ProcessPresentationCapabilityOptions {
  readonly stdout?: Partial<TerminalStreamFacts>;
  readonly stderr?: Partial<TerminalStreamFacts>;
  readonly environment?: Partial<TerminalEnvironmentFacts>;
  readonly unicode?: boolean;
}

export interface PresentationStreamCapabilities {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly color: boolean;
  readonly ornaments: boolean;
}

export interface PresentationCapabilities {
  readonly stdout: PresentationStreamCapabilities;
  readonly stderr: PresentationStreamCapabilities;
  readonly unicode: boolean;
  readonly environment: TerminalEnvironmentFacts;
}

function streamCapabilities(
  stream: TerminalStreamFacts,
  environment: TerminalEnvironmentFacts,
): PresentationStreamCapabilities {
  const forced = environment.forceColor && !environment.noColorPresent;
  const color =
    !environment.noColorPresent &&
    !environment.forceColorDisabled &&
    (forced || (stream.isTTY && !environment.ci && !environment.termDumb));
  const ornaments =
    stream.isTTY &&
    !environment.noColorPresent &&
    !environment.forceColorDisabled &&
    !environment.termDumb &&
    (!environment.ci || forced);
  return {
    isTTY: stream.isTTY,
    ...(stream.columns === undefined ? {} : { columns: stream.columns }),
    color,
    ornaments,
  };
}

/** Resolve visual affordances from explicit facts; this function never reads process state. */
export function resolvePresentationCapabilities(
  input: PresentationCapabilityInput,
): PresentationCapabilities {
  return {
    stdout: streamCapabilities(input.stdout, input.environment),
    stderr: streamCapabilities(input.stderr, input.environment),
    unicode: input.unicode ?? true,
    environment: input.environment,
  };
}

function environmentEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export function readPresentationEnvironmentFacts(
  environment: Readonly<Record<string, string | undefined>>,
): TerminalEnvironmentFacts {
  return {
    noColorPresent: Object.hasOwn(environment, "NO_COLOR"),
    forceColor: environmentEnabled(environment.FORCE_COLOR),
    forceColorDisabled:
      environment.FORCE_COLOR !== undefined && !environmentEnabled(environment.FORCE_COLOR),
    ci: environmentEnabled(environment.CI),
    termDumb: environment.TERM === "dumb",
  };
}

/** Node CLI boundary that reads process facts once and feeds the pure resolver. */
export function resolveProcessPresentationCapabilities(
  options: ProcessPresentationCapabilityOptions = {},
): PresentationCapabilities {
  const detected = readPresentationEnvironmentFacts(process.env);
  const forceColor = options.environment?.forceColor ?? detected.forceColor;
  const forceColorDisabled =
    options.environment?.forceColorDisabled ??
    (options.environment?.forceColor === undefined
      ? (detected.forceColorDisabled ?? false)
      : false);
  const environment = {
    noColorPresent: options.environment?.noColorPresent ?? detected.noColorPresent,
    forceColor,
    forceColorDisabled,
    ci: options.environment?.ci ?? detected.ci,
    termDumb: options.environment?.termDumb ?? detected.termDumb,
  };
  const stdout = {
    isTTY: options.stdout?.isTTY ?? Boolean(process.stdout.isTTY),
    ...((options.stdout?.columns ?? process.stdout.columns) === undefined
      ? {}
      : { columns: options.stdout?.columns ?? process.stdout.columns }),
  };
  const stderr = {
    isTTY: options.stderr?.isTTY ?? Boolean(process.stderr.isTTY),
    ...((options.stderr?.columns ?? process.stderr.columns) === undefined
      ? {}
      : { columns: options.stderr?.columns ?? process.stderr.columns }),
  };
  return resolvePresentationCapabilities({ stdout, stderr, environment, unicode: options.unicode });
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

/** Approximate terminal cells per extended grapheme cluster without external packages. */
export function unicodeCellWidth(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const codePoints = Array.from(segment, (character) => character.codePointAt(0) ?? 0);
    const visiblePoints = codePoints.filter((point) => {
      const character = String.fromCodePoint(point);
      return (
        !/\p{Mark}/u.test(character) && point !== 0x200d && point !== 0xfe0e && point !== 0xfe0f
      );
    });
    if (visiblePoints.length === 0) continue;
    width += visiblePoints.some(isWideCodePoint) ? 2 : 1;
  }
  return width;
}
