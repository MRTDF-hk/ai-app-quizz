import { QuizPayloadSchema, validateCorrectAnswer } from "@/lib/quiz/schema";
import type { QuizPayload } from "@/lib/quiz/types";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
  }>;
};

function getOpenRouterApiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("Lipsește OPENROUTER_API_KEY în variabilele de mediu.");
  return key;
}

function getOpenRouterModel() {
  return process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct";
}

function extractJsonCandidate(text: string) {
  // Prefer fenced JSON blocks if the model returns them.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  // Fall back to the first JSON object/array we can find.
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const start = Math.min(
    firstObj === -1 ? Number.POSITIVE_INFINITY : firstObj,
    firstArr === -1 ? Number.POSITIVE_INFINITY : firstArr,
  );
  if (start === Number.POSITIVE_INFINITY) return text.trim();

  const trimmed = text.slice(start).trim();
  const startsWithObj = trimmed.startsWith("{");
  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");

  if (startsWithObj) {
    if (lastBrace !== -1 && lastBrace > start) return text.slice(start, lastBrace + 1).trim();
    return trimmed;
  }

  if (trimmed.startsWith("[")) {
    if (lastBracket !== -1 && lastBracket > start) return text.slice(start, lastBracket + 1).trim();
    return trimmed;
  }

  return trimmed;
}

function parseQuizPayload(aiText: string): QuizPayload {
  const candidate = extractJsonCandidate(aiText);
  const parsed = JSON.parse(candidate);
  return QuizPayloadSchema.parse(parsed);
}

export async function generateQuizFromExtractedText(
  extractedText: string,
  opts?: {
    questionCount?: number;
    maxRetries?: number;
    additionalInstructions?: string;
  },
) {
  const questionCount = opts?.questionCount ?? 5;
  const maxRetries = opts?.maxRetries ?? 2;
  const additionalInstructions = opts?.additionalInstructions?.trim();
  const finalAdditionalInstructions =
    additionalInstructions && additionalInstructions.length > 1200
      ? additionalInstructions.slice(0, 1200)
      : additionalInstructions;

  const apiKey = getOpenRouterApiKey();
  const model = getOpenRouterModel();

  const system = [
    "Ești un profesor care creează teste-grilă în limba română.",
    "Trebuie să respecți formatul de ieșire JSON STRICT, fără niciun text în afara JSON-ului.",
    "Scrie TOATE texturile (întrebări, opțiuni, răspuns corect) în limba română.",
  ].join("\n");

  const user = (text: string) =>
    [
      "Primești conținut extras dintr-un PDF.",
      "Creează un quiz grilă cu un MINIM de " + questionCount + " întrebări (exact " + questionCount + " dacă e posibil).",
      "",
      "Cerințe pentru fiecare întrebare:",
      "- 4 opțiuni (A, B, C, D) în ordine în câmpul `options` ca listă de 4 stringuri.",
      "- `correctAnswer` trebuie să fie EXACT egal cu UNA dintre valorile din `options`.",
      "- O singură opțiune corectă.",
      "",
      finalAdditionalInstructions
        ? [
            "Instrucțiuni suplimentare (urmează-le la maximum, fără a încălca cerințele de JSON și română):",
            finalAdditionalInstructions,
            "",
          ].join("\n")
        : "",
      "Alege întrebări clare, distincte și corelate cu conținutul.",
      "Dacă textul e insuficient, generează întrebări rezonabile, dar evită afirmații inventate.",
      "",
      "CONȚINUT PDF (extras):",
      text,
      "",
      "FORMĂ DE IEȘIRE (JSON STRICT):",
      "{ \"quiz\": [ { \"question\": \"...\", \"options\": [\"A\", \"B\", \"C\", \"D\"], \"correctAnswer\": \"...\" } ] }",
    ].join("\n");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const bodyBase = {
    model,
    temperature: 0.2,
    top_p: 0.95,
    // OpenRouter acceptă max_tokens.
    max_tokens: 1200,
  };

  let lastErr: unknown = null;
  const TIMEOUT_MS = 35000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const resp = await fetch(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          ...bodyBase,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user(extractedText) },
          ],
        }),
      });

      clearTimeout(timeoutId);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`Eșec API AI: HTTP ${resp.status}. ${text}`.trim());
      }

      const json = (await resp.json()) as OpenRouterChatCompletionResponse;
      const aiText: string =
        json.choices?.[0]?.message?.content ??
        json.choices?.[0]?.delta?.content ??
        "";

      if (!aiText || aiText.trim().length === 0) {
        throw new Error("Răspuns AI gol (fără conținut).");
      }

      const payload = parseQuizPayload(aiText);

      const quiz = payload.quiz;
      if (quiz.length < questionCount) {
        throw new Error(
          `Quiz generat cu ${quiz.length} întrebări, dar se cer minim ${questionCount}.`,
        );
      }

      // Validate correctAnswer relationship (defense-in-depth).
      for (const q of quiz) {
        if (!validateCorrectAnswer(q)) {
          throw new Error("validare eșuată: `correctAnswer` nu este în options.");
        }
      }

      // If AI returned more than required, keep first questionCount.
      return {
        quiz: quiz.slice(0, questionCount),
      };
    } catch (err) {
      lastErr = err;
    } finally {
      // N-are efect dacă fetch a terminat deja, dar curăță timeout-ul.
      // (abort controller rămâne local)
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Eșec generare quiz.");
}

