const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.argv[2];
const ADMIN_USER_ID = process.argv[3];

if (!BOT_TOKEN || !ADMIN_USER_ID) {
  console.error('Usage: node server.js <bot_token> <admin_user_id>');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let balances = {};
let transactions = [];
let cashOutFee = 10;
let registeredUsers = new Set();
let notificationUsers = new Set();
let forwardUrls = new Set();

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
  console.log('IPN Data:', JSON.stringify(ipnData, null, 2));
  
  const paymentStatus = ipnData.payment_status;
  const mcGross = parseFloat(ipnData.mc_gross);
  const mcCurrency = ipnData.mc_currency;
  const payerEmail = ipnData.payer_email;
  const transactionId = ipnData.txn_id;
  const paymentDate = ipnData.payment_date;
  
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
        timestamp: new Date().toISOString()
      };
      
      transactions.push(transaction);
      
      for (const userId of notificationUsers) {
        if (registeredUsers.has(userId.toString())) {
          bot.sendMessage(userId, `🎉 New payment received!\n\nAmount: ${mcGross} ${mcCurrency.toUpperCase()}\nUSD: $${amountUSD.toFixed(2)}\nFrom: ${payerEmail}\nTransaction ID: ${transactionId}`);
        }
      }
      
      bot.sendMessage(ADMIN_USER_ID, `💰 Payment received:\n\n$${amountUSD.toFixed(2)} USD (${mcGross} ${mcCurrency.toUpperCase()})`);
    }
  }
  
  for (const forwardUrl of forwardUrls) {
    try {
      await axios.post(forwardUrl, ipnData, {
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
      console.log(`IPN forwarded to ${forwardUrl}`);
    } catch (error) {
      console.error(`Failed to forward IPN to ${forwardUrl}:`, error.message);
    }
  }
  
  res.status(200).send('OK');
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  registeredUsers.add(chatId);
  
  bot.sendMessage(chatId, 'Welcome! You are now registered to receive payment notifications. Use /help to see available commands.');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `Available commands:

/start - Register to receive notifications
/balance - Check global balance
/transactions - View transaction history
/cashout - Cash out balance
/menu - Show interactive menu
/notify <user_id> - Add user to notification list
/unnotify <user_id> - Remove user from notification list
/notificationlist - View notification list
/setfee <percentage> - Set cash out fee (admin only)
/status - View system status

IPN Forwarding (admin only):
/forward <url> - Add URL to forward IPN to
/remove-forward <url> - Remove forwarding URL
/list-forward - List all forwarding URLs
/forward-menu - Manage forwarding URLs via menu

Admin commands:
/setfee <percentage> - Set cash out fee
/notify <user_id> - Add user to notifications
/unnotify <user_id> - Remove user from notifications
/notificationlist - View notification list
/forward <url> - Add IPN forwarding URL`;
  
  bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/menu/, (msg) => {
  const chatId = msg.chat.id;
  
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
          { text: '👥 Notification List', callback_data: 'menu_notifications' }
        ]
      ]
    }
  };
  
  bot.sendMessage(chatId, '📱 Main Menu\n\nSelect an option:', keyboard);
});

bot.onText(/\/balance/, (msg) => {
  const chatId = msg.chat.id;
  const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
  const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
  const remaining = totalUSD - totalCashedOut;
  
  bot.sendMessage(chatId, `💰 Balance Summary:\n\nTotal Received: $${totalUSD.toFixed(2)} USD\nTotal Cashed Out: $${totalCashedOut.toFixed(2)} USD\nRemaining: $${remaining.toFixed(2)} USD`);
});

bot.onText(/\/transactions/, (msg) => {
  const chatId = msg.chat.id;
  
  if (transactions.length === 0) {
    bot.sendMessage(chatId, 'No transactions yet.');
    return;
  }
  
  let message = '📊 Transaction History:\n\n';
  transactions.slice(-10).reverse().forEach((t, index) => {
    message += `${index + 1}. $${t.amount.toFixed(2)} ${t.currency.toUpperCase()} ($${t.amountUSD.toFixed(2)} USD)\n   ${t.date}\n   ID: ${t.id}\n\n`;
  });
  
  bot.sendMessage(chatId, message);
});

bot.onText(/\/cashout/, (msg) => {
  const chatId = msg.chat.id;
  
  if (!registeredUsers.has(chatId)) {
    bot.sendMessage(chatId, 'Please use /start first.');
    return;
  }
  
  const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
  const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
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
});

bot.onText(/\/notify (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can add users to notification list.');
    return;
  }
  
  notificationUsers.add(userId);
  bot.sendMessage(chatId, `User ${userId} added to notification list.`);
});

bot.onText(/\/unnotify (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1].trim();
  
  if (chatId.toString() !== ADMIN_USER_ID) {
    bot.sendMessage(chatId, 'Only admin can remove users from notification list.');
    return;
  }
  
  notificationUsers.delete(userId);
  bot.sendMessage(chatId, `User ${userId} removed from notification list.`);
});

