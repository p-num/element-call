/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect } from "react";
import { getProductName } from "./branding/brand";
import { useBrand } from "./branding/useBrand";

export function usePageTitle(title?: string): void {
  const brand = useBrand();
  useEffect(() => {
    const productName = getProductName(brand);
    document.title = title ? `${productName} | ${title}` : productName;
  }, [title, brand]);
}
