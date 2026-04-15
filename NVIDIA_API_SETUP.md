## Environment Variables for Nvidia API (Advanced Setup)

Set these in your Vercel deployment and local `.env.local`:

```
# Primary Chat Model
NVIDIA_MODEL=openai/gpt-oss-120b

# Fallback Model (if primary fails)
NVIDIA_FALLBACK_MODEL=nvidia/nemotron-3-super-120b-a12b

# Embedding Model
NVIDIA_EMBEDDING_MODEL=nvidia/llama-3_2-nemoretriever-300m-embed-v2

# Reranking Model
NVIDIA_RERANK_MODEL=nvidia/llama-nemotron-rerank-1b-v2
NVIDIA_RERANK_API_URL=https://integrate.api.nvidia.com/v1/ranking

# Chat API Configuration
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1/chat/completions
CHAT_PROVIDER=nvidia

# API Key
NVIDIA_API_KEY=your_nvidia_api_key
```

### How This System Works

**1. Document Embedding (Upload)**
- Uses: `nvidia/llama-3_2-nemoretriever-300m-embed-v2`
- Converts documents into 768-dimensional vectors
- Stored in pgvector (database)

**2. Query Processing (Chat)**
- Question is converted to embedding using same model
- Vector similarity search finds top 10 matches
- Results are sent to reranking model

**3. Reranking (New!)**
- Uses: `nvidia/llama-nemotron-rerank-1b-v2`
- Reranks top 10 results by relevance
- Picks top 5 best matches
- Sends to LLM for answer generation

**4. Answer Generation**
- Primary: `openai/gpt-oss-120b`
- Fallback: `nvidia/nemotron-3-super-120b-a12b` (if primary fails)
- Combines SLP context + user question
- Generates professional government-ready responses

### Models Overview

| Component | Model | Use Case |
|-----------|-------|----------|
| **Embedding** | `nvidia/llama-3_2-nemoretriever-300m-embed-v2` | Convert text → 768-dim vectors |
| **Reranking** | `nvidia/llama-nemotron-rerank-1b-v2` | Rank search results by relevance |
| **Chat (Primary)** | `openai/gpt-oss-120b` | Generate answers with context |
| **Chat (Fallback)** | `nvidia/nemotron-3-super-120b-a12b` | Backup model if primary fails |

### Get Your Nvidia API Key

1. **Create Nvidia Account**
   - Go to https://www.nvidia.com/en-us/ai-data-science/generative-ai/
   - Sign up or login

2. **Get API Key**
   - Visit: https://integrate.api.nvidia.com/
   - Click "Get API Key" or "API Keys"
   - Generate new API key
   - Copy: `NVIDIA_API_KEY=nvapi_xxx...`

3. **Test Connection**
   ```bash
   curl -X POST "https://integrate.api.nvidia.com/v1/embeddings" \
     -H "Authorization: Bearer $NVIDIA_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "model": "nvidia/llama-3_2-nemoretriever-300m-embed-v2",
       "input": "test"
     }'
   ```

### Setup Steps

#### Step 1: Add to Vercel Environment

Go to **Vercel Dashboard → Project Settings → Environment Variables**

Add these variables:
```
NVIDIA_MODEL = openai/gpt-oss-120b
NVIDIA_FALLBACK_MODEL = nvidia/nemotron-3-super-120b-a12b
NVIDIA_EMBEDDING_MODEL = nvidia/llama-3_2-nemoretriever-300m-embed-v2
NVIDIA_RERANK_MODEL = nvidia/llama-nemotron-rerank-1b-v2
NVIDIA_RERANK_API_URL = https://integrate.api.nvidia.com/v1/ranking
NVIDIA_API_URL = https://integrate.api.nvidia.com/v1/chat/completions
CHAT_PROVIDER = nvidia
NVIDIA_API_KEY = your_api_key
```

#### Step 2: Deploy

```bash
git push origin main
# Vercel auto-redeploys
```

#### Step 3: Test

Upload a document and ask your chatbot a question. It should:
- ✅ Find relevant documents
- ✅ Rerank them for best matches
- ✅ Generate answer using GPT-OSS-120B
- ✅ Show source citations

