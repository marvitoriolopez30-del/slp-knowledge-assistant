import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "50mb" }));

// ==========================
// SUPABASE
// ==========================
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ==========================
// OLLAMA EMBEDDING
// ==========================
async function generateEmbedding(input: string) {
  const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: input
    })
  });

  const data = await res.json();

  if (!data.embedding) {
    console.error("Embedding error:", data);
    throw new Error("Embedding failed");
  }

  return data.embedding;
}

// ==========================
// OLLAMA CHAT
// ==========================
async function generateChat(prompt: string) {
  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3",
      stream: false,
      prompt
    })
  });

  const data = await res.json();

  return data.response || "No response";
}

// ==========================
// PROCESS DOCUMENT (RAG)
// ==========================
app.post("/api/process-document", async (req, res) => {
  try {
    const { documentId, text } = req.body;

    if (!documentId || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const chunks = (text.match(/[\s\S]{1,500}/g) || []).map((t: string) => t.trim());

    console.log("Processing chunks:", chunks.length);

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk);

      await supabase.from("document_embeddings").insert({
        document_id: documentId,
        content: chunk,
        embedding
      });
    }

    return res.json({ success: true });

  } catch (err: any) {
    console.error("PROCESS ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ==========================
// CHAT (RAG)
// ==========================
app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Missing message" });
    }

    // 1. Embed query
    const queryEmbedding = await generateEmbedding(message);

    // 2. Search in Supabase
    const { data } = await supabase.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 5
    });

    let context = "No data found";

    if (data && data.length > 0) {
      context = data.map((x: any) => x.content).join("\n\n");
    }

    // 3. Prompt
    const prompt = `You are an SLP Knowledge Assistant.

Answer ONLY using the context below.
If not found, say "I don't know".

Context:
${context}

Question:
${message}
`;

    // 4. Generate answer
    const answer = await generateChat(prompt);

    return res.json({ answer });

  } catch (err: any) {
    console.error("CHAT ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ==========================
// START SERVER + VITE
// ==========================
async function start() {
  const vite = await createViteServer({
    server: { middlewareMode: true }
  });

  app.use(vite.middlewares);

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();