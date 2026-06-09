const functions = require('@google-cloud/functions-framework');
const { google } = require('googleapis');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Environment Variables required in Google Secret Manager
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN; 
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const GDRIVE_SERVICE_ACCOUNT_JSON = JSON.parse(process.env.GDRIVE_SERVICE_ACCOUNT_JSON);

/**
 * Executes a Cloudflare API call to export the D1 database.
 */
async function fetchD1Export() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/export`;
  
  // Trigger the export task
  const triggerRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      output_format: "sqlite",
      tables: [] // Empty array = all tables
    })
  });

  if (!triggerRes.ok) throw new Error(`CF Export Trigger Failed: ${triggerRes.statusText}`);
  const triggerData = await triggerRes.json();
  const taskId = triggerData.result.at_id; // Check with your CF API if this needs to be result.task_id or result.at_bookmark

  // Poll for completion (Exports are asynchronous in Cloudflare)
  let status = "running";
  let downloadUrl = null;
  
  while (status === "running") {
    await new Promise(r => setTimeout(r, 3000)); // 3 second polling
    
    const checkRes = await fetch(`${url}/${taskId}`, {
      method: 'GET', // Or POST {output_format: "polling"} based on your schema check
      headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` }
    });
    
    const checkData = await checkRes.json();
    status = checkData.result.status;
    
    if (status === "complete") {
      downloadUrl = checkData.result.result.signed_url;
    } else if (status === "error") {
      throw new Error("CF Export Task Failed internally.");
    }
  }

  // Fetch the actual SQLite payload
  const sqlStreamRes = await fetch(downloadUrl);
  if (!sqlStreamRes.ok) throw new Error("Failed to download SQLite payload from Signed URL.");
  
  return sqlStreamRes.body; // Returns a Node.js ReadableStream
}

/**
 * Uploads a readable stream to Google Drive using the Service Account.
 */
async function uploadToDrive(fileStream, filename) {
  const auth = new google.auth.GoogleAuth({
    credentials: GDRIVE_SERVICE_ACCOUNT_JSON,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });

  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = {
    name: filename,
    parents: [GDRIVE_FOLDER_ID]
  };

  const media = {
    mimeType: 'application/x-sqlite3',
    body: fileStream // Streams directly to Drive without holding in RAM
  };

  const res = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });

  return res.data.id;
}

// Register Cloud Function Entry Point
functions.http('backupD1ToDrive', async (req, res) => {
  try {
    // 1. Authenticate Request
    // OIDC authentication is handled natively by Google API Gateway before the function even boots.

    // 2. Fetch SQLite Export Stream from Cloudflare D1
    const filename = `aztracker_backup_${new Date().toISOString().split('T')[0]}.sqlite`;
    const sqlStream = await fetchD1Export();

    // 3. Pipe directly into Google Drive
    const driveFileId = await uploadToDrive(sqlStream, filename);

    res.status(200).send(`Backup successful! Drive File ID: ${driveFileId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send(`Backup failed: ${err.message}`);
  }
});
