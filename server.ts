import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import levenshtein from 'js-levenshtein';
import dotenv from 'dotenv';

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

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key', // Avoid crashing if key is missing
});

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
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. Vector Search in Supabase (using rpc match_documents)
    const { data: documents, error: matchError } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.5,
      match_count: 5,
    });

    if (matchError) throw matchError;

    const context = documents?.map((d: any) => d.content).join('\n\n') || 'No relevant documents found.';

    // 3. Generate response with OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You are the SLP Knowledge Assistant. Answer questions based ONLY on the provided context from SLP documents. If the answer is not in the context, say you don't know. Use tables or charts (in markdown format) when appropriate.
        
        Context:
        ${context}` },
        ...history,
        { role: 'user', content: message },
      ],
    });

    const responseText = completion.choices[0].message.content;

    res.json({ 
      response: responseText, 
      sources: documents?.map((d: any) => ({ 
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
  const { documentId } = req.body;

  try {
    // Document processing already handled by upload endpoint
    // This is a no-op endpoint for backwards compatibility
    res.json({ 
      success: true, 
      message: "Document processing complete" 
    });
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
