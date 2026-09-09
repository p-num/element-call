/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { getUrlParams } from "../UrlParams";
import { type CallBrand } from "./theme";

// Branding is a host/deployment choice for the lifetime of this app, so router
// navigation and widget appearance changes cannot accidentally reset it.
let brand: CallBrand | undefined;
export function getCallBrand(): CallBrand {
  return (brand ??= getUrlParams().brand);
}
export function getProductName(): string {
  return getCallBrand() === "letro"
    ? "Letro"
    : import.meta.env.VITE_PRODUCT_NAME || "Element Call";
}
