/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { initializeCallBrand } from "./brand";
import { useCallBrand } from "./useCallBrand";

const params = vi.hoisted(() => ({ brand: null as string | null }));
vi.mock("../UrlParams", () => ({ getUrlParams: () => params }));
function RoutesPreview(): React.JSX.Element {
  useCallBrand();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="route">{location.pathname + location.hash}</output>
      <button onClick={() => void navigate("/login#?name=Alice%2BBob%26Co")}>
        Navigate
      </button>
    </>
  );
}
it.each([null, "letro", "element"])(
  "preserves explicit %s branding through navigation",
  async (brand) => {
    params.brand = brand;
    initializeCallBrand();
    render(
      <MemoryRouter>
        <RoutesPreview />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText("Navigate"));
    await waitFor(() => {
      const route = screen.getByTestId("route").textContent!;
      expect(route.startsWith("/login#?")).toBe(true);
      const query = new URLSearchParams(route.split("?")[1]);
      expect(query.get("name")).toBe("Alice+Bob&Co");
      expect(query.get("brand")).toBe(brand);
    });
  },
);
