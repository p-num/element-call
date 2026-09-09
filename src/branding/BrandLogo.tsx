/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { type ComponentType, type SVGProps } from "react";
import { getCallBrand } from "./brand";

export function BrandLogo({
  element: ElementLogo,
  ...props
}: SVGProps<SVGSVGElement> & {
  element: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return getCallBrand() === "letro" ? (
    <span
      aria-label="Letro"
      className={props.className}
      style={{ color: "var(--call-accent)", fontWeight: 600 }}
    >
      Letro
    </span>
  ) : (
    <ElementLogo {...props} />
  );
}
