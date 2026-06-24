// Vercel Edge Function: /api/embroidery-ai
// フロントエンドからの画像解析リクエストを受け、OpenAI API を呼び出す。
// API キーはサーバー側環境変数のみ。フロントエンドには一切渡さない。

export const config = { runtime: "edge" as const };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const SYSTEM_PROMPT = `あなたは刺繍デジタイザーの専門家です。Brother PP1 / Artspira 向けの刺繍データ作成を支援します。
画像を分析し、刺繍データに変換するための詳細な設定を JSON のみで返してください。
コードブロックや説明文は付けず、有効な JSON のみを返してください。

マシン制約:
- 最大針数: 12,000針
- 刺繍枠: 100mm × 100mm
- 出力形式: PES / DST

JSON のフィールド定義:

image_type: "photo" | "illustration" | "anime" | "logo" | "line_art"
  画像の種類。

protected_regions: 配列。各要素は { name: string, reason: string, priority: "high"|"medium"|"low" }
  減色時に消してはいけない領域。白目、ハイライト、重要な小さい明色領域など。
  例: { "name": "eye_white", "reason": "白目なので減色時に消してはいけない", "priority": "high" }

transparent_or_empty_regions: 配列。各要素は { reason: string }
  塗りつぶしてはいけない余白・透明・白抜き領域。

color_reduction_plan: オブジェクト。
  target_color_count: 推奨色数 (2〜12)
  keep_colors: 残すべき色の配列 [{ r, g, b, reason }]
  merge_colors: 統合すべき色ペアの配列 [{ from: {r,g,b}, to: {r,g,b}, reason }]
  do_not_merge: 統合してはいけない色の配列 [{ r, g, b, reason }]

vectorization_plan: オブジェクト。
  smoothing_level: "low" | "medium" | "high" — 輪郭の平滑化レベル
  preserve_small_details: 潰してはいけない小さい形状の名前の配列
  remove_noise_regions: ノイズとして削除候補の領域名の配列
  keep_holes: 穴あき・白抜き領域を保持するか (true/false)

stitch_plan: 配列。各要素は {
  region_name: 領域名,
  stitch_type: "satin" | "tatami" | "running",
  reason: 理由,
  recommended_width_mm: サテン幅 (省略可),
  density: "low" | "medium" | "high",
  direction: "along_path" | "perpendicular" | "follow_shape_flow" | "angle_0" | "angle_45" | "angle_90" | "angle_135"
}
  細い線・輪郭→satin、広い面→tatami、つなぎ→running

thread_trim_plan: オブジェクト。
  minimize_trims: 糸切りを最小化するか (true/false)
  connect_nearby_same_color_regions: 近接同色領域をつなぐか (true/false)
  max_jump_before_trim_mm: 糸切りせずにジャンプする最大距離 (mm)
  recommended_order: 推奨縫い順の領域名配列

warnings: 配列。各要素は { type: string, message: string }
  例: { "type": "stitch_count_risk", "message": "針数が12,000針を超える可能性があります" }`;

function buildUserPrompt(metadata: Record<string, unknown>): string {
  const parts: string[] = ["この画像を刺繍データとして最適化する設定を JSON で返してください。"];
  const m = metadata;

  if (m.originalWidth && m.originalHeight) {
    parts.push(`元画像サイズ: ${m.originalWidth}×${m.originalHeight}px`);
  }
  if (m.hasTransparentPixels) {
    parts.push("透明ピクセルあり — 透明部分は塗りつぶさないでください。");
  }
  if (m.currentColorCount) {
    parts.push(`現在の色数: ${m.currentColorCount}`);
  }
  if (Array.isArray(m.dominantColors) && m.dominantColors.length > 0) {
    const cols = (m.dominantColors as Array<{ r: number; g: number; b: number; percentage: number }>)
      .slice(0, 8)
      .map((c) => `rgb(${c.r},${c.g},${c.b}) ${c.percentage.toFixed(1)}%`)
      .join(", ");
    parts.push(`主要色: ${cols}`);
  }
  if (m.estimatedStitchCount) {
    parts.push(`推定針数: ${m.estimatedStitchCount}`);
  }

  const s = m.settings as Record<string, unknown> | undefined;
  if (s) {
    parts.push(`出力サイズ: ${s.targetSizeMm ?? 100}mm`);
    parts.push(`最大色数: ${s.maxColors ?? 6}`);
    if (s.maxStitches) parts.push(`最大針数: ${s.maxStitches}`);
    parts.push(`現在の縫い方: ${s.fillType ?? "auto"}、角度: ${s.angleDeg ?? 45}°、密度: ${s.densityScale ?? 1.0}`);
    parts.push(`糸切りモード: ${s.trimMode ?? "auto"}`);
  }

  const prefs = m.preferences as Record<string, boolean> | undefined;
  if (prefs) {
    const flags: string[] = [];
    if (prefs.protectHighlights) flags.push("白目・ハイライトを保護");
    if (prefs.preserveTransparency) flags.push("透明・白抜き部分を保持");
    if (prefs.simplifyPhoto) flags.push("写真を刺繍向けに単純化");
    if (prefs.minimizeTrims) flags.push("糸切りを最小化");
    if (prefs.autoStitchType) flags.push("サテン/タタミを自動判定");
    if (flags.length > 0) parts.push(`ユーザー要望: ${flags.join("、")}`);
  }

  parts.push("対象ミシン: Brother PP1 / Artspira。最大針数 12,000 針。出力形式 PES / DST。");

  return parts.join("\n");
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "AI機能はサーバー側で設定されていません" }, 503);
  }

  let body: { image?: string; metadata?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.image || typeof body.image !== "string") {
    return jsonResponse({ error: "画像データが必要です" }, 400);
  }

  if (body.image.length > 5_000_000) {
    return jsonResponse({ error: "画像サイズが大きすぎます (最大約3.5MB)" }, 413);
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55_000);

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${body.image}` },
              },
              { type: "text", text: buildUserPrompt(body.metadata ?? {}) },
            ],
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let msg = "AI解析に失敗しました";
      if (res.status === 429) msg = "レート制限に達しました。しばらく待ってから再試行してください。";
      else if (res.status === 401 || res.status === 403) msg = "サーバー側のAPIキー設定を確認してください";
      console.error(`OpenAI API error ${res.status}: ${errText.slice(0, 200)}`);
      return jsonResponse({ error: msg }, 502);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return jsonResponse({ error: "AIからの応答が空でした" }, 502);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return jsonResponse({ error: "AIからの応答がJSON形式ではありませんでした" }, 502);
    }

    return jsonResponse(parsed);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return jsonResponse({ error: "AI解析がタイムアウトしました" }, 504);
    }
    console.error("AI analysis error:", (err as Error).message);
    return jsonResponse({ error: "AI解析中にエラーが発生しました" }, 500);
  }
}
