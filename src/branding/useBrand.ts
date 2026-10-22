/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { useUrlParams } from "../UrlParams";
import { getCallBrand } from "./brand";
import { type CallBrand } from "./theme";

export function useBrand(): CallBrand {
  return useUrlParams().brand ?? getCallBrand();
}
