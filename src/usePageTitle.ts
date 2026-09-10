/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect } from "react";
import { getProductName } from "./branding/brand";

export function usePageTitle(title?: string): void {
  useEffect(() => {
    const productName = getProductName();
    document.title = title ? `${productName} | ${title}` : productName;
  }, [title]);
}
