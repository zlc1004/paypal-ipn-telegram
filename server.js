const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/paypal-ipn';

const BOT_TOKEN = process.argv[2];
const ADMIN_USER_ID = process.argv[3];

if (!BOT_TOKEN || !ADMIN_USER_ID) {
  console.error('Usage: node server.js <bot_token> <admin_user_id>');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let client;
let db;
let balancesCollection;
let transactionsCollection;
let settingsCollection;
let registeredUsersCollection;
let notificationUsersCollection;
let forwardUrlsCollection;

let cashOutFee = 10;

async function connectToMongoDB() {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    console.log('Connected to MongoDB');
    
    db = client.db();
    balancesCollection = db.collection('balances');
    transactionsCollection = db.collection('transactions');
    settingsCollection = db.collection('settings');
    registeredUsersCollection = db.collection('registeredUsers');
    notificationUsersCollection = db.collection('notificationUsers');
    forwardUrlsCollection = db.collection('forwardUrls');
    
    const feeSetting = await settingsCollection.findOne({ key: 'cashOutFee' });
    if (feeSetting) {
      cashOutFee = feeSetting.value;
    }
    
    console.log('MongoDB collections initialized');
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error.message);
    console.log('Retrying in 5 seconds...');
    setTimeout(connectToMongoDB, 5000);
  }
}

connectToMongoDB();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

async function getExchangeRates() {
  try {
    const response = await axios.get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
    return response.data.usd;
  } catch (error) {
    console.error('Error fetching exchange rates:', error.message);
    return null;
  }
}

function convertToUSD(amount, currency, rates) {
  if (currency.toUpperCase() === 'USD') {
    return amount;
  }
  const rate = rates ? rates[currency.toLowerCase()] : null;
  if (!rate) {
    console.error(`Exchange rate for ${currency} not found`);
    return null;
  }
  return amount / rate;
}

