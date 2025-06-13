const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const url = require('url');
require('dotenv').config(); // Load .env variables locally

// Database config using environment variables
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gym_data',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const pool = mysql.createPool(dbConfig);

// Test DB connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connected to MySQL Database');
    connection.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
}

// Initialize DB schema
async function initDatabase() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        email VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
  }
}

// JSON body parser
const parseBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });

// Send HTTP response
const sendResponse = (res, statusCode, data, contentType = 'application/json') => {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });

  if (contentType === 'application/json') {
    res.end(JSON.stringify(data));
  } else {
    res.end(data);
  }
};

// Routes
const routes = {
  'OPTIONS *': (req, res) => sendResponse(res, 200, '', 'text/plain'),

  'POST /register': async (req, res) => {
    try {
      const { name, password, email } = await parseBody(req);

      if (!name || !password) {
        return sendResponse(res, 400, { success: false, error: 'Name and password required' });
      }

      if (password.length < 6) {
        return sendResponse(res, 400, { success: false, error: 'Password must be at least 6 characters' });
      }

      const [existing] = await pool.execute('SELECT id FROM user WHERE name = ?', [name]);
      if (existing.length > 0) {
        return sendResponse(res, 409, { success: false, error: 'Username already exists' });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      const [result] = await pool.execute(
        'INSERT INTO user (name, password, email) VALUES (?, ?, ?)',
        [name, hashedPassword, email || null]
      );

      sendResponse(res, 201, { success: true, message: 'Account created', userId: result.insertId });
    } catch (err) {
      console.error('Register error:', err);
      sendResponse(res, 500, { success: false, error: 'Internal server error' });
    }
  },

  'POST /login': async (req, res) => {
    try {
      const { name, password } = await parseBody(req);

      if (!name || !password) {
        return sendResponse(res, 400, { success: false, error: 'Name and password required' });
      }

      const [users] = await pool.execute('SELECT id, password FROM user WHERE name = ?', [name]);
      if (users.length === 0) {
        return sendResponse(res, 401, { success: false, error: 'Invalid credentials' });
      }

      const user = users[0];
      const match = await bcrypt.compare(password, user.password);

      if (!match) {
        return sendResponse(res, 401, { success: false, error: 'Invalid credentials' });
      }

      sendResponse(res, 200, { success: true, message: 'Login successful', userId: user.id });
    } catch (err) {
      console.error('Login error:', err);
      sendResponse(res, 500, { success: false, error: 'Internal server error' });
    }
  },

  'GET /users': async (req, res) => {
    try {
      const [users] = await pool.execute('SELECT id, name, email, created_at FROM user');
      sendResponse(res, 200, { success: true, users });
    } catch (err) {
      console.error('Fetch users error:', err);
      sendResponse(res, 500, { success: false, error: 'Internal server error' });
    }
  },

  'DELETE /user': async (req, res) => {
    try {
      const { id } = await parseBody(req);
      if (!id) return sendResponse(res, 400, { success: false, error: 'User ID required' });

      const [result] = await pool.execute('DELETE FROM user WHERE id = ?', [id]);

      if (result.affectedRows === 0) {
        return sendResponse(res, 404, { success: false, error: 'User not found' });
      }

      sendResponse(res, 200, { success: true, message: 'User deleted' });
    } catch (err) {
      console.error('Delete error:', err);
      sendResponse(res, 500, { success: false, error: 'Internal server error' });
    }
  },

  'PUT /user': async (req, res) => {
    try {
      const { id, email } = await parseBody(req);
      if (!id || !email) return sendResponse(res, 400, { success: false, error: 'ID and new email required' });

      const [result] = await pool.execute('UPDATE user SET email = ? WHERE id = ?', [email, id]);

      if (result.affectedRows === 0) {
        return sendResponse(res, 404, { success: false, error: 'User not found' });
      }

      sendResponse(res, 200, { success: true, message: 'Email updated' });
    } catch (err) {
      console.error('Update error:', err);
      sendResponse(res, 500, { success: false, error: 'Internal server error' });
    }
  },

  'GET /': (req, res) => {
    const html = `
      <html>
        <head><title>Body Garage</title></head>
        <body>
          <h1>🏋️ Welcome to Body Garage Server</h1>
          <p>Use Postman or frontend to access API routes.</p>
        </body>
      </html>
    `;
    sendResponse(res, 200, html, 'text/html');
  },
};

// Create server and route requests
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const method = req.method;
  const routeKey = `${method} ${parsedUrl.pathname}`;
  const handler = routes[routeKey] || routes[`${method} *`] || routes['GET /'];
  handler(req, res);
});

// Start server
const PORT = process.env.PORT || 8000;
(async () => {
  await testConnection();
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
})();
