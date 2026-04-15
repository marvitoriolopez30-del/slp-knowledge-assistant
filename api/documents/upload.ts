import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Chunk size for splitting documents
const CHUNK_SIZE = 500; // tokens roughly = chars * 0.25
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
      // Keep overlap
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

// Generate embeddings using Nvidia API
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch(
    process.env.NVIDIA_EMBEDDINGS_API_URL || "https://integrate.api.nvidia.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_EMBEDDING_MODEL || "baai/bge-m3",
        input: text,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("Nvidia embedding error:", error);
    throw new Error(`Nvidia API error: ${response.status}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userId, fileName, fileContent, folder } = req.body;

    if (!userId || !fileName || !fileContent || !folder) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify user is admin
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (!profile || profile.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Create document record
    const documentId = randomUUID();
    const { error: docError } = await supabase.from("documents").insert({
      id: documentId,
      file_name: fileName,
      folder,
      file_url: `https://${process.env.SUPABASE_URL?.split(".")[0]}.supabase.co/storage/v1/object/public/knowledge/${folder}/${fileName}`,
      file_size: fileContent.length,
      file_type: fileName.split(".").pop(),
      uploaded_by: userId,
    });

    if (docError) throw docError;

    // Split into chunks
    const chunks = chunkText(fileContent);

    // Store chunks
    const chunkIds: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID();
      const { error: chunkError } = await supabase
        .from("document_chunks")
        .insert({
          id: chunkId,
          document_id: documentId,
          chunk_index: i,
          content: chunks[i],
          chunk_size: chunks[i].length,
        });

      if (chunkError) throw chunkError;
      chunkIds.push(chunkId);
    }

    // Generate embeddings for each chunk using Nvidia API
    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await generateEmbedding(chunks[i]);

        const { error: embError } = await supabase
          .from("document_embeddings")
          .insert({
            chunk_id: chunkIds[i],
            embedding: embedding,
          });

        if (embError) throw embError;
      } catch (error) {
        console.error(`Error embedding chunk ${i}:`, error);
        // Continue with other chunks
      }
    }

    return res.status(200).json({
      success: true,
      documentId,
      chunksCreated: chunks.length,
      message: "Document processed and embeddings generated successfully",
    });
  } catch (error: any) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
