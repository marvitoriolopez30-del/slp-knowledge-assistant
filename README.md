# SLP Knowledge Assistant

An AI-powered knowledge management platform for the Sustainable Livelihood Program (SLP). Enable staff to ask questions about policies, retrieve forms, analyze guidelines, and check beneficiary information using ChatGPT-like AI.

## 🎯 Features

✅ **AI Chatbot** - ChatGPT-like interface with Retrieval Augmented Generation (RAG)  
✅ **Document Management** - Upload PDFs, Word, Excel, images  
✅ **Semantic Search** - Find documents using AI embeddings  
✅ **Beneficiary Verification** - Fuzzy name matching  
✅ **Chat History** - Save and resume conversations  
✅ **Admin Dashboard** - Manage users, documents, knowledge base  
✅ **Role-Based Access** - Admin and user roles with approval  
✅ **Data Visualization** - Charts and tables  
✅ **Fully Free Tier** - Runs on Vercel + Supabase free tiers  

## 🚀 Quick Start

### Setup (5 minutes)

```bash
# 1. Prerequisites
# - GitHub account
# - Supabase account (free)
# - Vercel account (free)
# - OpenAI API key

# 2. Clone project
git clone <your-repo>
cd slp-knowledge-assistant

# 3. Install
npm install

# 4. Setup environment
cp .env.example .env.local
# Edit .env.local with your credentials from Supabase + OpenAI

# 5. Create database tables
# - Go to Supabase Dashboard → SQL Editor
# - Copy contents of DATABASE_SCHEMA.sql
# - Paste and run

# 6. Run locally
npm run dev
# Opens http://localhost:5173

# 7. Deploy to Vercel
# - Push to GitHub
# - Go to vercel.com → Import project
# - Set environment variables
# - Deploy!
```

**Full instructions**: See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)

## 📋 What's Included

**Database Schema**: Complete Supabase setup in `DATABASE_SCHEMA.sql`
- ✅ User authentication & roles
- ✅ Document management
- ✅ Vector embeddings (pgvector) for AI search
- ✅ Chat history & sessions
- ✅ Beneficiary database
- ✅ Row-level security (RLS) policies

**API Endpoints**: Production-ready Vercel Functions
- ✅ RAG-powered chat endpoint
- ✅ Document upload & processing
- ✅ Beneficiary fuzzy search
- ✅ Admin user management
- ✅ Dashboard statistics

**Frontend**: Modern React UI
- ✅ Chat interface with markdown support
- ✅ Document browser with filters
- ✅ Admin dashboard
- ✅ Responsive design (mobile/tablet/desktop)
- ✅ Dark mode ready

## 🏗️ Architecture

```
Frontend (React)
    ↓
Vercel Functions (Node.js)
    ↓
Supabase (PostgreSQL + pgvector)
    ↓
OpenAI (GPT-4o-mini + Embeddings)
```

**Free Tier Specs:**
- Supabase: 500MB DB + 1GB storage
- Vercel: 100 hours/month compute
- OpenAI: $0.02/1M embedding tokens, $0.15/1M chat tokens

## 🔒 Security

- **Authentication**: Supabase Auth (email/password)
- **Authorization**: Row-Level Security (RLS) on all tables
- **Data**: Service role KEY only on backend
- **Storage**: Secure file access with public read/admin write
- **Audit**: All admin actions logged

## 📚 Documentation

- [Deployment Setup](./DEPLOYMENT_GUIDE.md) - Complete step-by-step guide
- [Database Schema](./DATABASE_SCHEMA.sql) - Full SQL schema
- [.env Template](./.env.example) - Environment variables needed

## 💡 Usage

### As a Regular User
1. **Sign Up** → Wait for admin approval
2. **Chat** → Ask questions about SLP documents
3. **Search** → Browse and download files
4. **Lookup** → Verify beneficiary names
5. **Save** → Sessions persist automatically

### As an Admin  
1. **Approve Users** → Admin Panel → Users  
2. **Upload Documents** → Admin Panel → Documents  
3. **Manage Knowledge Base** → Upload PDFs, forms, guidelines  
4. **View Analytics** → Dashboard shows usage stats  
5. **Manage Users** → Approve, promote to admin, etc.

## 🛠️ Tech Stack

- React 19 + Vite
- TailwindCSS + Lucide Icons
- TypeScript
- Supabase (PostgreSQL + Auth + Storage)
- OpenAI API
- pgvector (vector search)
- Vercel Functions

## 📖 How It Works

### Document Upload
1. Admin uploads file (PDF, DOCX, etc.)
2. Text extracted automatically
3. Split into chunks
4. Each chunk embedded using OpenAI
5. Stored in vector database

### Chat
1. User asks question
2. Question is embedded
3. Vector similarity search finds relevant chunks
4. Context sent to GPT-4o-mini
5. AI generates answer with citations
6. Response saved to chat history

## 🐛 Troubleshooting

**"Bucket not found" error**
→ Create "knowledge" bucket in Supabase Storage (set to PUBLIC)

**Chat returns empty**
→ Check OpenAI API key is valid and has credits

**Tables not found**
→ Run DATABASE_SCHEMA.sql in Supabase SQL Editor

**Admin panel hidden**
→ Master admin email: `marvitoriolopez30@gmail.com`

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for complete troubleshooting.

## 📞 Support

1. Check [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for detailed setup
2. Review error logs in Vercel/Supabase dashboards
3. Verify environment variables are set correctly

## 📄 License

© MVLTORIO 2026 - Sustainable Livelihood Program

## Next Steps

1. **Read**: [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
2. **Setup**: Follow 7 quick steps above
3. **Deploy**: Push to Vercel
4. **Use**: Start chatting with your knowledge base!

---

**Status**: ✅ Production Ready | **Version**: 1.0 | **Last Updated**: March 2026
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
