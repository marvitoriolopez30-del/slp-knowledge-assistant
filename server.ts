import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));

// =========================
// SUPABASE
// =========================
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// =========================
// EMBEDDING (OLLAMA)
// =========================
async function generateEmbedding(input: string): Promise<number[]> {
  const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nomic-embed-text',
      prompt: input,
    }),
  });

  const data = await res.json();

  if (!data.embedding) {
    console.error('Embedding error:', data);
    throw new Error('Embedding failed');
  }

  return data.embedding;
}

// =========================
// SIMPLE CHAT (OLLAMA)
// =========================
async function generateChat(prompt: string): Promise<string> {
  const res = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3',
      prompt,
      stream: false,
    }),
  });

  const data = await res.json();
  return data.response || 'No response';
}

// =========================
// PROCESS DOCUMENT (RAG)
// =========================
app.post('/api/process-document', async (req, res) => {
  try {
    const { documentId, text } = req.body;

    if (!documentId || !text) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // Split into chunks
    const chunks =
      (text.match(/[\s\S]{1,500}/g) || []).map((t: string) =>
        t.trim()
      );

    console.log('Chunks:', chunks.length);

    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk);

      await supabase.from('document_embeddings').insert({
        document_id: documentId,
        content: chunk,
        embedding,
      });
    }

    res.json({
      success: true,
      chunks: chunks.length,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// =========================
// CHAT RAG
// =========================
app.post('/api/chat-rag', async (req, res) => {
  try {
    const { message } = req.body;

    const queryEmbedding = await generateEmbedding(message);

    // Fetch embeddings
    const { data: docs, error } = await supabase
      .from('document_embeddings')
      .select('*')
      .limit(50);

    if (error) throw error;

    if (!docs || docs.length === 0) {
      return res.json({
        answer: 'No documents found. Upload files first.',
      });
    }

    // SIMPLE similarity (dot product)
    function similarity(a: number[], b: number[]) {
      return a.reduce((sum, val, i) => sum + val * b[i], 0);
    }

    const scored = docs.map((d: any) => ({
      ...d,
      score: similarity(queryEmbedding, d.embedding),
    }));

    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const context = top.map((t) => t.content).join('\n');

    const prompt = `
You are an SLP Knowledge Assistant.

Answer ONLY using the context below.
If not found, say "I don't know".

Context:
${context}

Question:
${message}
`;

    const answer = await generateChat(prompt);

    res.json({
      answer,
      matchedChunks: top.length,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// =========================
// CHAT SESSION (FIX 404)
// =========================
app.post('/api/chat-sessions', async (req, res) => {
  res.json({
    session: { id: crypto.randomUUID() },
  });
});

// =========================
// SERVER START
// =========================
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});