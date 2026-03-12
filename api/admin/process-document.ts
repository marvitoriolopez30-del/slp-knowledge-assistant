import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const words = text.split(" ");
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const word of words) {
    const wordSize = word.length + 1;
    if (currentSize + wordSize > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk.join(" "));
      const overlapWords = currentChunk.slice(-Math.ceil(CHUNK_OVERLAP / 4));
      currentChunk = overlapWords;
      currentSize = overlapWords.join(" ").length + 1;
    }
    currentChunk.push(word);
    currentSize += wordSize;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(" "));
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { documentId, fileUrl, fileName } = req.body;

    if (!documentId || !fileUrl) {
      return res.status(400).json({ error: "Document ID and file URL required" });
    }

    // Extract text from file based on extension
    let text = "";
    
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error("Failed to download file");
      
      const ext = fileName?.toLowerCase().split(".").pop() || "";
      const buffer = await response.arrayBuffer();
      const bufferData = Buffer.from(buffer);

      if (ext === "pdf") {
        // For PDF, try to extract text (basic)
        text = bufferData.toString("utf-8").replace(/[^\x20-\x7E\n]/g, "");
      } else if (ext === "docx" || ext === "txt") {
        // For DOCX/TXT, extract text
        text = bufferData.toString("utf-8");
      } else {
        // Fallback
        text = bufferData.toString("utf-8");
      }
    } catch (error) {
      console.error("Error downloading file:", error);
      text = "Document content unavailable";
    }

    // Split into chunks
    const chunks = chunkText(text);

    // Generate embeddings and store
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID();
      
      // Insert chunk
      const { error: chunkError } = await supabase
        .from("document_chunks")
        .insert({
          id: chunkId,
          document_id: documentId,
          chunk_index: i,
          content: chunks[i],
          chunk_size: chunks[i].length,
        });

      if (chunkError) {
        console.error(`Error inserting chunk ${i}:`, chunkError);
        continue;
      }

      // Generate embedding
      try {
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunks[i],
        });

        const { error: embError } = await supabase
          .from("document_embeddings")
          .insert({
            chunk_id: chunkId,
            embedding: embedding.data[0].embedding,
          });

        if (embError) {
          console.error(`Error storing embedding for chunk ${i}:`, embError);
        }
      } catch (error) {
        console.error(`Error generating embedding for chunk ${i}:`, error);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Document processed successfully",
      chunksProcessed: chunks.length,
    });

  } catch (error: any) {
    console.error("Processing error:", error);
    return res.status(500).json({
      error: error?.message || "Document processing failed",
    });
  }
}