// 糸切り・接続判定。
// TRIM_THRESHOLDS (3/5/10mm) とオブジェクト単位の Trim モードに基づいて
// Run 間の接続 (continuous / jump / trim) を決める。

import { TRIM_THRESHOLDS } from "../core/constants";
import type { Connection, Point } from "../core/types";

/**
 * - auto: 距離で判定 (3mm未満=continuous, 10mm未満=jump, それ以上=trim)
 * - never: どんなに離れても糸切りしない (jump で渡す)
 * - always: オブジェクト間は常に糸切り
 */
export type TrimMode = "auto" | "never" | "always";

export interface ConnectOptions {
  trimMode?: TrimMode;
  /** auto 時の糸切り距離閾値 (デフォルト TRIM_THRESHOLDS.trimAbove = 10mm) */
  trimDistance?: number;
}

/**
 * 2点間の距離から接続方法を決める。
 * sameObject = true (同一オブジェクト内: 下縫い→本縫い等) では
 * trimMode に関わらず糸切りしない。
 */
export function decideConnection(
  from: Point | null,
  to: Point,
  sameObject: boolean,
  options: ConnectOptions = {},
): Connection {
  const mode = options.trimMode ?? "auto";
  const trimDistance = options.trimDistance ?? TRIM_THRESHOLDS.trimAbove;
  if (from === null) return sameObject ? "jump" : "trim";

  const d = Math.hypot(to.x - from.x, to.y - from.y);
  if (d < TRIM_THRESHOLDS.neverTrimBelow) return "continuous";
  if (sameObject) return "jump";
  if (mode === "never") return "jump";
  if (mode === "always") return "trim";
  return d < trimDistance ? "jump" : "trim";
}
