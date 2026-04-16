import { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const supabase = createClient(
process.env.SUPABASE_URL!,
process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function splitText(text: string): string[] {
return (text.match(/[\s\S]{1,1000}/g) || [])
.map(t => t.trim())
.filter(Boolean);
}

async function getEmbedding(text: string) {
const res = await fetch("http://127.0.0.1:11434/api/embeddings", {
method: "POST",
headers: {
"Content-Type": "application/json"
},
body: JSON.stringify({
model: "nomic-embed-text",
prompt: text
})
});

const data = await res.json();

if (!data.embedding) {
throw new Error("Embedding failed");
}

return data.embedding;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const body = req.body;
const documentId = body.documentId;
const text = body.text;

if (!documentId || !text) {
  return res.status(400).json({ error: "Missing data" });
}

const chunks = splitText(text);

for (let i = 0; i < chunks.length; i++) {
  const id = randomUUID();

  const embedding = await getEmbedding(chunks[i]);

  await supabase.from("document_chunks").insert({
    id: id,
    document_id: documentId,
    content: chunks[i]
  });

  await supabase.from("document_embeddings").insert({
    chunk_id: id,
    embedding: embedding
  });
}

return res.status(200).json({ success: true });

} catch (err: any) {
console.error(err);
return res.status(500).json({
error: err.message
});
}
}
