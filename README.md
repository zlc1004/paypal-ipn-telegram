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
- **IPN Forwarding**: Forward IPN data to multiple external URLs
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

3. Run with Docker Compose (includes MongoDB):
```bash
docker-compose up -d
```

This will start:
- The application on port 3000
- MongoDB (not exposed, using internal Docker DNS)
- Data persistence in `./mongodata` directory

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

### IPN Forwarding Commands (Admin Only)

- `/forward <url>` - Add URL to forward IPN data to
- `/remove-forward <url>` - Remove a forwarding URL
- `/list-forward` - List all configured forwarding URLs
- `/forward-menu` - Interactive menu to manage forwarding URLs

## PayPal IPN Setup

1. Go to PayPal Seller Preferences -> Instant Payment Notifications
2. Set the IPN URL to: `http://your-server:3000/ipn`
3. Enable IPN messages
4. For live transactions, use the production IPN URL above

**Important:**
- All IPNs are verified with PayPal's production endpoint before processing
- Only verified "VERIFIED" IPNs are processed
- Invalid or unverified IPNs are logged but not processed

## API Endpoints

- `POST /ipn` - PayPal IPN endpoint (automatically verifies with PayPal)

## Notes

- The bot uses exchange rates from `@fawazahmed0/currency-api`
- All transactions and settings are stored in MongoDB (data persists across restarts)
- MongoDB is not exposed externally for security
- Users must run `/start` before they can receive notifications
- IPN forwarding forwards the exact same data to all configured URLs
- All forward-related commands are admin-only
