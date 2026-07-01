const http = require('http');
const data = JSON.stringify({ email: 'marvitoriolopez30@gmail.com', password: 'Admin123!' });
const options = {
  hostname: '127.0.0.1', port: 3001, path: '/api/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
};
const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Content-Type:', res.headers['content-type']);
    console.log('Body:', body);
  });
});
req.write(data);
req.end();