app.post('/ipn', async (req, res) => {
  console.log('Received IPN notification');
  
  const ipnData = req.body;
  
  // Verify IPN with PayPal
  try {
    const params = new URLSearchParams();
    params.append('cmd', '_notify-validate');
    for (const key in ipnData) {
      params.append(key, ipnData[key]);
    }
    
    const verifyResponse = await axios.post('https://ipnpb.paypal.com/cgi-bin/webscr', params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Node-IPN-Verification-Script'
      }
    });
    
    if (verifyResponse.data !== 'VERIFIED') {
      console.log(`IPN Verification Failed: ${verifyResponse.data}`);
      return res.status(200).send('OK');
    }
    console.log('IPN Verified');
  } catch (error) {
    console.error('IPN Verification Error:', error.message);
    return res.status(200).send('OK');
  }
  
  console.log('Processing Verified IPN Data:', JSON.stringify(ipnData, null, 2));
  
  const paymentStatus = ipnData.payment_status;
  const mcGross = parseFloat(ipnData.mc_gross);
  const mcCurrency = ipnData.mc_currency;
  const payerEmail = ipnData.payer_email;
  const transactionId = ipnData.txn_id;
  const paymentDate = ipnData.payment_date;
  const transactionSubject = ipnData.transaction_subject || ipnData.item_name || 'Payment';
  
  if (paymentStatus === 'Completed' && mcGross > 0) {
    const rates = await getExchangeRates();
    const amountUSD = convertToUSD(mcGross, mcCurrency, rates);
    
    if (amountUSD !== null) {
      const transaction = {
        id: transactionId,
        date: paymentDate,
        amount: mcGross,
        currency: mcCurrency,
        amountUSD: amountUSD,
        email: payerEmail,
        subject: transactionSubject,
        timestamp: new Date().toISOString()
      };
      
      await transactionsCollection.insertOne(transaction);
      
      const notificationUsersList = await notificationUsersCollection.find({}).toArray();
      const registeredUsersList = await registeredUsersCollection.find({}).toArray();
      const registeredUserIds = registeredUsersList.map(u => u.userId);
      
      for (const user of notificationUsersList) {
        if (registeredUserIds.includes(user.userId)) {
          bot.sendMessage(user.userId, `🎉 New payment received!\n\n📝 ${transactionSubject}\n💵 Amount: ${mcGross} ${mcCurrency.toUpperCase()} ($${amountUSD.toFixed(2)} USD)\n👤 From: ${payerEmail}\n🆔 ID: ${transactionId}`);
        }
      }
      
      bot.sendMessage(ADMIN_USER_ID, `💰 Payment received:\n\n📝 ${transactionSubject}\n💵 $${amountUSD.toFixed(2)} USD (${mcGross} ${mcCurrency.toUpperCase()})\n👤 From: ${payerEmail}\n🆔 ID: ${transactionId}`);
    }
  }
  
  const forwardUrlsList = await forwardUrlsCollection.find({}).toArray();
  for (const forwardUrlDoc of forwardUrlsList) {
    try {
      await axios.post(forwardUrlDoc.url, ipnData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        transformRequest: [(data) => {
          const params = new URLSearchParams();
          for (const key in data) {
            params.append(key, data[key]);
          }
          return params.toString();
        }]
      });
      console.log(`IPN forwarded to ${forwardUrlDoc.url}`);
    } catch (error) {
      console.error(`Failed to forward IPN to ${forwardUrlDoc.url}:`, error.message);
    }
  }
  
  res.status(200).send('OK');
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  registeredUsersCollection.updateOne({ userId: chatId }, { $set: { userId: chatId, registeredAt: new Date() } }, { upsert: true });
  
  bot.sendMessage(chatId, 'Welcome! You are now registered to receive payment notifications. Use /help to see available commands.');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = chatId.toString() === ADMIN_USER_ID;
  
  let helpMessage = `📖 Available Commands\n\n`;
  
  helpMessage += `User Commands:\n`;
  helpMessage += `/start - Register to receive notifications\n`;
  helpMessage += `/balance - Check global balance\n`;
  helpMessage += `/transactions - View transaction history\n`;
  helpMessage += `/status - View system status\n`;
  
  if (isAdmin) {
    helpMessage += `\n🔐 Admin Commands:\n`;
    helpMessage += `/cashout - Cash out balance\n`;
    helpMessage += `/menu - Show interactive menu\n`;
    helpMessage += `/setfee <percentage> - Set cash out fee\n`;
    helpMessage += `/notify <user_id> - Add user to notifications\n`;
    helpMessage += `/unnotify <user_id> - Remove user from notifications\n`;
    helpMessage += `/notificationlist - View notification list\n`;
    helpMessage += `/forward <url> - Add IPN forwarding URL\n`;
    helpMessage += `/remove-forward <url> - Remove forwarding URL\n`;
    helpMessage += `/list-forward - List all forwarding URLs\n`;
    helpMessage += `/forward-menu - Manage forwarding URLs via menu\n`;
  }
  
  bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'This command is admin only.');
    return;
  }
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💰 Balance', callback_data: 'menu_balance' },
          { text: '📊 Transactions', callback_data: 'menu_transactions' }
        ],
        [
          { text: '💸 Cash Out', callback_data: 'menu_cashout' },
          { text: '📋 Status', callback_data: 'menu_status' }
        ],
        [
          { text: '👥 Notification List', callback_data: 'menu_notifications' },
          { text: '📤 Forward URLs', callback_data: 'forward_menu' }
        ]
      ]
    }
  };
  
  bot.sendMessage(chatId, '📱 Admin Menu\n\nSelect an option:', keyboard);
});

bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  
  transactionsCollection.find({}).toArray().then(transactions => {
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    
    balancesCollection.find({}).toArray().then(balances => {
      const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
      const remaining = totalUSD - totalCashedOut;
      
      bot.sendMessage(chatId, `💰 Balance Summary:\n\nTotal Received: $${totalUSD.toFixed(2)} USD\nTotal Cashed Out: $${totalCashedOut.toFixed(2)} USD\nRemaining: $${remaining.toFixed(2)} USD`);
    }).catch(err => {
      console.error('Error fetching balances:', err);
      bot.sendMessage(chatId, 'Error fetching balance data.');
    });
  }).catch(err => {
    console.error('Error fetching transactions:', err);
    bot.sendMessage(chatId, 'Error fetching transaction data.');
  });
});

bot.onText(/\/transactions/, (msg) => {
  const chatId = msg.chat.id;
  
  transactionsCollection.find({}).sort({ timestamp: -1 }).limit(10).toArray().then(transactions => {
    if (transactions.length === 0) {
      bot.sendMessage(chatId, 'No transactions yet.');
      return;
    }
    
    let message = '📊 Transaction History:\n\n';
    transactions.forEach((t, index) => {
      const subject = t.subject || 'Payment';
      message += `${index + 1}. 📝 ${subject}\n   💵 $${t.amount.toFixed(2)} ${t.currency.toUpperCase()} ($${t.amountUSD.toFixed(2)} USD)\n   📅 ${t.date}\n   🆔 ${t.id}\n\n`;
    });
    
    bot.sendMessage(chatId, message);
  }).catch(err => {
    console.error('Error fetching transactions:', err);
    bot.sendMessage(chatId, 'Error fetching transaction data.');
  });
});

