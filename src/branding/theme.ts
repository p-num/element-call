/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */

export type CallBrand = "element" | "letro";
export type Appearance = "light" | "dark" | "light-hc" | "dark-hc";

/** Version 1: only bundled, reviewed themes can be selected. Never CSS or URLs. */
export function parseBrand(value: unknown): CallBrand {
  return value === "letro" ? "letro" : "element";
}

// Provenance and platform differences: docs/letro-branding.md.
export const palette = {
  primary: "#F32D1B",
  secondary: "#F9BC15",
  gray: "#B1B3B9",
  red: "#CB2000",
  orange: "#DD5A00",
  gold: "#F7B000",
  strong: "#7E1107",
  pale: "#FCCECA",
  subtle: "#FDE5E1",
  success: "#9B2200",
} as const;

const cpd = (name: string): string => `var(--cpd-color-${name})`;

/** Semantic roles. Neutral and critical scales follow upstream Compound modes. */
export function themeTokens(appearance: Appearance): Record<string, string> {
  const dark = appearance.startsWith("dark");
  const hc = appearance.endsWith("hc");
  return {
    primary: palette.primary,
    accent: dark ? palette.pale : hc ? palette.strong : palette.red,
    "accent-hovered": dark ? palette.subtle : palette.strong,
    "on-accent": dark ? palette.strong : "#FFFFFF",
    canvas: cpd("theme-bg"),
    surface: cpd("gray-300"),
    elevated: cpd("gray-200"),
    text: cpd("gray-1400"),
    "text-secondary": cpd(hc ? "gray-1400" : "gray-900"),
    icon: cpd("gray-1400"),
    focus: dark ? palette.pale : palette.strong,
    success: dark ? palette.gold : palette.success,
    warning: cpd("yellow-900"),
    destructive: cpd("red-900"),
    disabled: cpd("gray-800"),
    "disabled-surface": cpd("gray-200"),
    tile: cpd("gray-300"),
    "tile-text": cpd("gray-1400"),
    speaking: dark ? palette.pale : palette.strong,
    connecting: dark ? palette.gold : palette.success,
    "status-background": dark ? palette.strong : palette.subtle,
    "gradient-start": palette.red,
    "gradient-end": palette.gold,
  };
}

/** The only adapter to Compound's public token names and Call's local tokens. */
export function compoundTokens(appearance: Appearance): Record<string, string> {
  const result: Record<string, string> = {};
  const bind = (role: string, names: string[]): void => {
    for (const name of names)
      result[`--cpd-color-${name}`] = `var(--call-${role})`;
  };
  bind("accent", [
    "bg-accent-rest",
    "bg-action-primary-rest",
    "text-action-accent",
    "text-link-external",
    "text-badge-accent",
    "text-badge-info",
    "text-info-primary",
    "icon-accent-primary",
    "icon-accent-tertiary",
    "icon-info-primary",
    "border-accent",
    "border-accent-primary",
    "border-accent-subtle",
    "border-info-subtle",
  ]);
  bind("accent-hovered", [
    "bg-accent-hovered",
    "bg-accent-pressed",
    "bg-action-primary-hovered",
    "bg-action-primary-pressed",
  ]);
  bind("on-accent", ["text-on-solid-primary", "icon-on-solid-primary"]);
  bind("canvas", ["bg-canvas-default"]);
  bind("surface", ["bg-subtle-primary", "bg-subtle-secondary"]);
  bind("elevated", ["bg-canvas-elevated"]);
  bind("text", ["text-primary", "text-action-primary"]);
  bind("text-secondary", ["text-secondary"]);
  bind("icon", ["icon-primary"]);
  bind("focus", ["border-focused"]);
  bind("success", [
    "text-success-primary",
    "icon-success-primary",
    "border-success-subtle",
  ]);
  bind("destructive", [
    "text-critical-primary",
    "icon-critical-primary",
    "bg-critical-primary",
  ]);
  bind("disabled", ["text-disabled", "icon-disabled", "border-disabled"]);
  bind("disabled-surface", [
    "bg-canvas-disabled",
    "bg-action-primary-disabled",
  ]);
  bind("status-background", [
    "bg-success-subtle",
    "bg-info-subtle",
    "bg-badge-accent",
    "bg-badge-info",
    "bg-accent-selected",
    "bg-action-tertiary-selected",
    "gradient-info-stop1",
  ]);
  for (let n = 1; n <= 6; n++) {
    bind("tile", [`bg-decorative-${n}`]);
    bind("tile-text", [`text-decorative-${n}`]);
    result[`--cpd-color-gradient-subtle-stop${n}`] =
      `color-mix(in srgb, ${palette.red} ${[33, 22, 11, 7, 4, 0][n - 1]}%, transparent)`;
  }
  for (let n = 1; n <= 4; n++)
    result[`--cpd-color-gradient-action-stop${n}`] = [
      palette.red,
      palette.orange,
      palette.gold,
      palette.gold,
    ][n - 1];
  result["--video-tile-background"] = "var(--call-tile)";
  result["--call-speaking-gradient"] =
    "linear-gradient(var(--call-speaking), var(--call-speaking))";
  result["--call-grid-speaking-gradient"] = "var(--call-speaking-gradient)";
  result["--call-page-background"] = appearance.endsWith("hc")
    ? "none"
    : "radial-gradient(ellipse at bottom, color-mix(in srgb, var(--call-gradient-end) 12%, transparent), transparent 65%)";
  return result;
}

export function generateThemeCSS(): string {
  return (["light", "dark", "light-hc", "dark-hc"] as const)
    .map((appearance) => {
      const tokens = Object.fromEntries(
        Object.entries(themeTokens(appearance)).map(([key, value]) => [
          `--call-${key}`,
          value,
        ]),
      );
      return `body[data-call-brand="letro"].cpd-theme-${appearance} {\n${Object.entries(
        { ...tokens, ...compoundTokens(appearance) },
      )
        .map(([key, value]) => `  ${key}: ${value};`)
        .join(
          "\n",
        )}\n  color-scheme: ${appearance.startsWith("light") ? "light" : "dark"};\n}`;
    })
    .join("\n");
}
