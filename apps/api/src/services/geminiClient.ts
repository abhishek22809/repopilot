import { GoogleGenAI } from "@google/genai";
import type { GeminiConfig } from "../utils/env.js";
import { RepoError } from "../utils/RepoError.js";

export interface GenerateInput {
  system: string;
  prompt: string;
  signal: AbortSignal;
}

export interface RawSource {
  path: string;
  lines?: string;
}

export interface RawAnswer {
  answer: string;
  sources: RawSource[];
}

export type GenerateFn = (input: GenerateInput) => Promise<RawAnswer>;

function parseJsonObject(text: string): { answer?: unknown; sources?: unknown } | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as { answer?: unknown; sources?: unknown };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Pull a JSON object out of fences or surrounding prose. */
export function extractJsonObject(text: string): { answer?: unknown; sources?: unknown } | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const direct = parseJsonObject(body);
  if (direct) return direct;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) return parseJsonObject(body.slice(start, end + 1));
  return undefined;
}

/** Drop leaked prompt scaffolding so it is not shown as part of the answer. */
export function sanitizeModelAnswer(answer: string): string {
  let text = answer.trim();
  text = text.replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, "").trim();
  text = text.replace(/<TRACE>[\s\S]*?<\/TRACE>/gi, "").trim();
  text = text.replace(/<CONTEXT>[\s\S]*?<\/CONTEXT>/gi, "").trim();
  text = text.replace(/^Retrieval notes \(not repository source\)[^\n]*\n?/gim, "").trim();
  text = text.replace(/^Use only these claim kinds:.*$/gim, "").trim();
  text = text.replace(/^Verified files retrieved \(roles inferred.*$/gim, "").trim();
  text = text.replace(/^Respond ONLY with JSON:.*$/gim, "").trim();
  return text;
}

function sourcesFromUnknown(value: unknown): RawSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s): RawSource[] => {
    if (s && typeof s === "object" && typeof (s as { path?: unknown }).path === "string") {
      const path = (s as { path: string }).path;
      const lines = (s as { lines?: unknown }).lines;
      return [{ path, ...(typeof lines === "string" ? { lines } : {}) }];
    }
    return [];
  });
}

/** Parse the model's JSON output defensively; fall back to plain text. */
export function parseModelAnswer(text: string): RawAnswer {
  const trimmed = text.trim();
  const obj = extractJsonObject(trimmed);
  if (obj) {
    const rawAnswer = typeof obj.answer === "string" ? obj.answer : "";
    return { answer: sanitizeModelAnswer(rawAnswer) || rawAnswer.trim(), sources: sourcesFromUnknown(obj.sources) };
  }
  return { answer: sanitizeModelAnswer(trimmed) || trimmed, sources: [] };
}

function mapError(error: unknown, signal: AbortSignal): RepoError {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new RepoError(504, "The AI request timed out. Please try again.");
  }
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) {
    return new RepoError(429, "AI rate limit or quota exceeded. Please try again later.");
  }
  if (status === 400 || status === 401 || status === 403) {
    return new RepoError(502, "The AI provider rejected the request. Check GEMINI_API_KEY.");
  }
  if (status === 404) {
    return new RepoError(502, "The configured Gemini model was not found. Set GEMINI_MODEL to a current model id.");
  }
  if (status === 503) {
    return new RepoError(503, "The AI model is busy right now. Please try again in a moment.");
  }
  return new RepoError(502, "The AI provider returned an error. Please try again.");
}

export function createGeminiGenerate(config: GeminiConfig): GenerateFn {
  if (!config.apiKey) {
    throw new Error("createGeminiGenerate requires an API key");
  }
  const ai = new GoogleGenAI({ apiKey: config.apiKey });

  return async ({ system, prompt, signal }) => {
    try {
      const response = await ai.models.generateContent({
        model: config.model,
        contents: prompt,
        config: {
          systemInstruction: system,
          temperature: 0.2,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          abortSignal: signal,
        },
      });
      return parseModelAnswer(response.text ?? "");
    } catch (error) {
      // Log only a short, non-sensitive marker — never the key or the prompt.
      console.error("Gemini request failed", (error as { status?: number } | null)?.status ?? "");
      throw mapError(error, signal);
    }
  };
}
