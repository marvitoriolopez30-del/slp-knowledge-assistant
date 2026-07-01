#!/usr/bin/env node
import fetch from 'node-fetch';

async function testChat() {
  try {
    const res = await fetch('http://localhost:3002/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Count total participants by municipality',
        history: [],
        userId: 'test',
        attachmentIds: []
      })
    });
    const data = await res.json();
    console.log('=== CHAT RESPONSE TEST ===\n');
    console.log(data.answer.substring(0, 2000));
    console.log('\n... (truncated)\n');
    
    // Check for required sections
    const hasDirectAnswer = data.answer.includes('**Direct Answer**');
    const hasExplanation = data.answer.includes('**Explanation**');
    const hasSourceUsed = data.answer.includes('**Source Used**');
    const hasDataQuality = data.answer.includes('**Data Quality Notes**');
    const hasChart = data.answer.includes('**Chart/Graph**');
    
    console.log('=== VALIDATION ===');
    console.log(`✓ Has Direct Answer: ${hasDirectAnswer}`);
    console.log(`✓ Has Explanation: ${hasExplanation}`);
    console.log(`✓ Has Source Used: ${hasSourceUsed}`);
    console.log(`✓ Has Data Quality Notes: ${hasDataQuality}`);
    console.log(`✓ Has Chart/Graph: ${hasChart}`);
    
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testChat();
