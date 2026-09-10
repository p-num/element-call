/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { getUrlParams } from "../UrlParams";
import { parseBrand, type CallBrand } from "./theme";

// Branding is a host/deployment choice for the lifetime of this app, so router
// navigation and widget appearance changes cannot accidentally reset it.
let brand: CallBrand | undefined;
let navigationBrand: CallBrand | null = null;
export function initializeCallBrand(deploymentBrand?: unknown): void {
  navigationBrand =
    getUrlParams().brand ?? (deploymentBrand === "letro" ? "letro" : null);
  brand = parseBrand(navigationBrand ?? deploymentBrand);
}
export function getCallBrand(): CallBrand {
  if (brand === undefined) initializeCallBrand();
  return brand!;
}
export function getProductName(): string {
  return getCallBrand() === "letro"
    ? "Letro"
    : import.meta.env.VITE_PRODUCT_NAME || "Element Call";
}

export function getNavigationBrand(): CallBrand | null {
  getCallBrand();
  return navigationBrand;
}
