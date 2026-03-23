import { NextResponse } from "next/server";
import { createHash } from "crypto";

import { extractPdfText } from "@/lib/pdf/extractText";
import { generateQuizFromExtractedText } from "@/lib/ai/generateQuiz";
import { getCachedQuiz, setCachedQuiz } from "@/lib/cache/quizCache";

import type { QuizPayload } from "@/lib/quiz/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_INSTRUCTIONS_CHARS = 1400;

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

type UploadFileLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
  type?: string;
  name?: string;
};

function isUploadFileLike(value: unknown): value is UploadFileLike {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { arrayBuffer?: unknown };
  return typeof maybe.arrayBuffer === "function";
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || "";

    let regenerate = false;
    let questionCount = 5;
    let instructionsText = "";
    let buf: Buffer | null = null;
    let mime = "application/pdf";
    let name = "fișier";

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as {
        url?: string;
        regenerate?: boolean;
        questionCount?: number;
        instructions?: string;
        fileName?: string;
      };

      if (!body.url || typeof body.url !== "string") {
        return errorResponse("Nu a fost trimis niciun URL pentru PDF.", 400);
      }

      regenerate = Boolean(body.regenerate);
      questionCount =
        typeof body.questionCount === "number" && Number.isFinite(body.questionCount)
          ? Math.max(5, Math.min(15, body.questionCount))
          : 5;

      instructionsText = typeof body.instructions === "string" ? body.instructions.trim() : "";

      const pdfRes = await fetch(body.url);
      if (!pdfRes.ok) {
        return errorResponse("Nu am putut descărca PDF-ul din Blob.", 400);
      }

      const arrayBuffer = await pdfRes.arrayBuffer();
      buf = Buffer.from(arrayBuffer);
      name = body.fileName || name;
      mime = "application/pdf";
    } else {
      const formData = await req.formData();
      const file = formData.get("file");
      const regenerateRaw = formData.get("regenerate");
      const questionCountRaw = formData.get("questionCount");
      const instructionsRaw = formData.get("instructions");

      if (!isUploadFileLike(file)) {
        return errorResponse("Nu a fost trimis niciun fișier.", 400);
      }

      regenerate =
        typeof regenerateRaw === "string" &&
        (regenerateRaw === "1" || regenerateRaw.toLowerCase() === "true");

      questionCount =
        typeof questionCountRaw === "string" && Number.isFinite(Number(questionCountRaw))
          ? Math.max(5, Math.min(15, Number(questionCountRaw)))
          : 5;

      instructionsText = typeof instructionsRaw === "string" ? instructionsRaw.trim() : "";

      const arrayBuffer = await file.arrayBuffer();
      buf = Buffer.from(arrayBuffer);
      mime = file.type || mime;
      name = file.name || name;
    }

    if (!buf) return errorResponse("Fișier/URL invalid.", 400);

    if (buf.byteLength === 0) return errorResponse("Fișierul este gol.", 400);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return errorResponse("Fișier prea mare. Limita este 10MB.", 400);
    }

    const looksLikePdf = mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
    if (!looksLikePdf) return errorResponse("Fișier invalid. Trimite un PDF.", 400);

    const pdfSha = sha256(buf);
    const finalInstructionsText =
      instructionsText.length > MAX_INSTRUCTIONS_CHARS
        ? instructionsText.slice(0, MAX_INSTRUCTIONS_CHARS)
        : instructionsText;
    const instructionsSha = finalInstructionsText
      ? sha256(Buffer.from(finalInstructionsText, "utf8"))
      : "none";
    const cacheKey = `${pdfSha}:q${questionCount}:i${instructionsSha}`;

    if (!regenerate) {
      const cached = getCachedQuiz(cacheKey);
      if (cached) {
        return NextResponse.json({ ...cached, cached: true });
      }
    }

    let extractedText: string;
    try {
      extractedText = await extractPdfText(buf, { maxChars: 12000 });
    } catch (error) {
      console.error("PDF extraction error:", error);
      return errorResponse("Nu am putut citi PDF-ul (sau este corupt).", 400);
    }

    if (!extractedText || extractedText.trim().length < 40) {
      return errorResponse("Textul extras din PDF este prea scurt (PDF invalid sau fără conținut).", 400);
    }

    const quizPayload: QuizPayload = await generateQuizFromExtractedText(
      extractedText,
      {
        questionCount,
        maxRetries: 2,
        additionalInstructions: finalInstructionsText || undefined,
      },
    );

    setCachedQuiz(cacheKey, pdfSha, quizPayload);

    return NextResponse.json({ ...quizPayload, cached: false });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Eroare necunoscută la generarea quiz-ului.";
    return errorResponse(message, 500);
  }
}

