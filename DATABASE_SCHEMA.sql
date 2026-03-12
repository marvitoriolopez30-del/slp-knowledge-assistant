-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Profiles table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_name TEXT NOT NULL,
  folder TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  file_type TEXT,
  uploaded_by UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Document chunks for embeddings
CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  chunk_size INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document embeddings (vectors)
CREATE TABLE IF NOT EXISTS document_embeddings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chunk_id UUID NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  embedding vector(1536),
  created_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT unique_chunk_embedding UNIQUE(chunk_id)
);

-- Create index for vector similarity search
CREATE INDEX ON document_embeddings USING ivfflat (embedding vector_cosine_ops);

-- Beneficiaries table
CREATE TABLE IF NOT EXISTS beneficiaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  region TEXT,
  municipality TEXT,
  barangay TEXT,
  contact_info TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Chat logs
CREATE TABLE IF NOT EXISTS chat_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  response TEXT,
  tokens_used INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT DEFAULT 'New Chat',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Storage audit log
CREATE TABLE IF NOT EXISTS storage_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  file_id UUID,
  file_name TEXT,
  ip_address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- RLS Policies
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT USING (auth.uid()::uuid = id);

CREATE POLICY "Users can update their own profile" ON profiles
  FOR UPDATE USING (auth.uid()::uuid = id);

CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

CREATE POLICY "Admins can update profiles" ON profiles
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

-- Documents policies
CREATE POLICY "Users can view documents" ON documents
  FOR SELECT USING (true);

CREATE POLICY "Admins can insert documents" ON documents
  FOR INSERT WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

CREATE POLICY "Admins can delete their documents" ON documents
  FOR DELETE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin' OR uploaded_by = auth.uid()::uuid
  );

-- Document chunks policies
CREATE POLICY "Users can view chunks" ON document_chunks
  FOR SELECT USING (true);

CREATE POLICY "Admins can insert chunks" ON document_chunks
  FOR INSERT WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

-- Embeddings policies
CREATE POLICY "Users can view embeddings" ON document_embeddings
  FOR SELECT USING (true);

CREATE POLICY "Admins can insert embeddings" ON document_embeddings
  FOR INSERT WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

-- Chat sessions policies
CREATE POLICY "Users can view their sessions" ON chat_sessions
  FOR SELECT USING (user_id = auth.uid()::uuid);

CREATE POLICY "Users can create sessions" ON chat_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid()::uuid);

CREATE POLICY "Users can update their sessions" ON chat_sessions
  FOR UPDATE USING (user_id = auth.uid()::uuid);

CREATE POLICY "Users can delete their sessions" ON chat_sessions
  FOR DELETE USING (user_id = auth.uid()::uuid);

-- Chat messages policies
CREATE POLICY "Users can view session messages" ON chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM chat_sessions 
      WHERE chat_sessions.id = chat_messages.session_id 
      AND chat_sessions.user_id = auth.uid()::uuid
    )
  );

CREATE POLICY "Users can insert messages" ON chat_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions 
      WHERE chat_sessions.id = chat_messages.session_id 
      AND chat_sessions.user_id = auth.uid()::uuid
    )
  );

-- Function to match documents by similarity
DROP FUNCTION IF EXISTS match_documents(vector, float, int);

CREATE OR REPLACE FUNCTION match_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  similarity float
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    de.id,
    dc.document_id,
    dc.chunk_index,
    dc.content,
    (1 - (de.embedding <=> query_embedding)) AS similarity
  FROM document_embeddings de
  JOIN document_chunks dc ON de.chunk_id = dc.id
  WHERE 1 - (de.embedding <=> query_embedding) > match_threshold
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER documents_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER chat_sessions_updated_at
BEFORE UPDATE ON chat_sessions
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Create storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('knowledge', 'knowledge', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Public can read knowledge bucket" ON storage.objects
  FOR SELECT USING (bucket_id = 'knowledge');

CREATE POLICY "Admins can upload to knowledge bucket" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'knowledge' AND
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );

CREATE POLICY "Admins can delete from knowledge bucket" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'knowledge' AND
    (SELECT role FROM profiles WHERE id = auth.uid()::uuid) = 'admin'
  );
