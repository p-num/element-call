/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getNavigationBrand } from "./brand";

/** Keep an explicit host/deployment choice across route changes and reloads. */
export function useCallBrand(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const brand = getNavigationBrand();
  useEffect(() => {
    if (brand === null) return;
    const fragment = location.hash.replace(/^#/, "");
    const separator = fragment.indexOf("?");
    const route = separator < 0 ? fragment : fragment.slice(0, separator);
    const params = new URLSearchParams(
      separator < 0 ? "" : fragment.slice(separator + 1),
    );
    if (params.get("brand") === brand) return;
    params.set("brand", brand);
    void navigate(
      { ...location, hash: `#${route}?${params}` },
      { replace: true, state: location.state },
    );
  }, [brand, location, navigate]);
}
