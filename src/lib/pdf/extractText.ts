import { PDFParse, VerbosityLevel } from "pdf-parse";

export async function extractPdfText(
  buffer: Buffer,
  opts?: {
    maxChars?: number;
  },
) {
  const maxChars = opts?.maxChars ?? 12000;

  const parser = new PDFParse({
    data: buffer,
    verbosity: VerbosityLevel.ERRORS,
  });

  try {
    const result = await parser.getText();
    const rawText = typeof result.text === "string" ? result.text : "";

    // Normalize whitespace so prompts stay compact.
    const normalized = rawText.replace(/\s+/g, " ").trim();

    if (normalized.length <= maxChars) return normalized;
    return normalized.slice(0, maxChars);
  } finally {
    await parser.destroy();
  }
}

