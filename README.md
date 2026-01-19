# FoodSnap

AI-powered food recognition and nutrition tracking PWA.

Take a photo of your meal, get instant nutrition analysis with calories, protein, carbs, and fat breakdown.

## Features

- Photo-based food recognition using GPT-4o / Claude vision
- Automatic nutrition calculation per 100g
- Daily nutrition tracking with progress bars
- Customizable health goals (weight loss / muscle gain / maintenance)
- Offline-first PWA with localStorage
- Multi-language support (Chinese / English)
- User data isolation per device

## Demo

Live demo: https://foodsnap.duizhan.app

## Tech Stack

**Frontend:**
- Vanilla JavaScript (no framework)
- CSS with CSS Variables for theming
- PWA with offline support

**Backend:**
- Python FastAPI
- Azure OpenAI GPT-4o / Azure Claude for vision
- SQLite for user data

## Quick Start

### Prerequisites

- Python 3.11+
- Azure OpenAI API key (with GPT-4o deployment) or Azure Claude API key

### Installation

```bash
# Clone the repository
git clone https://github.com/yourname/foodsnap.git
cd foodsnap

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your API keys

# Run the server
uvicorn main:app --reload
```

Open http://localhost:8000 in your browser.

### Environment Variables

```bash
# Azure OpenAI (GPT-4o)
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o

# Or Azure Claude
AZURE_CLAUDE_ENDPOINT=https://your-resource.openai.azure.com/anthropic/v1
AZURE_CLAUDE_API_KEY=your-api-key

# Vision service selection: "openai", "claude", or "auto"
VISION_SERVICE=openai
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/analyze` | POST | Analyze food image |
| `/api/meals` | GET | Get today's meals |
| `/api/meals` | POST | Save a meal |
| `/api/stats/daily` | GET | Daily nutrition stats |
| `/api/stats/weekly` | GET | Weekly nutrition stats |
| `/api/user/goal` | POST | Set nutrition goals |
| `/api/recommendations` | GET | Get meal recommendations |

## Self-Hosting

### Docker

```bash
docker build -t foodsnap .
docker run -p 8000:8000 --env-file .env foodsnap
```

### Azure Web App

```bash
# Package and deploy
zip -r deploy.zip . -x "*.pyc" -x "__pycache__/*" -x ".git/*" -x "*.db"
az webapp deploy --name your-app --resource-group your-rg --src-path deploy.zip --type zip
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
