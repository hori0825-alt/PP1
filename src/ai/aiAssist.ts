// AI アシスト: 複数プロバイダーで画像解析し刺繍設定の推奨値を返す。
// Claude は Anthropic の CORS ポリシーにより直接ブラウザから呼べないため
// ユーザーが用意したプロキシ URL を経由する。OpenAI・Gemini はブラウザから直接呼べる。

export type AiProvider = "claude" | "openai" | "gemini";

export const AI_MODELS: Record<AiProvider, string[]> = {
  claude: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  openai: ["gpt-4o", "gpt-4o-mini"],
  gemini: ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
};

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  claude: "Claude (Anthropic)",
  openai: "ChatGPT (OpenAI)",
  gemini: "Gemini (Google)",
};

export interface AiProviderConfig {
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** Claude 専用: Anthropic API を中継するプロキシの URL (末尾スラッシュ不要) */
  proxyUrl?: string;
}

export interface AiRecommendation {
  analysis: string;
  colorCount: number;
  fillType: "auto" | "satin" | "tatami";
  angleDeg: number;
  densityScale: number;
  underlay: string[];
  satinUnderlay: "auto" | "none" | "center" | "center-zigzag";
  removeWhiteBackground: boolean;
  tips: string[];
}

const PROMPT = `あなたは刺繍デジタイザーの専門家です。この画像を刺繍デザインとして縫製するための最適な設定を JSON のみで返してください。

返すべき JSON のフィールド:
- analysis: 画像の特徴と刺繍化の方針 (1〜2文の日本語)
- colorCount: 推奨する色数の整数 (2〜12)
- fillType: 面の縫い方 "auto" | "satin" | "tatami" のいずれか
- angleDeg: タタミのステッチ角度 0, 45, 90, 135 のいずれか
- densityScale: 密度スケール 0.9=高密度 / 1.0=標準 / 1.25=省針 / 1.5=最省針 のいずれか
- underlay: 下縫いの配列 (空配列・["edge"]・["edge","tatami"]・["tatami"] のいずれか)
- satinUnderlay: サテン列の下縫い "auto" | "none" | "center" | "center-zigzag" のいずれか
- removeWhiteBackground: 白背景を除去するか true/false
- tips: 刺繍化の注意点 (日本語の文字列を最大3つ)

コードブロックや説明文は付けず、有効な JSON のみを返してください。`;

export async function analyzeImage(
  base64Image: string,
  mimeType: string,
  config: AiProviderConfig,
): Promise<AiRecommendation> {
  switch (config.provider) {
    case "claude":
      return callClaude(base64Image, mimeType, config);
    case "openai":
      return callOpenAI(base64Image, mimeType, config);
    case "gemini":
      return callGemini(base64Image, mimeType, config);
  }
}

async function callClaude(
  base64Image: string,
  mimeType: string,
  config: AiProviderConfig,
): Promise<AiRecommendation> {
  const base = config.proxyUrl
    ? config.proxyUrl.replace(/\/$/, "")
    : "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64Image },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API エラー ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content: { type: string; text: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  return parseRecommendation(text);
}

async function callOpenAI(
  base64Image: string,
  mimeType: string,
  config: AiProviderConfig,
): Promise<AiRecommendation> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64Image}` },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI API エラー ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return parseRecommendation(data.choices[0]?.message?.content ?? "");
}

async function callGemini(
  base64Image: string,
  mimeType: string,
  config: AiProviderConfig,
): Promise<AiRecommendation> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType, data: base64Image } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 512 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API エラー ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    candidates: { content: { parts: { text: string }[] } }[];
  };
  return parseRecommendation(
    data.candidates[0]?.content?.parts[0]?.text ?? "",
  );
}

function parseRecommendation(raw: string): AiRecommendation {
  const text = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const obj = JSON.parse(text) as Partial<AiRecommendation>;
  const validFill = ["auto", "satin", "tatami"];
  const validSatin = ["auto", "none", "center", "center-zigzag"];
  const validDensity = [0.9, 1.0, 1.25, 1.5];
  const validAngle = [0, 45, 90, 135];
  return {
    analysis: String(obj.analysis ?? ""),
    colorCount: Math.min(12, Math.max(2, Math.round(Number(obj.colorCount ?? 6)))),
    fillType: (validFill.includes(obj.fillType ?? "") ? obj.fillType : "auto") as AiRecommendation["fillType"],
    angleDeg: validAngle.includes(Number(obj.angleDeg)) ? Number(obj.angleDeg) : 45,
    densityScale: validDensity.includes(Number(obj.densityScale)) ? Number(obj.densityScale) : 1.0,
    underlay: Array.isArray(obj.underlay)
      ? obj.underlay.filter((u) => ["edge", "tatami"].includes(String(u)))
      : [],
    satinUnderlay: (validSatin.includes(obj.satinUnderlay ?? "")
      ? obj.satinUnderlay
      : "auto") as AiRecommendation["satinUnderlay"],
    removeWhiteBackground: Boolean(obj.removeWhiteBackground),
    tips: Array.isArray(obj.tips) ? obj.tips.slice(0, 3).map(String) : [],
  };
}