bot.onText(/\/cashout/, (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'This command is admin only.');
    return;
  }
  
  transactionsCollection.find({}).toArray().then(transactions => {
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    
    balancesCollection.find({}).toArray().then(balances => {
      const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
      const remaining = totalUSD - totalCashedOut;
      
      if (remaining <= 0) {
        bot.sendMessage(chatId, 'No balance available to cash out.');
        return;
      }
      
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Cash Out All', callback_data: `cashout_all_${chatId}` },
              { text: 'Cash Out Half', callback_data: `cashout_half_${chatId}` }
            ],
            [
              { text: 'Custom Amount', callback_data: `cashout_custom_${chatId}` }
            ]
          ]
        }
      };
      
      bot.sendMessage(chatId, `💸 Cash Out Options\n\nAvailable Balance: $${remaining.toFixed(2)} USD\nCash Out Fee: ${cashOutFee}%\n\nSelect an option:`, keyboard);
    }).catch(err => {
      console.error('Error fetching balances:', err);
      bot.sendMessage(chatId, 'Error fetching balance data.');
    });
  }).catch(err => {
    console.error('Error fetching transactions:', err);
    bot.sendMessage(chatId, 'Error fetching transaction data.');
  });
});

bot.onText(/\/notify (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can add users to notification list.');
    return;
  }
  
  notificationUsersCollection.updateOne({ userId: userId }, { $set: { userId: userId, addedAt: new Date() } }, { upsert: true }).then(() => {
    bot.sendMessage(chatId, `User ${userId} added to notification list.`);
  }).catch(err => {
    console.error('Error adding notification user:', err);
    bot.sendMessage(chatId, 'Error adding user to notification list.');
  });
});

bot.onText(/\/unnotify (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can remove users from notification list.');
    return;
  }
  
  notificationUsersCollection.deleteOne({ userId: userId }).then(result => {
    if (result.deletedCount > 0) {
      bot.sendMessage(chatId, `User ${userId} removed from notification list.`);
    } else {
      bot.sendMessage(chatId, `User ${userId} not found in notification list.`);
    }
  }).catch(err => {
    console.error('Error removing notification user:', err);
    bot.sendMessage(chatId, 'Error removing user from notification list.');
  });
});

bot.onText(/\/notificationlist/, (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can view notification list.');
    return;
  }
  
  notificationUsersCollection.find({}).toArray().then(users => {
    if (users.length === 0) {
      bot.sendMessage(chatId, 'No users in notification list.');
      return;
    }
    
    let message = '📋 Notification List:\n\n';
    users.forEach(user => {
      message += `- ${user.userId}\n`;
    });
    
    bot.sendMessage(chatId, message);
  }).catch(err => {
    console.error('Error fetching notification list:', err);
    bot.sendMessage(chatId, 'Error fetching notification list.');
  });
});

bot.onText(/\/setfee (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const newFee = parseFloat(match[1].trim());
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can set cash out fee.');
    return;
  }
  
  if (isNaN(newFee) || newFee < 0 || newFee > 100) {
    bot.sendMessage(chatId, 'Invalid fee. Please provide a percentage between 0 and 100.');
    return;
  }
  
  cashOutFee = newFee;
  bot.sendMessage(chatId, `Cash out fee set to ${cashOutFee}%`);
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
  
  let message = `📊 System Status\n\n`;
  message += `Total Transactions: ${transactions.length}\n`;
  message += `Total Received: $${totalUSD.toFixed(2)} USD\n`;
  message += `Registered Users: ${registeredUsers.size}\n`;
  message += `Notification Users: ${notificationUsers.size}\n`;
  message += `Cash Out Fee: ${cashOutFee}%\n`;
  
  bot.sendMessage(chatId, message);
});

bot.onText(/\/forward (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can add forwarding URLs.');
    return;
  }
  
  try {
    new URL(url);
  } catch (error) {
    bot.sendMessage(chatId, 'Invalid URL. Please provide a valid URL including http:// or https://');
    return;
  }
  
  forwardUrls.add(url);
  bot.sendMessage(chatId, `URL added to forwarding list:\n${url}`);
});

