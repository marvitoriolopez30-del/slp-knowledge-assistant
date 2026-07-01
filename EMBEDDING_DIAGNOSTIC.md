/**
 * Diagnostic script to check the embeddings and RAG setup
 * Run this in the browser console or as a Node script
 */

async function diagnoseRAGSetup() {
  console.log('🔍 SLP Knowledge Assistant - RAG Diagnostic');
  console.log('='.repeat(50));

  try {
    // 1. Test the stats endpoint to see database state
    console.log('\n📊 Checking database state...');
    const statsResponse = await fetch('/api/admin/stats', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!statsResponse.ok) {
      console.error('❌ Stats endpoint failed:', statsResponse.status);
      console.log('💡 Make sure you are logged in as an admin');
    } else {
      const stats = await statsResponse.json();
      console.log('✅ Database Statistics:');
      console.log(`   • Total Users: ${stats.totalUsers || 0}`);
      console.log(`   • Total Documents: ${stats.totalDocuments || 0}`);
      console.log(`   • Total Beneficiaries: ${stats.totalBeneficiaries || 0}`);
      console.log(`   • Total Chats: ${stats.totalChats || 0}`);
      
      if (stats.documentsByFolder) {
        console.log('   • Documents by Folder:');
        Object.entries(stats.documentsByFolder).forEach(([folder, count]) => {
          console.log(`     - ${folder}: ${count}`);
        });
      }
    }

    // 2. Test the chat-rag endpoint
    console.log('\n🤖 Testing RAG endpoint...');
    const testQuestion = 'What is the Sustainable Livelihood Program?';
    const chatResponse = await fetch('/api/chat-rag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'test-user-id',  // You may need to use a real user ID
        message: testQuestion,
        history: []
      })
    });

    const chatResult = await chatResponse.json();
    
    if (chatResponse.ok) {
      console.log('✅ RAG Endpoint Response:');
      console.log(`   • Matched chunks: ${chatResult.matchedChunks || 0}`);
      console.log(`   • Found sources: ${(chatResult.sources || []).length}`);
      console.log(`   • Response length: ${(chatResult.answer || '').length} characters`);
      
      if (chatResult.matchedChunks === 0) {
        console.warn('   ⚠️  No document chunks matched! This means:');
        console.warn('      1. No documents have been uploaded yet, OR');
        console.warn('      2. No embeddings are in the database, OR');
        console.warn('      3. The query didn\'t match any documents');
      }
    } else {
      console.error('❌ RAG Endpoint Error:', chatResult.error || 'Unknown error');
      if (chatResult.error?.includes('not approved')) {
        console.log('💡 User account needs to be approved by an admin');
      }
    }

  } catch (error: any) {
    console.error('❌ Diagnostic Error:', error.message);
  }

  console.log('\n' + '='.repeat(50));
  console.log('📝 Next Steps:');
  console.log('1. If documents are 0: Upload documents using the Admin panel');
  console.log('2. If embeddings are 0: Check if document embedding is working');
  console.log('3. If matched chunks is 0: Your query might not match the documents');
  console.log('='.repeat(50));
}

// Run the diagnostic
diagnoseRAGSetup();
