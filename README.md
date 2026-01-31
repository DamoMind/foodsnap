# FoodSnap 🍱

AI-powered food recognition and nutrition tracking PWA.

Take a photo of your meal, get instant nutrition analysis with calories, protein, carbs, and fat breakdown.

## Features

- 📷 **Photo-based food recognition** using GPT-4o vision AI
- 🧮 **Automatic nutrition calculation** with portion size adjustment
- 📊 **Daily/weekly nutrition tracking** with progress visualization
- 🎯 **Customizable health goals** (weight loss / muscle gain / maintenance)
- 🏃 **Exercise tracking** with Apple Watch screenshot recognition
- ⚖️ **Body metrics tracking** (weight, body fat)
- 💊 **Supplement/medication tracking**
- 🤖 **AI health insights** with personalized recommendations
- 🔐 **Google OAuth** for cloud sync across devices
- 📱 **Offline-first PWA** with localStorage fallback
- 🌍 **Multi-language support** (Chinese / English / Japanese)

## Demo

Live demo: https://foodsnap.duku.app

## Tech Stack

**Frontend:**
- Vanilla JavaScript (no framework, ~3000 LOC)
- CSS with CSS Variables for theming
- PWA with offline support

**Backend:**
- Cloudflare Workers (TypeScript + Hono)
- Cloudflare D1 (SQLite database)
- GPT-4o via Edge AI Gateway for vision

## Quick Start

### Prerequisites

- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account

### Installation

```bash
# Clone the repository
git clone https://github.com/yourname/foodsnap.git
cd foodsnap/cloudflare-deploy

# Install dependencies
npm install

# Configure D1 database
wrangler d1 create foodsnap-db
# Update wrangler.toml with the database ID

# Run database migrations
wrangler d1 execute foodsnap-db --file=./schema.sql

# Local development
npm run dev
```

Open http://localhost:8787 in your browser.

### Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy
```

### Environment Variables (Cloudflare Secrets)

```bash
wrangler secret put JWT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put AI_GATEWAY_URL
wrangler secret put AI_GATEWAY_KEY
```

## API Documentation

See [cloudflare-deploy/API.md](cloudflare-deploy/API.md) for complete API documentation.

### Key Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/analyze` | POST | AI food image analysis |
| `/api/analyze-exercise` | POST | AI exercise screenshot analysis |
| `/api/meals` | GET/POST | Meal CRUD |
| `/api/activity` | GET/POST | Exercise tracking |
| `/api/body-metrics` | GET/POST | Weight tracking |
| `/api/supplements` | GET/POST | Supplement tracking |
| `/api/insights/health` | GET | AI health insights |

## Project Structure

```
foodsnap/
├── cloudflare-deploy/     # Production Cloudflare Workers code
│   ├── src/index.ts       # API backend (TypeScript)
│   ├── public/            # Frontend static files
│   │   ├── app.js         # Main app (vanilla JS)
│   │   ├── index.html     # Main page
│   │   └── style.css      # Styles
│   ├── schema.sql         # D1 database schema
│   ├── API.md             # API documentation
│   └── wrangler.toml      # Cloudflare config
├── CHANGELOG.md           # Version history
└── README.md              # This file
```

## Commercial Use

This project is open source under the Apache 2.0 license. You are free to:
- Use it for personal or commercial projects
- Modify and distribute
- Use with your own AI API keys

For hosted API service with higher rate limits, contact: your-email@example.com

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.

## Acknowledgments

- OpenAI GPT-4o for vision capabilities
- Anthropic Claude for alternative vision provider
- The open source community
