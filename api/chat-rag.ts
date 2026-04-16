import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const supabase = createClient(
process.env.SUPABASE_URL!,
process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const body = req.body;
const userId = body.userId;
const message = body.message;

if (!userId || !message) {
  return res.status(400).json({ error: "Missing fields" });
}

// EMBEDDING
const embedRes = await fetch("http://127.0.0.1:11434/api/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "nomic-embed-text",
    prompt: message
  })
});

const embedData = await embedRes.json();

if (!embedData.embedding) {
  throw new Error("Embedding failed");
}

const queryEmbedding = embedData.embedding;

// SEARCH
const { data } = await supabase.rpc("match_documents", {
  query_embedding: queryEmbedding,
  match_threshold: 0.3,
  match_count: 5
});

let context = "No data found";

if (data && data.length > 0) {
  context = data.map((x: any) => x.content).join("\n\n");
}

// CHAT
const chatRes = await fetch("http://127.0.0.1:11434/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "llama3",
    stream: false,
    prompt: `You are an assistant for the Sustainable Livelihood Program (SLP).

Use ONLY the context below.

Context:
${context}

Question:
${message}

Answer clearly.`,
  }),
});

const chatData = await chatRes.json();

return res.status(200).json({
  answer: chatData.response || "No response from model.",
});
} catch (err: any) {
console.error(err);
return res.status(500).json({
error: err.message
});
}
}
