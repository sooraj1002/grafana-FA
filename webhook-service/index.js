const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.WEBHOOK_PORT || 3001;
const GRAFANA_API_URL = process.env.GRAFANA_API_URL || 'http://grafana:3000';
const TOKEN_FILE = '/shared/grafana-token.txt';

// Read token from shared file
let GRAFANA_API_TOKEN = process.env.GRAFANA_API_TOKEN;

if (!GRAFANA_API_TOKEN && fs.existsSync(TOKEN_FILE)) {
  try {
    GRAFANA_API_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    console.log('Loaded Grafana API token from shared file');
  } catch (error) {
    console.error('Failed to read token from file:', error.message);
  }
}

if (!GRAFANA_API_TOKEN) {
  console.error('ERROR: GRAFANA_API_TOKEN not found in environment or shared file');
  process.exit(1);
}

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'grafana-folder-webhook' });
});

// Webhook endpoint for FusionAuth user registration
app.post('/webhook/user-registered', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));
    
    // Extract user information from FusionAuth webhook payload
    const { event } = req.body;
    if (!event || !event.user) {
      console.log('Invalid webhook payload: missing event.user');
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const user = event.user;
    const userEmail = user.email;
    
    if (!userEmail) {
      console.log('Invalid webhook payload: missing user email');
      return res.status(400).json({ error: 'User email is required' });
    }

    console.log(`Processing folder creation for user: ${userEmail}`);

    // Step 1: Get user from Grafana API (it should exist after OAuth login)
    const grafanaUser = await getGrafanaUserByEmail(userEmail);
    if (!grafanaUser) {
      console.log(`User ${userEmail} not found in Grafana, skipping folder creation`);
      return res.status(200).json({ message: 'User not found in Grafana, skipping' });
    }

    // Step 2: Create private folder for the user
    const folderName = `${userEmail}'s Dashboards`;
    const folder = await createGrafanaFolder(folderName);
    if (!folder) {
      throw new Error('Failed to create folder');
    }

    // Step 3: Set folder permissions (only the user can access)
    await setFolderPermissions(folder.id, grafanaUser.id);

    console.log(`Successfully created private folder "${folderName}" for user ${userEmail}`);
    res.json({ 
      message: 'Private folder created successfully',
      folder: folderName,
      user: userEmail
    });

  } catch (error) {
    console.error('Error processing webhook:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Grafana user by email
async function getGrafanaUserByEmail(email) {
  try {
    const response = await axios.get(`${GRAFANA_API_URL}/api/users/lookup?loginOrEmail=${email}`, {
      headers: {
        'Authorization': `Bearer ${GRAFANA_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null; // User not found
    }
    throw error;
  }
}

// Create a new folder in Grafana
async function createGrafanaFolder(title) {
  try {
    const response = await axios.post(`${GRAFANA_API_URL}/api/folders`, {
      title: title
    }, {
      headers: {
        'Authorization': `Bearer ${GRAFANA_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error('Error creating folder:', error.response?.data || error.message);
    throw error;
  }
}

// Set folder permissions to restrict access to specific user
async function setFolderPermissions(folderId, userId) {
  try {
    // First, remove all default permissions
    await axios.post(`${GRAFANA_API_URL}/api/folders/${folderId}/permissions`, {
      items: [
        {
          userId: userId,
          permission: 4 // Admin permission (4 = Admin, 2 = Edit, 1 = View)
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${GRAFANA_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Set permissions for folder ${folderId} - granted admin access to user ${userId}`);
  } catch (error) {
    console.error('Error setting folder permissions:', error.response?.data || error.message);
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