bot.onText(/\/remove-forward (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can remove forwarding URLs.');
    return;
  }
  
  if (forwardUrls.delete(url)) {
    bot.sendMessage(chatId, `URL removed from forwarding list:\n${url}`);
  } else {
    bot.sendMessage(chatId, `URL not found in forwarding list:\n${url}`);
  }
});

bot.onText(/\/list-forward/, (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can view forwarding list.');
    return;
  }
  
  if (forwardUrls.size === 0) {
    bot.sendMessage(chatId, 'No forwarding URLs configured.');
    return;
  }
  
  let message = '📤 Forwarding URLs:\n\n';
  let index = 1;
  for (const url of forwardUrls) {
    message += `${index}. ${url}\n`;
    index++;
  }
  
  bot.sendMessage(chatId, message);
});

bot.onText(/\/forward-menu/, (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can access forward menu.');
    return;
  }
  
  let forwardList = '';
  if (forwardUrls.size === 0) {
    forwardList = 'No forwarding URLs configured.';
  } else {
    forwardList = 'Configured forwarding URLs:\n\n';
    let index = 1;
    for (const url of forwardUrls) {
      forwardList += `${index}. ${url}\n`;
      index++;
    }
  }
  
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ Add Forward URL', callback_data: 'forward_add' },
          { text: '➖ Remove Forward URL', callback_data: 'forward_remove' }
        ],
        [
          { text: '📋 List Forward URLs', callback_data: 'forward_list' },
          { text: '🗑️ Clear All', callback_data: 'forward_clear' }
        ],
        [
          { text: '🔄 Refresh', callback_data: 'forward_menu' }
        ]
      ]
    }
  };
  
  bot.sendMessage(chatId, `📤 IPN Forward Management\n\n${forwardList}\nSelect an option:`, keyboard);
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  
  if (data === 'menu_balance') {
    const transactions = await transactionsCollection.find({}).toArray();
    const balances = await balancesCollection.find({}).toArray();
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
    const remaining = totalUSD - totalCashedOut;
    
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, `💰 Balance Summary:\n\nTotal Received: $${totalUSD.toFixed(2)} USD\nTotal Cashed Out: $${totalCashedOut.toFixed(2)} USD\nRemaining: $${remaining.toFixed(2)} USD`);
    return;
  }
  
  if (data === 'menu_transactions') {
    bot.answerCallbackQuery(query.id);
    
    const transactions = await transactionsCollection.find({}).sort({ timestamp: -1 }).limit(10).toArray();
    if (transactions.length === 0) {
      bot.sendMessage(chatId, 'No transactions yet.');
      return;
    }
    
    let message = '📊 Transaction History:\n\n';
    transactions.forEach((t, index) => {
      const subject = t.subject || 'Payment';
      message += `${index + 1}. 📝 ${subject}\n   💵 $${t.amount.toFixed(2)} ${t.currency.toUpperCase()} ($${t.amountUSD.toFixed(2)} USD)\n   📅 ${t.date}\n   🆔 ${t.id}\n\n`;
    });
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'menu_cashout') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'This action is admin only.');
      return;
    }
    
    const transactions = await transactionsCollection.find({}).toArray();
    const balances = await balancesCollection.find({}).toArray();
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
    const remaining = totalUSD - totalCashedOut;
    
    if (remaining <= 0) {
      bot.sendMessage(chatId, 'No balance available to cash out.');
      return;
    }
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Cash Out All', callback_data: `cashout_all_${chatId}` },
            { text: 'Cash Out Half', callback_data: `cashout_half_${chatId}` }
          ],
          [
            { text: 'Custom Amount', callback_data: `cashout_custom_${chatId}` }
          ]
        ]
      }
    };
    
    bot.sendMessage(chatId, `💸 Cash Out Options\n\nAvailable Balance: $${remaining.toFixed(2)} USD\nCash Out Fee: ${cashOutFee}%\n\nSelect an option:`, keyboard);
    return;
  }
  
  if (data === 'menu_status') {
    const transactions = await transactionsCollection.find({}).toArray();
    const registeredUsersCount = await registeredUsersCollection.countDocuments({});
    const notificationUsersCount = await notificationUsersCollection.countDocuments({});
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    
    let message = `📊 System Status\n\n`;
    message += `Total Transactions: ${transactions.length}\n`;
    message += `Total Received: $${totalUSD.toFixed(2)} USD\n`;
    message += `Registered Users: ${registeredUsersCount}\n`;
    message += `Notification Users: ${notificationUsersCount}\n`;
    message += `Cash Out Fee: ${cashOutFee}%\n`;
    
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'menu_notifications') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can view notification list.');
      return;
    }
    
    const users = await notificationUsersCollection.find({}).toArray();
    if (users.length === 0) {
      bot.sendMessage(chatId, 'No users in notification list.');
      return;
    }
    
    let message = '📋 Notification List:\n\n';
    users.forEach(user => {
      message += `- ${user.userId}\n`;
    });
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'forward_add') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can add forwarding URLs.');
      return;
    }
    
    const balance = await balancesCollection.findOne({ _id: chatId.toString() });
    if (!balance) {
      await balancesCollection.insertOne({ _id: chatId.toString(), awaitingForwardUrl: true });
    } else {
      await balancesCollection.updateOne({ _id: chatId.toString() }, { $set: { awaitingForwardUrl: true } });
    }
    
    bot.sendMessage(chatId, 'Please enter the URL to forward IPN to:\n(e.g., https://example.com/ipn)');
    return;
  }
  
  if (data === 'forward_remove') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can remove forwarding URLs.');
      return;
    }
    
    const urls = await forwardUrlsCollection.find({}).toArray();
    if (urls.length === 0) {
      bot.sendMessage(chatId, 'No forwarding URLs configured.');
      return;
    }
    
    const balance = await balancesCollection.findOne({ _id: chatId.toString() });
    if (!balance) {
      await balancesCollection.insertOne({ _id: chatId.toString(), awaitingForwardUrlRemove: true });
    } else {
      await balancesCollection.updateOne({ _id: chatId.toString() }, { $set: { awaitingForwardUrlRemove: true } });
    }
    
    let message = 'Select a URL to remove:\n\n';
    let index = 1;
    for (const urlDoc of urls) {
      message += `${index}. ${urlDoc.url}\n`;
      index++;
    }
    
    bot.sendMessage(chatId, message + '\nEnter the number or full URL:');
    return;
  }
  
  if (data === 'forward_list') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can view forwarding list.');
      return;
    }
    
    const urls = await forwardUrlsCollection.find({}).toArray();
    if (urls.length === 0) {
      bot.sendMessage(chatId, 'No forwarding URLs configured.');
      return;
    }
    
    let message = '📤 Forwarding URLs:\n\n';
    let index = 1;
    for (const urlDoc of urls) {
      message += `${index}. ${urlDoc.url}\n`;
      index++;
    }
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'forward_clear') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can clear forwarding URLs.');
      return;
    }
    
    const count = await forwardUrlsCollection.countDocuments({});
    await forwardUrlsCollection.deleteMany({});
    bot.sendMessage(chatId, `Cleared ${count} forwarding URL(s).`);
    return;
  }
  
  if (data === 'forward_menu') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can access forward menu.');
      return;
    }
    
    const urls = await forwardUrlsCollection.find({}).toArray();
    let forwardList = '';
    if (urls.length === 0) {
      forwardList = 'No forwarding URLs configured.';
    } else {
      forwardList = 'Configured forwarding URLs:\n\n';
      let index = 1;
      for (const urlDoc of urls) {
        forwardList += `${index}. ${urlDoc.url}\n`;
        index++;
      }
    }
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Add Forward URL', callback_data: 'forward_add' },
            { text: '➖ Remove Forward URL', callback_data: 'forward_remove' }
          ],
          [
            { text: '📋 List Forward URLs', callback_data: 'forward_list' },
            { text: '🗑️ Clear All', callback_data: 'forward_clear' }
          ],
          [
            { text: '🔄 Refresh', callback_data: 'forward_menu' }
          ]
        ]
      }
    };
    
    bot.sendMessage(chatId, `📤 IPN Forward Management\n\n${forwardList}\nSelect an option:`, keyboard);
    return;
  }
  
  if (data === 'menu_notifications') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can view notification list.');
      return;
    }
    
    if (notificationUsers.size === 0) {
      bot.sendMessage(chatId, 'No users in notification list.');
      return;
    }
    
    let message = '📋 Notification List:\n\n';
    notificationUsers.forEach(userId => {
      message += `- ${userId}\n`;
    });
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'forward_add') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can add forwarding URLs.');
      return;
    }
    
    if (!balances[chatId]) {
      balances[chatId] = {};
    }
    balances[chatId].awaitingForwardUrl = true;
    bot.sendMessage(chatId, 'Please enter the URL to forward IPN to:\n(e.g., https://example.com/ipn)');
    return;
  }
  
  if (data === 'forward_remove') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can remove forwarding URLs.');
      return;
    }
    
    if (forwardUrls.size === 0) {
      bot.sendMessage(chatId, 'No forwarding URLs configured.');
      return;
    }
    
    if (!balances[chatId]) {
      balances[chatId] = {};
    }
    balances[chatId].awaitingForwardUrlRemove = true;
    
    let message = 'Select a URL to remove:\n\n';
    let index = 1;
    for (const url of forwardUrls) {
      message += `${index}. ${url}\n`;
      index++;
    }
    
    bot.sendMessage(chatId, message + '\nEnter the number or full URL:');
    return;
  }
  
  if (data === 'forward_list') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can view forwarding list.');
      return;
    }
    
    if (forwardUrls.size === 0) {
      bot.sendMessage(chatId, 'No forwarding URLs configured.');
      return;
    }
    
    let message = '📤 Forwarding URLs:\n\n';
    let index = 1;
    for (const url of forwardUrls) {
      message += `${index}. ${url}\n`;
      index++;
    }
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'forward_clear') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can clear forwarding URLs.');
      return;
    }
    
    const count = forwardUrls.size;
    forwardUrls.clear();
    bot.sendMessage(chatId, `Cleared ${count} forwarding URL(s).`);
    return;
  }
  
  if (data === 'forward_menu') {
    bot.answerCallbackQuery(query.id);
    
    if (chatId.toString() !== ADMIN_USER_ID) {
      bot.sendMessage(chatId, 'Only admin can access forward menu.');
      return;
    }
    
    let forwardList = '';
    if (forwardUrls.size === 0) {
      forwardList = 'No forwarding URLs configured.';
    } else {
      forwardList = 'Configured forwarding URLs:\n\n';
      let index = 1;
      for (const url of forwardUrls) {
        forwardList += `${index}. ${url}\n`;
        index++;
      }
    }
    
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Add Forward URL', callback_data: 'forward_add' },
            { text: '➖ Remove Forward URL', callback_data: 'forward_remove' }
          ],
          [
            { text: '📋 List Forward URLs', callback_data: 'forward_list' },
            { text: '🗑️ Clear All', callback_data: 'forward_clear' }
          ],
          [
            { text: '🔄 Refresh', callback_data: 'forward_menu' }
          ]
        ]
      }
    };
    
    bot.sendMessage(chatId, `📤 IPN Forward Management\n\n${forwardList}\nSelect an option:`, keyboard);
    return;
  }
  
  if (data.startsWith('cashout_')) {
    const parts = data.split('_');
    const action = parts[1];
    const targetChatId = parts[2];
    
    if (chatId.toString() !== targetChatId) {
      bot.answerCallbackQuery(query.id, { text: 'This action is not for you.' });
      return;
    }
    
    const transactions = await transactionsCollection.find({}).toArray();
    const balances = await balancesCollection.find({}).toArray();
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
    const remaining = totalUSD - totalCashedOut;
    
    let cashOutAmount;
    
    switch (action) {
      case 'all':
        cashOutAmount = remaining;
        break;
      case 'half':
        cashOutAmount = remaining / 2;
        break;
      case 'custom':
        let balance = await balancesCollection.findOne({ _id: chatId.toString() });
        if (!balance) {
          await balancesCollection.insertOne({ _id: chatId.toString(), cashedOut: 0, awaitingCashOut: true });
        } else {
          await balancesCollection.updateOne({ _id: chatId.toString() }, { $set: { awaitingCashOut: true } });
        }
        bot.sendMessage(chatId, 'Please enter the amount to cash out (in USD):');
        return;
    }
    
    if (cashOutAmount > remaining) {
      bot.answerCallbackQuery(query.id, { text: 'Insufficient balance.' });
      return;
    }
    
    const fee = cashOutAmount * (cashOutFee / 100);
    const netAmount = cashOutAmount - fee;
    
    let balance = await balancesCollection.findOne({ _id: chatId.toString() });
    if (!balance) {
      await balancesCollection.insertOne({ _id: chatId.toString(), cashedOut: cashOutAmount });
    } else {
      await balancesCollection.updateOne({ _id: chatId.toString() }, { $inc: { cashedOut: cashOutAmount } });
    }
    
    bot.answerCallbackQuery(query.id);
    
    const resultMessage = `💸 Cash Out Successful\n\nAmount: $${cashOutAmount.toFixed(2)} USD\nFee (${cashOutFee}%): $${fee.toFixed(2)} USD\nNet: $${netAmount.toFixed(2)} USD\n\nRemaining Balance: $${(remaining - cashOutAmount).toFixed(2)} USD`;
    bot.sendMessage(chatId, resultMessage);
  }
  
  bot.answerCallbackQuery(query.id);
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (text && !text.startsWith('/') && balances[chatId] && balances[chatId].awaitingForwardUrl) {
    const url = text.trim();
    
    try {
      new URL(url);
    } catch (error) {
      bot.sendMessage(chatId, 'Invalid URL. Please provide a valid URL including http:// or https://');
      return;
    }
    
    await forwardUrlsCollection.insertOne({ url: url });
    const balance = await balancesCollection.findOne({ _id: chatId.toString() });
    if (balance) {
      await balancesCollection.updateOne({ _id: chatId.toString() }, { $unset: { awaitingForwardUrl: "" } });
    }
    
    const count = await forwardUrlsCollection.countDocuments({});
    bot.sendMessage(chatId, `✅ URL added to forwarding list:\n${url}\n\nTotal forwarding URLs: ${count}`);
    return;
  }
  
  if (text && !text.startsWith('/') && balances[chatId] && balances[chatId].awaitingForwardUrlRemove) {
    const input = text.trim();
    const urls = await forwardUrlsCollection.find({}).toArray();
    let removed = false;
    
    const index = parseInt(input) - 1;
    if (!isNaN(index) && index >= 0 && index < urls.length) {
      await forwardUrlsCollection.deleteOne({ _id: urls[index]._id });
      removed = true;
    } else {
      const found = await forwardUrlsCollection.findOne({ url: input });
      if (found) {
        await forwardUrlsCollection.deleteOne({ _id: found._id });
        removed = true;
      }
    }
    
    const balance = await balancesCollection.findOne({ _id: chatId.toString() });
    if (balance) {
      await balancesCollection.updateOne({ _id: chatId.toString() }, { $unset: { awaitingForwardUrlRemove: "" } });
    }
    
    if (removed) {
      const count = await forwardUrlsCollection.countDocuments({});
      bot.sendMessage(chatId, `✅ URL removed from forwarding list.\n\nRemaining forwarding URLs: ${count}`);
    } else {
      bot.sendMessage(chatId, '❌ URL not found. Please check the number or URL and try again.');
    }
    return;
  }
  
  if (text && !text.startsWith('/') && balances[chatId] && balances[chatId].awaitingCashOut) {
    const amount = parseFloat(text);
    
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, 'Invalid amount. Please enter a positive number.');
      return;
    }
    
    const transactions = await transactionsCollection.find({}).toArray();
    const balances = await balancesCollection.find({}).toArray();
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = balances.reduce((sum, b) => sum + (b.cashedOut || 0), 0);
    const remaining = totalUSD - totalCashedOut;
    
    if (amount > remaining) {
      bot.sendMessage(chatId, `Insufficient balance. Available: $${remaining.toFixed(2)} USD`);
      return;
    }
    
    const fee = amount * (cashOutFee / 100);
    const netAmount = amount - fee;
    
    await balancesCollection.updateOne({ _id: chatId.toString() }, { $inc: { cashedOut: amount }, $unset: { awaitingCashOut: "" } });
    
    const resultMessage = `💸 Cash Out Successful\n\nAmount: $${amount.toFixed(2)} USD\nFee (${cashOutFee}%): $${fee.toFixed(2)} USD\nNet: $${netAmount.toFixed(2)} USD\n\nRemaining Balance: $${(remaining - amount).toFixed(2)} USD`;
    bot.sendMessage(chatId, resultMessage);
  }
});

app.listen(3000, () => {
  console.log(`Server running on port 3000`);
  console.log(`IPN endpoint: http://localhost:3000/ipn`);
  console.log(`Bot token: ${BOT_TOKEN.substring(0, 10)}...`);
  console.log(`Admin user ID: ${ADMIN_USER_ID}`);
});
