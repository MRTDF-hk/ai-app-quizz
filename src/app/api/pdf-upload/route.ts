import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";
export const maxDuration = 30;

// Route called by the client-side Vercel Blob SDK to:
// - generate short-lived upload tokens
// - receive upload completion callbacks (optional)
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // IMPORTANT:
        // - we allow only PDFs
        // - Vercel's blob security flow uses short-lived tokens exchanged with the server
        return {
          allowedContentTypes: ["application/pdf"],
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({}),
        };
      },
      onUploadCompleted: async () => {
        // No DB update needed for this demo.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Eroare la upload Blob.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

