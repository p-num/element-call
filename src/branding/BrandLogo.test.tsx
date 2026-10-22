/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { BrandLogo } from "./BrandLogo";
import { initializeCallBrand } from "./brand";
import { OpenElsewhereError } from "../RichError";

const params = vi.hoisted(() => ({
  brand: null as "letro" | "element" | null,
}));
vi.mock("../UrlParams", () => ({
  getUrlParams: () => ({ brand: null }),
  useUrlParams: () => params,
}));
beforeEach(() => initializeCallBrand("letro"));

test("an Element component keeps its own logo beside a Letro deployment", () => {
  params.brand = "element";
  render(<BrandLogo element={ElementLogo} />);
  expect(screen.getByTestId("element-logo")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Letro" })).not.toBeInTheDocument();
});

test("a standalone root keeps the initialized deployment logo", () => {
  params.brand = null;
  render(<BrandLogo element={ElementLogo} />);
  expect(screen.getByRole("img", { name: "Letro" })).toBeInTheDocument();
  expect(screen.queryByTestId("element-logo")).not.toBeInTheDocument();
});

test("an Element component error uses the same provider brand as its logo", () => {
  params.brand = "element";
  render(new OpenElsewhereError().richMessage);
  expect(screen.getByText(/Element Call has been opened/)).toBeInTheDocument();
  expect(screen.queryByText(/Letro has been opened/)).not.toBeInTheDocument();
});

function ElementLogo() {
  return <svg data-testid="element-logo" />;
}