### Local Testing

Create `.env.local`:
```
NVIDIA_MODEL=openai/gpt-oss-120b
NVIDIA_FALLBACK_MODEL=nvidia/nemotron-3-super-120b-a12b
NVIDIA_EMBEDDING_MODEL=nvidia/llama-3_2-nemoretriever-300m-embed-v2
NVIDIA_RERANK_MODEL=nvidia/llama-nemotron-rerank-1b-v2
NVIDIA_RERANK_API_URL=https://integrate.api.nvidia.com/v1/ranking
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1/chat/completions
NVIDIA_API_KEY=your_key
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
```

Run:
```bash
npm run dev
```

### API Endpoints Used

**1. Embeddings**
```
POST https://integrate.api.nvidia.com/v1/embeddings
Model: nvidia/llama-3_2-nemoretriever-300m-embed-v2
Output: 768-dimensional vectors
```

**2. Reranking**
```
POST https://integrate.api.nvidia.com/v1/ranking
Model: nvidia/llama-nemotron-rerank-1b-v2
Input: Query + list of documents
Output: Ranked scores for each document
```

**3. Chat Completions**
```
POST https://integrate.api.nvidia.com/v1/chat/completions
Model: openai/gpt-oss-120b (or fallback)
Input: System prompt + messages + context
Output: Generated response
```

### Query Flow Diagram

```
User Question
    ↓
    [Q: "What is SLP?"]
    ↓
[Embedding: nvidia/llama-3_2-nemoretriever-300m-embed-v2]
    ↓
    [Convert to 768-dim vector]
    ↓
[Vector Search: pgvector in Supabase]
    ↓
    [Top 10 similar documents found]
    ↓
[Reranking: nvidia/llama-nemotron-rerank-1b-v2]
    ↓
    [Top 5 best matches selected]
    ↓
[Chat: openai/gpt-oss-120b]
    ↓
    [Answer with citations]
    ↓
AI Response with Sources
```

### Fallback Model Behavior

If primary model (`openai/gpt-oss-120b`) fails:
1. Error is logged
2. System automatically tries fallback: `nvidia/nemotron-3-super-120b-a12b`
3. If fallback succeeds, response is returned
4. If both fail, error is returned to user

### Performance Notes

- **Embedding**: ~100-200ms per chunk
- **Reranking**: ~50-100ms for 10 documents
- **Chat**: ~500-1500ms for response generation
- **Total**: ~1-3 seconds per user question

### Troubleshooting

**Error: "Authentication failed"**
- Verify NVIDIA_API_KEY is correct
- Check it's set in Vercel environment
- Regenerate key if needed

**Error: "Model not found"**
- Double-check model names (case-sensitive)
- Verify you have access to all models
- Try accessing: https://integrate.api.nvidia.com/

**Embeddings mismatched dimensions**
- The model returns 768-dimensional vectors
- If using different embedding model, update vector column size

**Reranking not working**
- Check NVIDIA_RERANK_MODEL is set
- Verify NVIDIA_RERANK_API_URL is correct
- System gracefully falls back to vector search order if reranking fails

### Advanced: Use Different Models

Change embedding model:
```env
NVIDIA_EMBEDDING_MODEL=nvidia/llama-3_2-nemoretriever-8b-embed-v2
```

Change chat model (if available):
```env
NVIDIA_MODEL=nvidia/mistral-large
NVIDIA_FALLBACK_MODEL=nvidia/llamaguard
```

Check latest available models: https://integrate.api.nvidia.com/

### Cost Estimation

- Embeddings: Very cheap (~$0.0001 per 1K tokens)
- Reranking: Cheap (~$0.0001 per ranking)
- Chat: Varies by model (~$0.001-0.01 per 1K tokens)

See Nvidia pricing: https://www.nvidia.com/en-us/ai-data-science/pricing/

### Remove Old Dependencies

Since you're using Nvidia, you don't need OpenAI SDK:

```bash
npm uninstall openai
```

Your API is now fully powered by Nvidia's enterprise models!

