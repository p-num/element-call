import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBrand,
  themeTokens,
  compoundTokens,
  generateThemeCSS,
} from "../../src/branding/theme.ts";

test("only the exact bundled identifier selects Letro", () => {
  assert.equal(parseBrand("letro"), "letro");
  for (const value of [
    null,
    undefined,
    "element",
    "",
    "Letro",
    "https://example.com/theme.css",
    {},
    "letro; color:red",
  ])
    assert.equal(parseBrand(value), "element");
});
const luminance = (hex) => {
  const rgb = hex
    .match(/[a-f0-9]{2}/gi)
    .map((x) => parseInt(x, 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
};
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);
for (const appearance of ["light", "dark", "light-hc", "dark-hc"]) {
  test(`${appearance}: complete roles, text and focus contrast`, () => {
    const t = themeTokens(appearance);
    for (const role of [
      "primary",
      "accent",
      "canvas",
      "surface",
      "elevated",
      "text",
      "text-secondary",
      "icon",
      "focus",
      "success",
      "warning",
      "destructive",
      "disabled",
      "tile",
      "speaking",
      "connecting",
    ])
      assert.ok(t[role], role);
    assert.ok(
      contrast(t.accent, t["on-accent"]) >=
        (appearance.endsWith("hc") ? 7 : 4.5),
    );
    assert.ok(
      contrast(
        t.focus,
        appearance.startsWith("light") ? "#FFFFFF" : "#17191C",
      ) >= 3,
    );
    assert.ok(contrast(t.success, t["status-background"]) >= 4.5);
    assert.ok(contrast(t.accent, t["status-background"]) >= 4.5);
    assert.doesNotMatch(
      JSON.stringify(compoundTokens(appearance)),
      /green|blue|https?:|url\(/,
    );
  });
}
test("generated selectors cannot affect default Element branding", () => {
  const css = generateThemeCSS();
  assert.equal((css.match(/body\[data-call-brand="letro"\]/g) || []).length, 4);
  assert.doesNotMatch(css, /:root|!important/);
  assert.equal(css, generateThemeCSS());
});
