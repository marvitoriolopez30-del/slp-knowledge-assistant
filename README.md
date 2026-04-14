# SLP Knowledge Assistant - Deployment Guide

This application is designed to be deployed on **Vercel** with **Supabase** as the backend.

## Vercel Deployment

1.  **Push to GitHub**: Push this code to a GitHub repository.
2.  **Import to Vercel**: Connect your repository to Vercel.
3.  **Environment Variables**: Add the following variables in Vercel:
    *   `VITE_SUPABASE_URL`: Your Supabase Project URL.
    *   `VITE_SUPABASE_ANON_KEY`: Your Supabase Anon Key.
    *   `SUPABASE_URL`: Same as `VITE_SUPABASE_URL`.
    *   `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase Service Role Key (found in Settings -> API).
    *   `CHAT_PROVIDER`: Set to `nvidia`.
    *   `NVIDIA_API_KEY`: Required for both chat and embeddings.
    *   `NVIDIA_MODEL`: Primary chat model, defaults to `openai/gpt-oss-120b`.
    *   `NVIDIA_FALLBACK_MODEL`: Fallback chat model, defaults to `nvidia/nemotron-3-super-120b-a12b`.
    *   `NVIDIA_API_URL`: Optional, defaults to `https://integrate.api.nvidia.com/v1/chat/completions`.
    *   `NVIDIA_EMBEDDING_MODEL`: Optional, defaults to `baai/bge-m3`.
    *   `NVIDIA_EMBEDDINGS_API_URL`: Optional, defaults to `https://integrate.api.nvidia.com/v1/embeddings`.
    *   `NVIDIA_RERANK_MODEL`: Optional, defaults to `nvidia/llama-nemotron-rerank-1b-v2`.
    *   `NVIDIA_RERANK_API_URL`: Optional, defaults to `https://integrate.api.nvidia.com/v1/ranking`.
    *   `RAG_CANDIDATE_COUNT`: Optional, defaults to `8`.
    *   `RAG_FINAL_CONTEXT_COUNT`: Optional, defaults to `5`.
    *   `LONG_CONTEXT_THRESHOLD`: Optional, defaults to `8000`.
4.  **Deploy**: Vercel will automatically detect the configuration and deploy.

## Using NVIDIA for Chat and Embeddings

The backend now uses NVIDIA for both:
* response generation in `/api/chat`
* embeddings for document search and document ingestion
* reranking retrieved chunks before answer generation

Set these environment variables:
```env
CHAT_PROVIDER=nvidia
NVIDIA_API_KEY=your_nvidia_api_key
NVIDIA_MODEL=openai/gpt-oss-120b
NVIDIA_FALLBACK_MODEL=nvidia/nemotron-3-super-120b-a12b
NVIDIA_EMBEDDING_MODEL=baai/bge-m3
NVIDIA_RERANK_MODEL=nvidia/llama-nemotron-rerank-1b-v2
```

OpenAI is no longer required by the backend after this change.

## Supabase Setup

Ensure you have the following tables and functions in your Supabase database:

### 1. Tables
*   `profiles`: `id` (uuid, pk), `email` (text), `role` (text), `status` (text).
*   `documents`: `id` (uuid, pk), `file_name` (text), `folder` (text), `file_url` (text), `uploaded_by` (uuid).
*   `document_embeddings`: `id` (bigint, pk), `document_id` (uuid), `content` (text), `embedding` (vector(1024)), `file_name` (text), `folder` (text).
*   `beneficiaries`: `id` (uuid, pk), `name` (text), `status` (text).

### 2. Vector Search Function
Run this in the SQL Editor:
```sql
create or replace function match_documents (
  query_embedding vector(1024),
  match_threshold float,
  match_count int
)
returns table (
  document_id uuid,
  content text,
  file_name text,
  folder text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    document_embeddings.document_id,
    document_embeddings.content,
    document_embeddings.file_name,
    document_embeddings.folder,
    1 - (document_embeddings.embedding <=> query_embedding) as similarity
  from document_embeddings
  where 1 - (document_embeddings.embedding <=> query_embedding) > match_threshold
  order by document_embeddings.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

If you already created the embeddings table with `vector(1536)`, you must recreate or migrate it before ingesting documents with NVIDIA embeddings.

## Admin Access
The email `mvltorio@dswd.gov.ph` is automatically granted **Admin** status upon registration.
As an admin, you can:
*   **Approve/Reject/Delete Users**: In the "Admin Panel" tab.
*   **Upload Files**: In the "Documents" tab or "Admin Panel" -> "File Management".
