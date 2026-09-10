/* Copyright 2026 p-num. SPDX-License-Identifier: AGPL-3.0-only */
import { type ComponentType, type SVGProps } from "react";
import classNames from "classnames";
import { getCallBrand } from "./brand";
import styles from "./BrandLogo.module.css";

export function BrandLogo({
  element: ElementLogo,
  ...props
}: SVGProps<SVGSVGElement> & {
  element: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return getCallBrand() === "letro" ? (
    <span
      role="img"
      aria-label="Letro"
      className={classNames(styles.letro, props.className)}
      style={
        typeof props.width === "number" ? { width: props.width } : undefined
      }
    />
  ) : (
    <ElementLogo {...props} />
  );
}
