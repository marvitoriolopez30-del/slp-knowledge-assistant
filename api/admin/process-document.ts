import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_EMBEDDINGS_API_URL =
  process.env.NVIDIA_EMBEDDINGS_API_URL || "https://integrate.api.nvidia.com/v1/embeddings";
const NVIDIA_EMBEDDING_MODEL = process.env.NVIDIA_EMBEDDING_MODEL || "baai/bge-m3";

const CHUNK_SIZE = 1000;

function chunkText(text: string): string[] {
  return (text.match(/[\s\S]{1,1000}/g) || []).map((chunk) => chunk.trim()).filter(Boolean);
}

function getStoragePathFromUrl(fileUrl: string): string | null {
  const marker = '/storage/v1/object/public/knowledge/';
  const index = fileUrl.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(fileUrl.substring(index + marker.length));
}

async function downloadFile(fileUrl: string) {
  const storagePath = getStoragePathFromUrl(fileUrl);

  if (storagePath) {
    const { data, error } = await supabase.storage.from('knowledge').download(storagePath);
    if (error || !data) {
      throw new Error(`Supabase storage download failed: ${error?.message || 'unknown error'}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from URL: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function generateEmbedding(input: string) {
  if (!NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is required for embeddings.");
  }

  console.log("Embedding request config", {
    model: NVIDIA_EMBEDDING_MODEL,
    url: NVIDIA_EMBEDDINGS_API_URL,
    hasApiKey: !!NVIDIA_API_KEY,
    inputPreview: input.slice(0, 120),
  });

  const response = await fetch(NVIDIA_EMBEDDINGS_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_EMBEDDING_MODEL,
      input,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("NVIDIA embedding raw error:", errorText);
    throw new Error(`NVIDIA embedding request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const embedding =
    data?.data?.[0]?.embedding ??
    data?.data?.[0]?.vector ??
    data?.embedding ??
    data?.vector;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    console.error("NVIDIA embedding returned invalid data:", data);
    throw new Error("NVIDIA embedding returned invalid vector data.");
  }

  return embedding;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { documentId, fileUrl, fileName, folder } = req.body;

    if (!documentId || !fileUrl || !fileName) {
      return res.status(400).json({ error: "documentId, fileUrl, and fileName are required" });
    }

    const buffer = await downloadFile(fileUrl);
    const ext = fileName.toLowerCase().split(".").pop() || "";

    let text = "";

    if (ext === "pdf") {
      // @ts-ignore
      const pdf = (await import("pdf-parse")).default;
      const data = await pdf(buffer);
      text = data.text;
    } else if (ext === "docx") {
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === "xlsx" || ext === "csv") {
      const xlsx = await import("xlsx");
      const workbook = xlsx.read(buffer, { type: "buffer" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      text = xlsx.utils.sheet_to_txt(sheet);
    } else {
      text = buffer.toString("utf-8");
    }

    const chunks = chunkText(text);

    if (!chunks.length) {
      return res.status(200).json({
        success: true,
        message: "No extractable text found",
        chunksProcessed: 0,
      });
    }

    const chunkRows: any[] = [];
    const embeddingRows: any[] = [];

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const chunkId = randomUUID();
      const embedding = await generateEmbedding(chunk);

      chunkRows.push({
        id: chunkId,
        document_id: documentId,
        chunk_index: index,
        content: chunk,
        chunk_size: chunk.length,
      });

      embeddingRows.push({
        chunk_id: chunkId,
        embedding,
      });
    }

    const { error: chunkError } = await supabase.from("document_chunks").insert(chunkRows);
    if (chunkError) {
      throw chunkError;
    }

    const { error: embeddingError } = await supabase.from("document_embeddings").insert(embeddingRows);
    if (embeddingError) {
      throw embeddingError;
    }

    return res.status(200).json({
      success: true,
      message: "Document processed successfully",
      chunksProcessed: chunkRows.length,
      chunkSize: CHUNK_SIZE,
    });
  } catch (error: any) {
    console.error("Processing error:", error);
    return res.status(500).json({
      error: error?.message || "Document processing failed",
    });
  }
}