bot.onText(/\/notificationlist/, (msg) => {
  const chatId = msg.chat.id;
  
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
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
    const remaining = totalUSD - totalCashedOut;
    
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, `💰 Balance Summary:\n\nTotal Received: $${totalUSD.toFixed(2)} USD\nTotal Cashed Out: $${totalCashedOut.toFixed(2)} USD\nRemaining: $${remaining.toFixed(2)} USD`);
    return;
  }
  
  if (data === 'menu_transactions') {
    bot.answerCallbackQuery(query.id);
    
    if (transactions.length === 0) {
      bot.sendMessage(chatId, 'No transactions yet.');
      return;
    }
    
    let message = '📊 Transaction History:\n\n';
    transactions.slice(-10).reverse().forEach((t, index) => {
      message += `${index + 1}. $${t.amount.toFixed(2)} ${t.currency.toUpperCase()} ($${t.amountUSD.toFixed(2)} USD)\n   ${t.date}\n   ID: ${t.id}\n\n`;
    });
    
    bot.sendMessage(chatId, message);
    return;
  }
  
  if (data === 'menu_cashout') {
    bot.answerCallbackQuery(query.id);
    
    if (!registeredUsers.has(chatId)) {
      bot.sendMessage(chatId, 'Please use /start first.');
      return;
    }
    
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
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
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    
    let message = `📊 System Status\n\n`;
    message += `Total Transactions: ${transactions.length}\n`;
    message += `Total Received: $${totalUSD.toFixed(2)} USD\n`;
    message += `Registered Users: ${registeredUsers.size}\n`;
    message += `Notification Users: ${notificationUsers.size}\n`;
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
    
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
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
        if (!balances[chatId]) {
          balances[chatId] = { cashedOut: 0 };
        }
        balances[chatId].awaitingCashOut = true;
        bot.sendMessage(chatId, 'Please enter the amount to cash out (in USD):');
        return;
    }
    
    if (cashOutAmount > remaining) {
      bot.answerCallbackQuery(query.id, { text: 'Insufficient balance.' });
      return;
    }
    
    const fee = cashOutAmount * (cashOutFee / 100);
    const netAmount = cashOutAmount - fee;
    
    if (!balances[chatId]) {
      balances[chatId] = { cashedOut: 0 };
    }
    balances[chatId].cashedOut += cashOutAmount;
    
    bot.answerCallbackQuery(query.id);
    
    const resultMessage = `💸 Cash Out Successful\n\nAmount: $${cashOutAmount.toFixed(2)} USD\nFee (${cashOutFee}%): $${fee.toFixed(2)} USD\nNet: $${netAmount.toFixed(2)} USD\n\nRemaining Balance: $${(remaining - cashOutAmount).toFixed(2)} USD`;
    bot.sendMessage(chatId, resultMessage);
  }
  
  bot.answerCallbackQuery(query.id);
});

bot.on('message', (msg) => {
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
    
    forwardUrls.add(url);
    delete balances[chatId].awaitingForwardUrl;
    bot.sendMessage(chatId, `✅ URL added to forwarding list:\n${url}\n\nTotal forwarding URLs: ${forwardUrls.size}`);
    return;
  }
  
  if (text && !text.startsWith('/') && balances[chatId] && balances[chatId].awaitingForwardUrlRemove) {
    const input = text.trim();
    const urlsArray = Array.from(forwardUrls);
    let removed = false;
    
    const index = parseInt(input) - 1;
    if (!isNaN(index) && index >= 0 && index < urlsArray.length) {
      forwardUrls.delete(urlsArray[index]);
      removed = true;
    } else if (forwardUrls.has(input)) {
      forwardUrls.delete(input);
      removed = true;
    }
    
    delete balances[chatId].awaitingForwardUrlRemove;
    
    if (removed) {
      bot.sendMessage(chatId, `✅ URL removed from forwarding list.\n\nRemaining forwarding URLs: ${forwardUrls.size}`);
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
    
    const totalUSD = transactions.reduce((sum, t) => sum + t.amountUSD, 0);
    const totalCashedOut = Object.values(balances).reduce((sum, b) => sum + b.cashedOut, 0);
    const remaining = totalUSD - totalCashedOut;
    
    if (amount > remaining) {
      bot.sendMessage(chatId, `Insufficient balance. Available: $${remaining.toFixed(2)} USD`);
      return;
    }
    
    const fee = amount * (cashOutFee / 100);
    const netAmount = amount - fee;
    
    balances[chatId].cashedOut += amount;
    delete balances[chatId].awaitingCashOut;
    
    const resultMessage = `💸 Cash Out Successful\n\nAmount: $${amount.toFixed(2)} USD\nFee (${cashOutFee}%): $${fee.toFixed(2)} USD\nNet: $${netAmount.toFixed(2)} USD\n\nRemaining Balance: $${(remaining - amount).toFixed(2)} USD`;
    bot.sendMessage(chatId, resultMessage);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`IPN endpoint: http://localhost:${PORT}/ipn`);
  console.log(`Bot token: ${BOT_TOKEN.substring(0, 10)}...`);
  console.log(`Admin user ID: ${ADMIN_USER_ID}`);
});
