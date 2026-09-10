/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { beforeEach, expect, it, vi } from "vitest";
const params = vi.hoisted(() => ({ brand: null as string | null }));
vi.mock("../UrlParams", () => ({ getUrlParams: () => params }));
beforeEach(() => {
  params.brand = null;
  vi.resetModules();
});
it("preserves Element when no host or deployment opts in", async () => {
  const { getCallBrand } = await import("./brand");
  expect(getCallBrand()).toBe("element");
});
it("initializes deployment branding even after a default component render", async () => {
  const { initializeCallBrand, getCallBrand, getProductName } =
    await import("./brand");
  expect(getCallBrand()).toBe("element");
  initializeCallBrand("letro");
  expect(getCallBrand()).toBe("letro");
  expect(getProductName()).toBe("Letro");
});
it("keeps the host choice through routing and gives it precedence over deployment", async () => {
  params.brand = "letro";
  const { initializeCallBrand, getCallBrand } = await import("./brand");
  initializeCallBrand("element");
  params.brand = null;
  expect(getCallBrand()).toBe("letro");
});
it("allows an explicit Element choice and rejects unknown deployment values", async () => {
  const { initializeCallBrand, getCallBrand } = await import("./brand");
  params.brand = "element";
  initializeCallBrand("letro");
  expect(getCallBrand()).toBe("element");
  params.brand = null;
  initializeCallBrand("https://example.com/theme.css");
  expect(getCallBrand()).toBe("element");
});
