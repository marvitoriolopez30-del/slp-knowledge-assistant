const prompts = [
  'MD Monitoring Tool can I have the copy',
  'Can I download Annex X MD Monitoring Tool?',
  'What is SLP in MC 03 guidelines?',
  'How many 4Ps served in 2025?',
  'Show operational vs closed by municipality',
];
for (const message of prompts) {
  const res = await fetch('http://127.0.0.1:3001/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, chatSessionId: 'response-quality-examples' }),
  });
  const data = await res.json();
  const answer = String(data.answer || '');
  console.log('\n--- ' + message + ' ---');
  console.log(answer.slice(0, 1400));
}
