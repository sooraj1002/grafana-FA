const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;
const GRAFANA_API_URL = process.env.GRAFANA_API_URL || 'http://grafana:3000';
const TOKEN_FILE = '/shared/grafana-token.txt';

// Using admin credentials instead of token
console.log('Using admin credentials for Grafana API access');

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'grafana-folder-webhook' });
});

// Webhook endpoint for FusionAuth user registration
app.post('/webhook/user-registered', async (req, res) => {
  const startTime = Date.now();
  console.log('\n=== 🎯 WEBHOOK REQUEST RECEIVED ===');
  console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
  console.log(`📨 Full payload:`, JSON.stringify(req.body, null, 2));
  
  try {
    // Extract user information from FusionAuth webhook payload
    const { event } = req.body;
    if (!event || !event.user) {
      console.log('❌ VALIDATION ERROR: Missing event.user in payload');
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const user = event.user;
    const userEmail = user.email;
    
    if (!userEmail) {
      console.log('❌ VALIDATION ERROR: Missing user email');
      return res.status(400).json({ error: 'User email is required' });
    }

    console.log(`\n=== 📋 PROCESSING USER: ${userEmail} ===`);

    // Step 1: Get or create user in Grafana
    console.log('🔍 STEP 1: Looking up or creating user in Grafana...');
    console.log(`   → Sending GET request to: ${GRAFANA_API_URL}/api/users/lookup?loginOrEmail=${userEmail}`);
    console.log(`   → Using credentials: admin`);
    
    let grafanaUser = await getGrafanaUserByEmail(userEmail);
    if (!grafanaUser) {
      console.log(`❌ USER NOT FOUND: ${userEmail} not found in Grafana`);
      console.log('   → Creating user in Grafana...');
      
      grafanaUser = await createGrafanaUser(user);
      if (!grafanaUser) {
        throw new Error('Failed to create user in Grafana');
      }
      
      console.log(`✅ USER CREATED: New Grafana user ID = ${grafanaUser.id}`);
    } else {
      console.log(`✅ USER FOUND: Existing Grafana user ID = ${grafanaUser.id}`);
    }
    
    console.log(`   → User details:`, JSON.stringify(grafanaUser, null, 2));

    // Step 2: Create private folder for the user
    const folderName = `${userEmail}'s Dashboards`;
    console.log(`\n🗂️  STEP 2: Creating private folder "${folderName}"...`);
    console.log(`   → Sending POST request to: ${GRAFANA_API_URL}/api/folders`);
    
    const folder = await createGrafanaFolder(folderName);
    if (!folder) {
      throw new Error('Failed to create folder');
    }

    console.log(`✅ FOLDER CREATED: ID = ${folder.id}, UID = ${folder.uid}`);
    console.log(`   → Folder details:`, JSON.stringify(folder, null, 2));

    // Step 3: Set folder permissions (only the user can access)
    console.log(`\n🔐 STEP 3: Setting folder permissions...`);
    console.log(`   → Granting admin access to user ID ${grafanaUser.id} for folder UID ${folder.uid}`);
    console.log(`   → Sending POST request to: ${GRAFANA_API_URL}/api/folders/${folder.uid}/permissions`);
    
    await setFolderPermissions(folder.uid, grafanaUser.id);

    console.log(`✅ PERMISSIONS SET: User ${userEmail} has admin access to folder "${folderName}"`);
    
    const processingTime = Date.now() - startTime;
    console.log(`\n=== 🎉 SUCCESS SUMMARY ===`);
    console.log(`✅ User: ${userEmail} (Grafana ID: ${grafanaUser.id})`);
    console.log(`✅ Folder: "${folderName}" (ID: ${folder.id})`);
    console.log(`✅ Permissions: Admin access granted`);
    console.log(`⏱️  Total processing time: ${processingTime}ms`);
    console.log(`=== END WEBHOOK PROCESSING ===\n`);
    
    res.json({ 
      message: 'Private folder created successfully',
      folder: {
        name: folderName,
        id: folder.id,
        uid: folder.uid
      },
      user: {
        email: userEmail,
        id: grafanaUser.id
      },
      processingTime: `${processingTime}ms`
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.log(`\n=== ❌ ERROR SUMMARY ===`);
    console.log(`💥 Error: ${error.message}`);
    console.log(`📊 Error details:`, error.response?.data || 'No additional details');
    console.log(`⏱️  Processing time before error: ${processingTime}ms`);
    console.log(`=== END WEBHOOK PROCESSING ===\n`);
    
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// Get Grafana user by email
async function getGrafanaUserByEmail(email) {
  try {
    console.log(`   → Making API call to lookup user...`);
    const response = await axios.get(`${GRAFANA_API_URL}/api/users/lookup?loginOrEmail=${email}`, {
      auth: {
        username: 'admin',
        password: 'admin123'
      }
    });
    console.log(`   → ✅ Grafana API Response (${response.status}):`, JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`   → ❌ Grafana API Response (404): User not found`);
      return null; // User not found
    }
    console.log(`   → ❌ Grafana API Error (${error.response?.status}):`, error.response?.data || error.message);
    throw error;
  }
}

// Create a new user in Grafana
async function createGrafanaUser(userFromFA) {
  try {
    const userPayload = {
      email: userFromFA.email,
      login: userFromFA.email,
      name: `${userFromFA.firstName || ''} ${userFromFA.lastName || ''}`.trim() || userFromFA.email,
      password: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15), // Random password since user will login via OAuth
      OrgId: 1 // Default organization
    };
    
    console.log(`   → Making API call to create user...`);
    console.log(`   → User payload:`, JSON.stringify(userPayload, null, 2));
    
    const response = await axios.post(`${GRAFANA_API_URL}/api/admin/users`, userPayload, {
      auth: {
        username: 'admin',
        password: 'admin123'
      }
    });
    
    console.log(`   → ✅ Grafana API Response (${response.status}):`, JSON.stringify(response.data, null, 2));
    
    // Return the created user in the same format as lookup
    return {
      id: response.data.id,
      email: userPayload.email,
      login: userPayload.login,
      name: userPayload.name
    };
  } catch (error) {
    console.log(`   → ❌ Grafana API Error (${error.response?.status}):`, error.response?.data || error.message);
    throw error;
  }
}

// Create a new folder in Grafana
async function createGrafanaFolder(title) {
  try {
    console.log(`   → Making API call to create folder...`);
    console.log(`   → Folder payload:`, JSON.stringify({ title }, null, 2));
    const response = await axios.post(`${GRAFANA_API_URL}/api/folders`, {
      title: title
    }, {
      auth: {
        username: 'admin',
        password: 'admin123'
      }
    });
    console.log(`   → ✅ Grafana API Response (${response.status}):`, JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.log(`   → ❌ Grafana API Error (${error.response?.status}):`, error.response?.data || error.message);
    throw error;
  }
}

// Set folder permissions to restrict access to specific user
async function setFolderPermissions(folderUid, userId) {
  try {
    // Set restrictive permissions: only the specific user and admin should have access
    const permissionsPayload = {
      items: [
        {
          userId: 1, // Admin user ID
          permission: 4 // Admin permission
        },
        {
          userId: userId,
          permission: 4 // Admin permission for the folder owner
        }
      ]
    };
    
    console.log(`   → Making API call to set permissions...`);
    console.log(`   → Permissions payload:`, JSON.stringify(permissionsPayload, null, 2));
    
    const response = await axios.post(`${GRAFANA_API_URL}/api/folders/${folderUid}/permissions`, permissionsPayload, {
      auth: {
        username: 'admin',
        password: 'admin123'
      }
    });
    
    console.log(`   → ✅ Grafana API Response (${response.status}):`, response.data || 'No response body');
  } catch (error) {
    console.log(`   → ❌ Grafana API Error (${error.response?.status}):`, error.response?.data || error.message);
    throw error;
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Webhook service listening on port ${PORT}`);
  console.log(`Grafana API URL: ${GRAFANA_API_URL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});