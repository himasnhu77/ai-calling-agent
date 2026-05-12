# 🤖 AI Voice Calling Agent

> A production-ready AI-powered outbound voice calling system built on **Twilio** + **Ultravox** + **ElevenLabs** + **Neo4j** — with real-time voice synthesis, persistent call memory, and a React dashboard.

---

## ✨ What It Does

This agent makes outbound phone calls using your Twilio number, bridges the call to an Ultravox AI session in real-time over WebSocket, and uses ElevenLabs for high-quality voice synthesis. Call context and conversation history are persisted in Neo4j Aura for cross-call memory.

**Core capabilities:**
- 📞 Outbound calling via Twilio Programmable Voice
- 🔊 Real-time voice synthesis with ElevenLabs (cloned or pre-built voice)
- 🧠 Conversational AI powered by Ultravox
- 🗄️ Cross-call memory with Neo4j graph database
- 💻 React frontend dashboard to manage and monitor calls
- 🌐 Ngrok-friendly for local dev; production-ready for EC2/VPS

---

## 🏗️ Architecture

```
Outbound Call Trigger
        │
        ▼
   Twilio API ──────────────────────► Phone Recipient
        │                                     │
        │ (Media Stream WebSocket)             │ (Audio)
        ▼                                     │
   server.js (Node.js)                        │
        │                                     │
        ├──► Ultravox AI Session (WS) ◄───────┘
        │         │
        │    (LLM responses)
        │         │
        ├──► ElevenLabs TTS (audio stream)
        │
        └──► Neo4j Aura (memory/context persistence)
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Voice Infrastructure | [Twilio](https://twilio.com) Programmable Voice |
| Conversational AI | [Ultravox](https://ultravox.ai) |
| Text-to-Speech | [ElevenLabs](https://elevenlabs.io) |
| Graph Memory | [Neo4j Aura](https://neo4j.com/cloud/aura/) |
| LLM (optional) | Google Gemini (`@google/generative-ai`) |
| Backend | Node.js + Express + `ws` (WebSocket) |
| Frontend | React (Vite) |
| HTTP Client | Axios |
| Dev Server | Nodemon |

---

## 📁 Project Structure

```
ai-calling-agent/
├── server.js            # Main backend — Twilio + Ultravox + ElevenLabs bridge
├── package.json
├── .env.example         # All required env vars
├── test.mp3             # Audio test file
└── frontend/            # React dashboard (Vite)
    ├── src/
    └── ...
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- A [Twilio](https://twilio.com) account with a phone number
- An [Ultravox](https://ultravox.ai) API key
- An [ElevenLabs](https://elevenlabs.io) API key
- A [Neo4j Aura](https://neo4j.com/cloud/aura/) free/paid instance
- [ngrok](https://ngrok.com) for local development (or a public server)

### Installation

```bash
# Clone the repo
git clone https://github.com/himasnhu77/ai-calling-agent.git
cd ai-calling-agent

# Install backend dependencies
npm install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

### Environment Setup

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Ultravox
ULTRAVOX_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ElevenLabs
ELEVEN_LABS_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Google Gemini (optional)
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Server
PORT=3000

# Ngrok (local dev only)
NGROK_URL=https://xxxx-xx-xx-xxx-xx.ngrok-free.app
```

### Running Locally

```bash
# Start ngrok in a separate terminal
ngrok http 3000

# Update NGROK_URL in .env with the generated URL

# Start backend
npm run dev

# Start frontend (separate terminal)
npm run frontend:dev
```

### Production

```bash
# Start backend
npm start

# Build frontend
npm run frontend:build
```

For EC2/VPS deployment, use [PM2](https://pm2.keymetrics.io/) + Nginx:

```bash
pm2 start server.js --name ai-calling-agent
pm2 save
```

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/make-call` | Trigger an outbound call |
| `POST` | `/incoming` | Twilio webhook for call setup |
| `WS` | `/media-stream` | WebSocket for Twilio media stream |

> Configure your Twilio phone number's Voice webhook to point to `{NGROK_URL}/incoming` (or your production URL).

---

## 🧠 Memory (Neo4j)

Call context is stored as a graph in Neo4j Aura with the following node types:

- **Caller** — phone number + caller identity
- **Entity** — extracted topics/entities from conversations
- **Memory** — individual conversation facts linked to callers

This enables the agent to remember past interactions across multiple calls — no two calls start from scratch.

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your feature branch (`git checkout -b feat/your-feature`)
3. Commit your changes (`git commit -m 'feat: add your feature'`)
4. Push to the branch (`git push origin feat/your-feature`)
5. Open a Pull Request

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

## 👤 Author

**Himanshu Thakur**  
IIIT Bhagalpur · AI & Automation Engineer  
GitHub: [@himasnhu77](https://github.com/himasnhu77)
