import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {

    const { documentId } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: "Document ID required" });
    }

    // Fetch document metadata
    const { data: doc, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (error || !doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Download file from Supabase Storage
    const { data: fileData } = await supabase.storage
      .from("knowledge")
      .download(doc.file_path);

    if (!fileData) {
      return res.status(500).json({ error: "File download failed" });
    }

    // Convert file to text (basic placeholder)
    const textContent = await fileData.text();

    // Generate embedding for semantic search
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: textContent,
    });

    // Update document record
    await supabase
      .from("documents")
      .update({
        content_text: textContent,
        embedding: embedding.data[0].embedding,
      })
      .eq("id", documentId);

    return res.status(200).json({
      success: true,
      message: "Document processed successfully",
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: "Document processing failed",
    });

  }
}