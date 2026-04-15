import axios from 'axios';

// Test uploading a sample document
async function testUpload() {
  const userId = 'YOUR_ADMIN_USER_ID'; // Replace with actual admin user ID
  const sampleContent = `
    Sustainable Livelihood Program (SLP) Implementation Guidelines
    
    The SLP is a government program aimed at improving the livelihood of poor families.
    
    Key Components:
    1. Skills Training - Provides vocational and business skills training
    2. Livelihood Assistance - Grants to start business activities
    3. Enterprise Development - Support for business growth
    
    Beneficiary Requirements:
    - Must be registered as indigent in the barangay
    - Must be at least 18 years old
    - Must participate in orientation and training
    - Must commit to the savings and investment component
    
    For more information, contact your local DSWD office.
  `;

  try {
    const response = await axios.post('http://localhost:3001/api/documents/upload', {
      userId,
      fileName: 'SLP_Guidelines.txt',
      fileContent: sampleContent,
      folder: 'GUIDELINES'
    });

    console.log('Upload successful:', response.data);
    console.log('Embeddings created:', response.data.chunksCreated);
  } catch (error) {
    console.error('Upload failed:', error);
  }
}

testUpload();
