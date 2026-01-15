# PayPal IPN Telegram Bot

A PayPal IPN server integrated with a Telegram bot for payment tracking and notifications.

## Features

- **PayPal IPN Server**: Receives live transaction notifications from PayPal
- **Multi-currency Support**: Converts all transactions to USD
- **Telegram Bot**: Real-time payment notifications via Telegram
- **Balance Tracking**: Track received payments and cashed out amounts
- **Cash Out System**: Cash out balance with configurable fee (default 10%)
- **Transaction History**: View all received transactions
- **User Management**: Add/remove users to receive notifications
- **Docker Support**: Easy deployment with Docker Compose

## Setup

### Option 1: Direct Node.js

1. Install dependencies:
```bash
npm install
```

2. Run the server:
```bash
npm start <bot_token> <admin_user_id>
```

Example:
```bash
npm start 123456789:ABCdefGHIjklMNOpqrsTUVwxyz 123456789
```

### Option 2: Docker Compose (Recommended)

1. Create a `.env` file:
```bash
cp .env.example .env
```

2. Edit `.env` with your values:
```
BOT_TOKEN=your_bot_token_here
ADMIN_USER_ID=your_admin_user_id_here
PORT=3000
```

3. Run with Docker Compose:
```bash
docker-compose up -d
```

4. View logs:
```bash
docker-compose logs -f
```

## Bot Commands

- `/start` - Register to receive notifications
- `/help` - Show available commands
- `/menu` - Show interactive command menu
- `/balance` - Check total balance
- `/transactions` - View transaction history
- `/cashout` - Cash out balance (all, half, or custom amount)
- `/notify <user_id>` - Add user to notification list (admin only)
- `/unnotify <user_id>` - Remove user from notification list (admin only)
- `/notificationlist` - View notification list (admin only)
- `/setfee <percentage>` - Set cash out fee (admin only)
- `/status` - View system status

## PayPal IPN Setup

1. Go to PayPal Seller Preferences -> Instant Payment Notifications
2. Set the IPN URL to: `http://your-server:3000/ipn`
3. Enable IPN messages

## API Endpoints

- `POST /ipn` - PayPal IPN endpoint

## Notes

- The bot uses exchange rates from `@fawazahmed0/currency-api`
- All transactions are stored in memory (restart clears data)
- Users must run `/start` before they can receive notifications
