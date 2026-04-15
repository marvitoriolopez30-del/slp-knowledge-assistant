import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import levenshtein from 'js-levenshtein';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

console.log('Starting server initialization...');

app.use(express.json({ limit: '50mb' }));

// Initialize Supabase (Service Role for backend operations)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl) {
  console.warn('Warning: SUPABASE_URL is not defined in environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

const NVIDIA_API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_EMBEDDINGS_API_URL = process.env.NVIDIA_EMBEDDINGS_API_URL || 'https://integrate.api.nvidia.com/v1/embeddings';
const NVIDIA_RERANK_API_URL = process.env.NVIDIA_RERANK_API_URL || 'https://integrate.api.nvidia.com/v1/ranking';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'openai/gpt-oss-120b';
const NVIDIA_FALLBACK_MODEL = process.env.NVIDIA_FALLBACK_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const NVIDIA_EMBEDDING_MODEL = process.env.NVIDIA_EMBEDDING_MODEL || 'baai/bge-m3';
const NVIDIA_RERANK_MODEL = process.env.NVIDIA_RERANK_MODEL || 'nvidia/llama-nemotron-rerank-1b-v2';
const CHAT_PROVIDER = (process.env.CHAT_PROVIDER || 'nvidia').toLowerCase();
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '';
const RAG_CANDIDATE_COUNT = Number(process.env.RAG_CANDIDATE_COUNT || 8);
const RAG_FINAL_CONTEXT_COUNT = Number(process.env.RAG_FINAL_CONTEXT_COUNT || 5);
const LONG_CONTEXT_THRESHOLD = Number(process.env.LONG_CONTEXT_THRESHOLD || 8000);

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type RetrievedDocument = {
  document_id: string;
  content: string;
  file_name: string;
  folder: string;
  similarity?: number;
};

function ensureNvidiaApiKey() {
  if (!NVIDIA_API_KEY) {
    throw new Error('NVIDIA_API_KEY is required for NVIDIA models.');
  }
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
  ensureNvidiaApiKey();

  const response = await fetch(NVIDIA_EMBEDDINGS_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_EMBEDDING_MODEL,
      input,
      encoding_format: 'float',
      truncate: 'END',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA embedding request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data?.data?.[0]?.embedding || [];
}

async function rerankDocuments(query: string, documents: RetrievedDocument[]) {
  ensureNvidiaApiKey();

  if (!documents.length) return documents;

  const response = await fetch(NVIDIA_RERANK_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: NVIDIA_RERANK_MODEL,
      query: { text: query },
      passages: documents.map((document) => ({ text: document.content })),
      truncate: 'END',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(`NVIDIA rerank request failed (${response.status}): ${errorText}`);
    return documents;
  }

  const data = await response.json();
  const rankings = data?.rankings || data?.data || [];

  if (!Array.isArray(rankings) || !rankings.length) {
    return documents;
  }

  const scored = rankings
    .map((ranking: any, index: number) => {
      const passageIndex = typeof ranking?.index === 'number'
        ? ranking.index
        : typeof ranking?.passage_index === 'number'
          ? ranking.passage_index
          : typeof ranking?.id === 'number'
            ? ranking.id
            : index;
      const score = Number(
        ranking?.score ??
        ranking?.logit ??
        ranking?.relevance_score ??
        0
      );
      const document = documents[passageIndex];

      if (!document) return null;

      return { ...document, rerankScore: score };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.rerankScore - a.rerankScore);

  return scored.length ? scored : documents;
}

async function requestChatCompletion(model: string, messages: ChatMessage[]) {
  ensureNvidiaApiKey();

  const response = await fetch(NVIDIA_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 768,
      temperature: 0.2,
      top_p: 0.9,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA chat request failed for ${model} (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || '';
}

async function generateChatCompletion(messages: ChatMessage[], contextLength: number) {
  if (CHAT_PROVIDER === 'nvidia') {
    const preferredModel = contextLength > LONG_CONTEXT_THRESHOLD
      ? NVIDIA_FALLBACK_MODEL
      : NVIDIA_MODEL;
    const backupModel = preferredModel === NVIDIA_MODEL ? NVIDIA_FALLBACK_MODEL : NVIDIA_MODEL;

    try {
      return await requestChatCompletion(preferredModel, messages);
    } catch (error: any) {
      const failedMessage = String(error?.message || '');
      const shouldFallback =
        preferredModel !== backupModel &&
        (failedMessage.includes('429') ||
          failedMessage.includes('quota') ||
          failedMessage.includes('rate') ||
          failedMessage.includes('capacity') ||
          failedMessage.includes('503'));

      if (!shouldFallback) throw error;

      console.warn(`Primary model failed, retrying with fallback model ${backupModel}.`);
      return await requestChatCompletion(backupModel, messages);
    }
  }

  throw new Error(`Unsupported CHAT_PROVIDER: ${CHAT_PROVIDER}`);
}

// --- API Routes ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Beneficiary Name Matching (Levenshtein)
app.post('/api/beneficiaries/search', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const { data: beneficiaries, error } = await supabase
      .from('beneficiaries')
      .select('*');

    if (error) throw error;

    const results = beneficiaries.map(b => {
      const distance = levenshtein(name.toLowerCase(), b.name.toLowerCase());
      const maxLength = Math.max(name.length, b.name.length);
      const similarity = ((maxLength - distance) / maxLength) * 100;
      return { ...b, similarity: Math.round(similarity) };
    });

    const bestMatch = results.sort((a, b) => b.similarity - a.similarity)[0];

    res.json({ bestMatch, allResults: results.filter(r => r.similarity > 50) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// RAG: Chat with Documents
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;

  try {
    // 1. Generate embedding for the query
    const queryEmbedding = await generateEmbedding(message);

    // 2. Vector Search in Supabase (using rpc match_documents)
    const { data: documents, error: matchError } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.5,
      match_count: RAG_CANDIDATE_COUNT,
    });

    if (matchError) throw matchError;

    const rerankedDocuments = await rerankDocuments(message, (documents || []) as RetrievedDocument[]);
    const selectedDocuments = rerankedDocuments.slice(0, RAG_FINAL_CONTEXT_COUNT);
    const context = selectedDocuments.length
      ? selectedDocuments.map((d: RetrievedDocument, index: number) => `[Source ${index + 1}] ${d.content}`).join('\n\n')
      : 'No relevant documents found.';
    const contextLength = context.length + JSON.stringify(history).length + message.length;

    // 3. Generate response with the configured chat provider
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are the SLP Knowledge Assistant. Answer questions based ONLY on the provided context from SLP documents.
If the answer is not in the context, say you don't know.
If the user asks for analysis, summarize key findings first and use markdown tables when helpful.
If the user asks for chart data, provide a short explanation followed by a JSON object with this shape:
{"chartType":"bar|line|pie","title":"string","labels":["..."],"datasets":[{"label":"string","data":[1,2,3]}]}
Only provide chart JSON when the context contains enough data to support it.

Context:
${context}`,
      },
      ...history,
      { role: 'user', content: message },
    ];

    const responseText = await generateChatCompletion(messages, contextLength);

    res.json({ 
      response: responseText, 
      sources: selectedDocuments.map((d: RetrievedDocument) => ({ 
        file_name: d.file_name, 
        folder: d.folder,
        id: d.document_id 
      })) 
    });
  } catch (error: any) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Document Processing (Admin only - simplified for demo)
app.post('/api/admin/process-document', async (req, res) => {
  const { documentId, fileUrl, fileName, folder } = req.body;

  try {
    // Dynamic imports to avoid startup issues with CJS/ESM compatibility
    // @ts-ignore
    const pdf = (await import('pdf-parse')).default;
    const mammoth = (await import('mammoth')).default;
    const xlsx = await import('xlsx');

    // Fetch file from Supabase Storage
    const buffer = await downloadFile(fileUrl);

    let text = '';
    const ext = path.extname(fileName).toLowerCase();

    if (ext === '.pdf') {
      const data = await pdf(buffer);
      text = data.text;
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === '.xlsx' || ext === '.csv') {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      text = xlsx.utils.sheet_to_txt(sheet);
    } else {
      text = buffer.toString('utf-8');
    }

    // Chunk text
    const chunks = text.match(/[\s\S]{1,1000}/g) || [];

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

    const { error: chunkError } = await supabase.from('document_chunks').insert(chunkRows);
    if (chunkError) {
      throw chunkError;
    }

    const { error: embeddingError } = await supabase.from('document_embeddings').insert(embeddingRows);
    if (embeddingError) {
      throw embeddingError;
    }

    res.json({ success: true, chunksProcessed: chunkRows.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// --- Vite Middleware ---

// Export for Vercel
export default app;

async function startServer() {
  try {
    console.log('Initializing Vite server...');
    if (process.env.NODE_ENV !== 'production') {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log('Vite middleware attached.');
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
      console.log('Production static middleware attached.');
    }

    if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://0.0.0.0:${PORT}`);
      });
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    if (process.env.NODE_ENV !== 'production') process.exit(1);
  }
}

// Only start the server if we're not in Vercel (Vercel handles the listening)
if (!process.env.VERCEL) {
  startServer().catch(err => {
    console.error('Unhandled error in startServer:', err);
  });
}
