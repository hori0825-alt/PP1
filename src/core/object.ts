// 永続的な刺繍オブジェクトモデル (Phase 1: オブジェクトモデル移行の土台)。
//
// 設計意図:
//   - これまでステッチは Region[] から「毎回まるごと再生成」されていた。
//     そのため手作業の編集 (個々の針の移動など) を保持できなかった。
//   - EmbroideryObject は「不変の id」と「マニュアル編集済みの針列 (baked)」を持つ。
//     baked があるオブジェクトは再生成せず、その針列をそのまま出力する。
//   - id は選択・縫い順・表示/非表示の「同一性」を、編集や並べ替えをまたいで保つ。
//
// Region (形状 + 色 + パーツ別パラメータ) はオブジェクトの一部として保持する。
// 既存の Region ベースのコードと共存できるよう、相互変換ヘルパーを用意する。

import type { Region } from "./region";
import type { StitchRun } from "./types";

export interface EmbroideryObject {
  /** 設計内で一意・不変の識別子。再生成・並べ替えでも変わらない */
  id: number;
  /** 形状・色・パーツ別の縫いパラメータ (fillType / angleDeg) */
  region: Region;
  /**
   * マニュアル編集された針列。設定されているとこのオブジェクトは
   * 自動再生成の対象から外れ、この針列がそのまま出力される (Phase 7 の土台)。
   */
  baked?: StitchRun[];
  /** 表示名 (任意) */
  name?: string;
  /** ロック: 編集・再生成の対象外にする (予約。未使用) */
  locked?: boolean;
}

let idCounter = 0;

/** 次の一意なオブジェクト id を発行する */
export function nextObjectId(): number {
  return idCounter++;
}

/** Region を新しいオブジェクトに包む (新しい id を発行) */
export function makeObject(region: Region): EmbroideryObject {
  return { id: nextObjectId(), region };
}

/** Region[] をオブジェクト列に変換する (それぞれ新しい id) */
export function objectsFromRegions(regions: Region[]): EmbroideryObject[] {
  return regions.map(makeObject);
}

/** オブジェクト列から Region[] を取り出す (参照はそのまま) */
export function regionsOf(objects: readonly EmbroideryObject[]): Region[] {
  return objects.map((o) => o.region);
}

/**
 * 現在のオブジェクト列を、新しい Region[] に合わせて再構成する。
 * 同じ Region 参照を持つオブジェクトは id を維持し (= その場編集では同一性を保つ)、
 * 新しい Region には新しい id を割り当てる (= 構造変更では作り直す)。
 */
export function reconcileObjects(
  current: readonly EmbroideryObject[],
  regions: Region[],
): EmbroideryObject[] {
  const sameLength = current.length === regions.length;
  const allSame = sameLength && current.every((o, i) => o.region === regions[i]);
  if (allSame) return current as EmbroideryObject[];

  const byRegion = new Map<Region, EmbroideryObject>();
  for (const o of current) byRegion.set(o.region, o);
  return regions.map((r) => byRegion.get(r) ?? makeObject(r));
}
