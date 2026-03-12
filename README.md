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
    *   `OPENAI_API_KEY`: Your OpenAI API Key.
4.  **Deploy**: Vercel will automatically detect the configuration and deploy.

## Supabase Setup

Ensure you have the following tables and functions in your Supabase database:

### 1. Tables
*   `profiles`: `id` (uuid, pk), `email` (text), `role` (text), `status` (text).
*   `documents`: `id` (uuid, pk), `file_name` (text), `folder` (text), `file_url` (text), `uploaded_by` (uuid).
*   `document_embeddings`: `id` (bigint, pk), `document_id` (uuid), `content` (text), `embedding` (vector(1536)), `file_name` (text), `folder` (text).
*   `beneficiaries`: `id` (uuid, pk), `name` (text), `status` (text).

### 2. Vector Search Function
Run this in the SQL Editor:
```sql
create or replace function match_documents (
  query_embedding vector(1536),
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

## Admin Access
The email `marvitoriolopez30@gmail.com` is automatically granted **Admin** status upon registration.
As an admin, you can:
*   **Approve/Reject/Delete Users**: In the "Admin Panel" tab.
*   **Upload Files**: In the "Documents" tab or "Admin Panel" -> "File Management".
