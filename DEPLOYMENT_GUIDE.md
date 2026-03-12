# SLP Knowledge Assistant - Complete Deployment Guide

## System Overview

**SLP Knowledge Assistant** is an AI-powered knowledge chatbot powered by:
- **Frontend**: React + Vite + TailwindCSS
- **Backend**: Vercel Serverless Functions + Express
- **Database**: Supabase PostgreSQL with pgvector
- **Storage**: Supabase Storage
- **AI**: OpenAI GPT-4o-mini + Embeddings
- **Deployment**: Vercel + Supabase

---

## Prerequisites

Before you start, ensure you have:

1. **Accounts Created**:
   - GitHub account
   - Supabase account (free tier)
   - Vercel account  
   - OpenAI account with API credits

2. **Tools Installed**:
   - Node.js 18+ 
   - npm or yarn
   - Git
   - VS Code (recommended)

---

## Step 1: Supabase Setup

### 1.1 Create Supabase Project

```bash
# Go to https://app.supabase.com and sign in
# Click "New Project"
# Fill in:
# - Project name: slp-knowledge-base
# - Database password: (generate strong password)
# - Region: Choose closest to your location
# - Click "Create new project"

# Wait ~2 minutes for project initialization
```

### 1.2 Create Database Tables

1. Go to your Supabase dashboard
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy entire contents of `DATABASE_SCHEMA.sql` from the project root
5. Paste into the SQL editor
6. Click **Run**
7. Wait for completion (you'll see green checkmarks)

### 1.3 Setup Authentication

```bash
# In Supabase Dashboard:
# Go to Authentication → Providers
# Enable Email/Password:
#   - Provider: Email  
#   - Status: Enabled (default)
#   - Double check: Confirm email enabled

# Go to Authentication → Policies
# Verify all RLS policies are applied (they should be from SQL script)
```

### 1.4 Create Storage Bucket

```bash
# In Supabase Dashboard:
# Go to Storage
# Click "New Bucket"
# Name: knowledge
# Privacy: Public (important!)
# Click "Create"

# Note: Must be Public so users can download files
```

### 1.5 Get Your Credentials

In Supabase Dashboard:

1. **Settings → API**:
   - Copy `Project URL` → save as `VITE_SUPABASE_URL`
   - Copy `anon public` key → save as `VITE_SUPABASE_ANON_KEY`
   - Copy `service_role` key → save as `SUPABASE_SERVICE_ROLE_KEY`

2. **Settings → Database**:
   - Connection string (optional, for backups)

---

## Step 2: OpenAI Setup

```bash
# Go to https://platform.openai.com/account/api-keys
# Click "Create New Secret Key"
# Name it: slp-knowledge-assistant
# Copy the key immediately (you won't see it again)
# Save as: OPENAI_API_KEY

# Add billing: https://platform.openai.com/account/billing/overview
# Add payment method and set usage limits
```

**Estimated Costs**:
- Embeddings (text-embedding-3-small): ~$0.02 per 1M tokens
- Chat (gpt-4o-mini): ~$0.15 per 1M input tokens
- Typical usage: $5-20/month depending on volume

---

## Step 3: Project Setup

```bash
# Clone or download the project
git clone <your-repo> slp-knowledge-assistant
cd slp-knowledge-assistant

# Install dependencies
npm install

# Create .env.local file in project root:
cat > .env.local << 'EOF'
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENAI_API_KEY=your_openai_key
EOF

# Test locally
npm run dev

# Should open http://localhost:5173
```

---

## Step 4: Vercel Deployment

### 4.1 Prepare for Deployment

```bash
# Ensure all files are committed
git add .
git commit -m "Ready for deployment"

# Check vercel.json exists in root
cat vercel.json

# Should output something like:
# {
#   "buildCommand": "npm run build",
#   "outputDirectory": "dist",
#   "env": ["OPENAI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL"],
#   "functions": {
#     "api/**/*.ts": {
#       "runtime": "nodejs18.x"
#     }
#   }
# }
```

### 4.2 Connect to Vercel

```bash
# Option 1: Via Git (Recommended)
# 1. Push code to GitHub
# 2. Go to https://vercel.com
# 3. Click "Import Project"
# 4. Select your GitHub repo
# 5. Click "Import"

# Option 2: Via CLI
npm i -g vercel
vercel

# Follow the prompts
```

### 4.3 Set Environment Variables in Vercel

In Vercel Project Settings → Environment Variables:

```
VITE_SUPABASE_URL = <your_supabase_url>
VITE_SUPABASE_ANON_KEY = <your_anon_key>
SUPABASE_SERVICE_ROLE_KEY = <your_service_role_key>
SUPABASE_URL = <your_supabase_url>
OPENAI_API_KEY = <your_openai_key>
```

**Important**: Make sure to set them for:
- Production
- Preview
- Development

### 4.4 Deploy

```bash
# After setting env vars, trigger redeploy:
# In Vercel Dashboard → Deployments → Redeploy

# Or push new commit to main:
git commit --allow-empty -m "trigger deployment"
git push
```

---

## Step 5: Configure Admin User

The system automatically recognizes one master admin account.

**Email**: `marvitoriolopez30@gmail.com`

1. Go to your deployed app URL
2. Click "Create Account"
3. Sign up with the master admin email
4. The account will automatically get admin role

**For other admins**:
1. Master admin logs in
2. Go to Admin Panel
3. Approve registration
4. Go to Users tab
5. Click "Promote" to make them admin

---

## Step 6: Upload Initial Documents

1. **As Admin User**:
   - Click "Documents" in sidebar
   - Click "Upload" button
   - Select files (PDF, DOCX, XLSX, PNG, JPG, TXT)
   - Choose folder category
   - Click "Upload"

2. **Processing**:
   - Documents are automatically processed
   - Text is extracted and split into chunks
   - Embeddings are generated
   - Stored in pgvector database

3. **Supported Formats**:
   - Documents: PDF, DOCX, XLSX, CSV, TXT
   - Images: PNG, JPG
   - Max file size: 50MB (configurable)

---

## Step 7: Testing the System

### Test 1: Authentication
```bash
# 1. Go to app URL
# 2. Click "Create Account"
# 3. Enter email and password
# 4. Should see "Account pending" message
# 5. Master admin approves in Admin Panel
# 6. User can now sign in
```

### Test 2: Chat with Documents
```bash
# 1. Upload a test document (PDF or TXT)
# 2. Ask a question related to the document
# 3. Should get an answer based on document content
# 4. Should cite the source document
```

### Test 3: Beneficiary Search
```bash
# 1. Add test beneficiaries via Admin
# 2. Search for a name (with slight typo)
# 3. Should find fuzzy matches
# 4. Should show similarity scores
```

### Test 4: Document Management
```bash
# 1. Upload multiple documents
# 2. Filter by folder
# 3. Search for documents
# 4. Download a document
# 5. Delete documents (admin only)
```

---

## Database Schema Overview

### profiles
- User accounts and roles
- Columns: id, email, full_name, role (admin/user), status (pending/approved/rejected)

### documents
- Uploaded files
- Columns: id, file_name, folder, file_url, uploaded_by, created_at

### document_chunks
- Split text from documents
- Columns: id, document_id, chunk_index, content, chunk_size

### document_embeddings
- Vector embeddings for RAG
- Columns: id, chunk_id, embedding (vector)

### chat_sessions
- User conversation sessions
- Columns: id, user_id, title, created_at, updated_at

### chat_messages
- Messages in each session
- Columns: id, session_id, role, content, created_at

### beneficiaries
- SLP beneficiary database
- Columns: id, name, status, region, municipality, barangay

### chat_logs
- Audit log of all chats
- Columns: id, user_id, message, response, tokens_used, created_at

---

## API Routes Reference

### Chat
- `POST /api/chat-rag` - Chat with RAG
- `GET/POST/PUT/DELETE /api/chat-sessions` - Manage sessions

### Documents
- `POST /api/documents/upload.ts` - Upload and process document
- `DELETE /api/documents/delete.ts` - Delete document
- `GET /api/documents/list.ts` - List documents

### Admin
- `GET /api/admin/stats.ts` - Dashboard statistics
- `GET/PUT /api/admin/users.ts` - Manage users (approve/reject/promote)

### Beneficiaries
- `POST /api/beneficiaries/search.ts` - Fuzzy name matching

---

## Configuration Files

### .env.local (Development)
```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJxxx...
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...
OPENAI_API_KEY=sk-xxx...
```

### .env.production (Vercel)
Same as above, set in Vercel dashboard

### vercel.json
Already configured in project root

---

## Troubleshooting

### "Bucket not found" Error
```bash
# Fix:
# 1. Go to Supabase Dashboard
# 2. Storage → New Bucket
# 3. Name it "knowledge"
# 4. Set to Public
# 5. Reload app

# If still failing, check RLS policies:
# Storage → Policies
# Should have:
# - allow public read on knowledge bucket
# - allow admin upload/delete on knowledge bucket
```

### "Relation does not exist" Error
```bash
# Tables not created. Fix:
# 1. Go to Supabase SQL Editor
# 2. Run DATABASE_SCHEMA.sql again
# 3. Wait for completion
```

### Chat Returns Empty Responses
```bash
# Check:
# 1. OPENAI_API_KEY is set and valid
# 2. OpenAI account has credits
# 3. Documents are uploaded
# 4. Check Vercel logs: Deployments → Runtime Logs
```

### Embeddings Not Working
```bash
# Check:
# 1. pgvector extension enabled in Supabase
# 2. Run DATABASE_SCHEMA.sql to enable extensions
# 3. Check API response in browser DevTools
```

### Admin Panel Not Showing
```bash
# Check:
# 1. User email must be: marvitoriolopez30@gmail.com
# 2. User profile role must be 'admin'
# 3. User status must be 'approved'ç
# Go to Supabase → profiles table and manually update if needed
```

---

## Performance Optimization

### Caching
- Chat sessions are saved in Supabase (persistent)
- Recent files are cached by browser
- Consider implementing Redis for vector cache

### Rate Limiting
- Implement per-user rate limiting on chat endpoint
- Set OpenAI rate limits in account settings
- Monitor Vercel function execution time

### Scaling
- Free tier supports ~1000 chats/day
- Scale costs: ~$0.001 per 1000 tokens
- Typical cost: $1-5 per 1000 active users/month

---

## Security Checklist

- [x] Row-Level Security (RLS) enabled on all tables
- [x] Service role key only used on backend
- [x] Anon key has limited permissions (frontend only)
- [x] Storage bucket has public read, admin-only write
- [x] API keys not committed to git
- [x] HTTPS enforced (Vercel default)
- [x] User authentication required for chat
- [x] Only admins can upload/delete documents
- [ ] Set up rate limiting (TODO)
- [ ] Add audit logging (TODO)
- [ ] Enable 2FA for admin accounts (TODO)

---

## Monitoring

### Supabase Dashboard
- **Database**: View query performance, storage usage
- **Authentication**: Monitor sign-ups, active users
- **Storage**: Track file uploads and bandwidth
- **Logs**: Debug real-time errors

### Vercel Dashboard
- **Deployments**: Track deployment status
- **Analytics**: Monitor traffic and performance
- **Logs**: View serverless function logs
- **Usage**: Track function invocations and time

### OpenAI Dashboard
- **Usage**: Monitor API calls and costs
- **Quotas**: Set spending limits
- **Events**: View error logs

---

## Maintenance

### Regular Tasks
- [ ] Review admin logs weekly
- [ ] Monitor OpenAI costs
- [ ] Backup database monthly
- [ ] Update dependencies quarterly
- [ ] Review RLS policies semi-annually

### Backup Procedure
```bash
# Export Supabase database
pg_dump -h your_host -U postgres -d postgres > backup.sql

# Or use Supabase dashboard:
# Settings → Backups → Download
```

---

## Support & Resources

- **Supabase Docs**: https://supabase.com/docs
- **OpenAI Docs**: https://platform.openai.com/docs
- **Vercel Docs**: https://vercel.com/docs
- **React Docs**: https://react.dev
- **Tailwind CSS**: https://tailwindcss.com/docs

---

## License

© MVLTORIO 2026 - Sustainable Livelihood Program

---

## Future Enhancements

- [ ] Implement document versioning
- [ ] Add multi-language support
- [ ] Create mobile app
- [ ] Add real-time collaboration
- [ ] Implement document OCR for images
- [ ] Add webhooks for external integrations
- [ ] Create admin export/import functionality
- [ ] Implement advanced analytics dashboard
- [ ] Add calendar integration for scheduling
- [ ] Create API for external systems

---

Last Updated: March 2026
