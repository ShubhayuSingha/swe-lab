// app.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Setup PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Configure session middleware
app.use(session({
  secret: 'your_secret_key', // Use a secure, random secret in production
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));

// Middleware to parse JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files (HTML, CSS, JS) from the project root
app.use(express.static(path.join(__dirname)));

// Helper function to generate unique transaction ID
async function generateTxnId() {
  // Get the last transaction ID
  const result = await pool.query('SELECT txn_id FROM transactions ORDER BY txn_id DESC LIMIT 1');
  if (result.rows.length === 0) {
    return 'TXN00001';
  }
  const lastTxnId = result.rows[0].txn_id;
  const numberPart = parseInt(lastTxnId.substring(3));
  const newNumber = numberPart + 1;
  return 'TXN' + newNumber.toString().padStart(5, '0');
}

// POST /login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Query the customers table for the user
    const result = await pool.query('SELECT * FROM customers WHERE username = $1', [username]);
    
    if (result.rowCount === 0) {
      return res.status(401).send('Incorrect userid/password');
    }
    
    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password);
    
    if (!isValid) {
      return res.status(401).send('Incorrect userid/password');
    }
    
    // Save user info in session upon successful login
    req.session.user = { id: user.id, username: user.username };
    res.send('success');
    
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).send('Server error');
  }
});

// Endpoint to fetch the balance for the logged-in user
app.get('/balance', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const userId = req.session.user.id;
  try {
    const result = await pool.query('SELECT balance FROM customers WHERE id = $1', [userId]);
    if (result.rowCount === 0) {
      return res.status(404).send('User not found');
    }
    const balance = result.rows[0].balance;
    res.json({ balance });
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).send('Server error');
  }
});

// Logout endpoint
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send('Error logging out');
    }
    res.send('logged out');
  });
});

// POST /sendMoney endpoint
app.post('/sendMoney', async (req, res) => {
  // Check if the user is logged in
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const senderId = req.session.user.id;
  const senderUsername = req.session.user.username;
  const { recipient, amount } = req.body;

  // Validate input
  if (!recipient || isNaN(amount) || amount <= 0) {
    return res.status(400).send('Invalid input');
  }

  // Prevent sending money to self
  if (recipient === senderUsername) {
    return res.status(400).send('Cannot send money to yourself');
  }

  try {
    // Begin a transaction
    await pool.query('BEGIN');

    // Fetch sender's balance (lock the row for update)
    const senderResult = await pool.query('SELECT balance FROM customers WHERE id = $1 FOR UPDATE', [senderId]);
    if (senderResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Sender not found');
    }
    const senderBalance = parseFloat(senderResult.rows[0].balance);
    if (senderBalance < amount) {
      await pool.query('ROLLBACK');
      return res.status(400).send('Insufficient funds');
    }

    // Fetch recipient's information (lock the row for update)
    const recipientResult = await pool.query('SELECT id, balance FROM customers WHERE username = $1 FOR UPDATE', [recipient]);
    if (recipientResult.rowCount === 0) {
      await pool.query('ROLLBACK');
      return res.status(404).send('Recipient not found');
    }
    const recipientId = recipientResult.rows[0].id;
    const recipientBalance = parseFloat(recipientResult.rows[0].balance);

    // Deduct amount from sender's balance
    const newSenderBalance = senderBalance - amount;
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newSenderBalance, senderId]);

    // Add amount to recipient's balance
    const newRecipientBalance = recipientBalance + amount;
    await pool.query('UPDATE customers SET balance = $1 WHERE id = $2', [newRecipientBalance, recipientId]);

    // Generate transaction ID and record the transaction
    const txnId = await generateTxnId();
    await pool.query(
      'INSERT INTO transactions (txn_id, sender, receiver, amount) VALUES ($1, $2, $3, $4)',
      [txnId, senderUsername, recipient, amount]
    );

    // Commit the transaction
    await pool.query('COMMIT');
    res.send('success');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Error during sendMoney:', error);
    res.status(500).send('Server error');
  }
});

// GET /transactions endpoint to fetch recent transactions from the user's perspective
app.get('/transactions', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('Not logged in');
  }
  const currentUser = req.session.user.username;
  try {
    // Fetch transactions where the current user is either sender or receiver
    const result = await pool.query(
      "SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY timestamp DESC LIMIT 10",
      [currentUser]
    );
    
    // Map each transaction to include user perspective info:
    // - txn_id remains as is.
    // - "Name": if user is sender, show receiver; if user is receiver, show sender.
    // - "Date and Time": formatted from timestamp.
    // - "Credit/Debit": Credit if user is receiver, Debit if sender.
    // - "₹XXXX": amount in INR.
    const transactions = result.rows.map(txn => {
      let type, name;
      if (txn.sender === currentUser) {
        type = 'Debit';
        name = txn.receiver;
      } else {
        type = 'Credit';
        name = txn.sender;
      }
      const dateObj = new Date(txn.timestamp);
      const date = dateObj.toLocaleDateString('en-GB'); // DD/MM/YYYY
      const time = dateObj.toLocaleTimeString(); // time remains as is
      const dateTime = date + ' ' + time;
      return {
        txn_id: txn.txn_id,
        name,
        dateTime,
        type,
        amount: txn.amount
      };
    });
    
    res.json(transactions);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).send('Server error');
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
