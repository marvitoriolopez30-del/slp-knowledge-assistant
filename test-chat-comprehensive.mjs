#!/usr/bin/env node
import fetch from 'node-fetch';

async function testChat(message, label) {
  try {
    const res = await fetch('http://localhost:3002/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message,
        history: [],
        userId: 'test',
        attachmentIds: []
      })
    });
    const data = await res.json();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST: ${label}`);
    console.log('='.repeat(60));
    console.log(data.answer.substring(0, 1200));
    if (data.answer.length > 1200) console.log('\n... (truncated)');
    
    // Check response structure
    const hasChart = data.answer.includes('**Chart/Graph**');
    const hasExplanation = data.answer.includes('**Explanation**');
    console.log(`\n✓ Has Chart: ${hasChart}, Has Explanation: ${hasExplanation}`);
    
  } catch (err) {
    console.error(`ERROR in ${label}:`, err.message);
  }
}

async function runTests() {
  await testChat('How many projects are closed?', 'Count specific status');
  await testChat('Break down participants by municipality', 'Breakdown query');
  await testChat('Show operational vs closed enterprises', 'Comparison query');
  await testChat('files checked', 'Debug query');
}

runTests();
