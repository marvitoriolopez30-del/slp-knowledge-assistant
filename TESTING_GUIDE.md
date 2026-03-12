# Testing & Verification Guide

Quick steps to verify the SLP Knowledge Assistant is working correctly.

## ✅ Pre-Deployment Checklist

### 1. Environment Setup
```bash
# Verify all required files exist
ls -la DATABASE_SCHEMA.sql        # ✓ SQL schema
ls -la DEPLOYMENT_GUIDE.md        # ✓ Setup guide
ls -la README.md                  # ✓ Quick start
ls -la .env.example               # ✓ Template
ls -la package.json               # ✓ Dependencies

# Verify core directories
ls -la src/                        # ✓ Frontend code
ls -la api/                        # ✓ API endpoints
```

### 2. Dependencies Check
```bash
# Install dependencies
npm install

# Verify key packages
npm list react                     # ✓ Should be 19.x
npm list vite                      # ✓ Should be 6.x
npm list @supabase/supabase-js     # ✓ Should be 2.x
npm list openai                    # ✓ Should be 6.x
npm list tailwindcss               # ✓ Should be 4.x
```

### 3. TypeScript Check
```bash
# Verify no type errors
npm run lint

# Should complete without errors
# Expected output: "tsc --noEmit" with no errors
```

### 4. Build Check
```bash
# Test production build
npm run build

# Should create:
# - dist/ folder with 500KB+ bundle
# - No errors or warnings
```

---

## 🚀 Local Testing (Development)

### Start Local Server
```bash
# 1. Setup .env.local
cp .env.example .env.local
# Edit with your credentials:
# VITE_SUPABASE_URL=https://xxx.supabase.co
# VITE_SUPABASE_ANON_KEY=eyJ...
# SUPABASE_SERVICE_ROLE_KEY=eyJ...
# OPENAI_API_KEY=sk-...

# 2. Start dev server
npm run dev

# Expected output:
# > Local:   http://localhost:5173/
# READY in XXXms
```

### Test Landing Page
```
1. Open http://localhost:5173
2. See hero section with "SLP Knowledge Assistant"
3. Click "Get Started" button
4. Should navigate to sign-in page
✓ Landing page working
```

### Test Authentication
```
1. Click "Create Account"
2. Fill form:
   - Full Name: Test User
   - Email: test@example.com
   - Password: MyPassword123!
3. Click "Create Account"
4. Should show "Account created" message
5. Approve in admin panel (or use master admin email)
✓ Auth working
```

### Master Admin Setup
```
1. Use email: marvitoriolopez30@gmail.com
2. Password: anything
3. Sign up
4. Will auto-approve (master admin)
5. Can now upload documents
✓ Master admin working
```

### Test Chat (after docs uploaded)
```
1. Go to Chat tab
2. Click "New Chat"
3. Ask: "What is SLP?"
4. Should get response (will fail if no docs - that's OK)
✓ Chat interface working
```

### Test Document Browser
```
1. Go to Documents tab
2. See all folders (GUIDELINES, TEMPLATES, etc)
3. If admin: Click "Upload"
4. Upload sample PDF
5. Should appear in list
✓ Document management working
```

### Test Beneficiary Search
```
1. Go to Beneficiaries tab
2. Type a name
3. Should search (requires data in DB)
✓ Search interface working
```

### Test Admin Panel (if admin)
```
1. Go to Admin Panel (after approval)
2. See Overview tab with stats
3. Click Users tab
4. Should show pending users
5. Click Approve/Reject buttons
✓ Admin working
```

---

## 🔍 Verification Steps (Pre-Deployment)

### 1. Database Tables Created
```
Go to Supabase → Table Editor
Verify these exist:
✓ public.profiles
✓ public.documents
✓ public.document_chunks
✓ public.document_embeddings
✓ public.chat_sessions
✓ public.chat_messages
✓ public.beneficiaries
✓ public.chat_logs
✓ public.storage_audit_log
```

### 2. pgvector Extension Enabled
```
Go to Supabase → SQL Editor
Run: SELECT * FROM pg_extension;
Look for: pgvector enabled ✓
```

### 3. Storage Bucket Created
```
Go to Supabase → Storage
Verify "knowledge" bucket exists
Set to PUBLIC ✓
```

### 4. RLS Policies Applied
```
Go to Supabase → Authentication → Policies
Should see policies on:
✓ profiles
✓ documents
✓ document_chunks
✓ document_embeddings
✓ chat_sessions
✓ chat_messages
```

### 5. Sample Data (Optional)
```sql
-- Add test beneficiary
INSERT INTO beneficiaries (name, status) VALUES ('John Dela Cruz', 'Served');

-- Add test user
INSERT INTO profiles (id, email, role, status, full_name) 
VALUES ('uuid-here', 'test@example.com', 'user', 'approved', 'Test User');
```

---

## 📊 Performance Tests

### Load Test - Chat Endpoint
```bash
# Test response time
time curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"test","history":[]}'

# Expected: <1000ms response time
```

### Database Connection
```bash
# Test from Supabase SQL
SELECT COUNT(*) FROM profiles;
-- Should execute instantly
```

### Embedding Generation
```
Verify in Supabase:
SELECT * FROM document_embeddings LIMIT 1;

-- Should see:
-- - id: UUID
-- - chunk_id: UUID  
-- - embedding: vector[1536]
-- - created_at: timestamp
```

---

## 🐛 Quick Debugging

### Chat Returns Empty
```
1. Check .env variables are set
2. Verify OPENAI_API_KEY has credits
3. Check browser console for errors
4. Look at Vercel logs
```

### "Bucket not found" Error
```
1. Go to Supabase Storage
2. Create bucket "knowledge"
3. Set to PUBLIC
4. Refresh page
```

### Can't See Admin Panel
```
1. Verify user role='admin' in DB
2. Check user status='approved'
3. Use master admin email (marvitoriolopez30@gmail.com)
```

### API Calls Failing Locally
```
1. Start Express server: npm run dev
2. Check server output: "Server running on..."
3. Verify .env.local has all variables
4. Check Network tab in DevTools for actual error
```

### TypeScript Errors
```bash
# Clear cache and rebuild
rm -rf node_modules dist
npm install
npm run build
```

---

## ✅ Pre-Production Checklist

Before deploying to Vercel, verify:

- [ ] Database schema created (run DATABASE_SCHEMA.sql)
- [ ] Storage bucket "knowledge" created
- [ ] Environment variables set in Vercel
- [ ] npm run build completes without errors
- [ ] npm run lint passes with no errors
- [ ] User can sign up (if using master admin email, auto-approves)
- [ ] Admin can upload documents
- [ ] Chat works with documents
- [ ] Admin dashboard shows stats
- [ ] Beneficiary search works
- [ ] All links work correctly
- [ ] No sensitive data in .env (check .gitignore)

---

## 🚀 Deployment Verification

After deploying to Vercel:

### 1. Site Loads
```
Go to: https://your-project.vercel.app
Should see landing page ✓
```

### 2. Can Sign Up
```
Create account → Should work ✓
```

### 3. Admin Can Upload
```
As master admin → Upload document → Works ✓
```

### 4. Chat Works
```
Ask question → Gets response ✓
```

### 5. Functions Running
```
Vercel Dashboard → Deployments → see green ✓
```

---

## 📋 Issue Support

If something doesn't work:

1. **Check** → DEPLOYMENT_GUIDE.md Troubleshooting section
2. **Look at** → Browser console errors (F12)
3. **Review** → Vercel logs (Deployments → Runtime Logs)
4. **Check** → Supabase dashboard for SQL errors
5. **Verify** → All environment variables are set

---

## 🎉 Success Indicators

When everything works, you'll see:

✅ Landing page displays
✅ Can sign up and sign in
✅ Chat interface responsive and beautiful
✅ Documents upload and appear in list
✅ Chat answers questions about documents
✅ Admin panel works
✅ Beneficiary search works
✅ No console errors
✅ Fast load times (<3s)
✅ Mobile layout works

---

## 📞 Getting Help

- **Setup issues**: See DEPLOYMENT_GUIDE.md → Troubleshooting
- **Code errors**: Check Vercel runtime logs
- **Database**: Check Supabase SQL editor errors
- **OpenAI**: Verify API key and credits
- **Types**: Run npm run lint for TypeScript errors

---

**Questions?** Refer to documentation files in root directory.
**All set?** Deploy to Vercel and start using! 🚀
