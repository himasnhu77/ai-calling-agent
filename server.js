require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const axios = require("axios");
const WebSocket = require("ws");
const neo4j = require("neo4j-driver");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/** Max spoken reply length (phone-friendly). */
const MAX_SPOKEN_CHARS = 550;

// ============================================================
// NEO4J GRAPH MEMORY
// ============================================================
//
// Node labels:
//   (:Caller   { phone, firstSeen, lastSeen })
//   (:Entity   { name, type })          ← Person | Place | Topic | Preference | Fact
//   (:Memory   { text, timestamp, callId })
//
// Relationships:
//   (:Caller)-[:HAS_MEMORY]->(:Memory)
//   (:Caller)-[:MENTIONED]->(:Entity)
//   (:Memory)-[:INVOLVES]->(:Entity)
//
// Flow per turn:
//   1. Recall recent memories + known entities for caller  →  inject as system context
//   2. LLM answers with that context
//   3. Extract entities + summary from the turn  →  persist as new Memory node
// ============================================================

let _neo4jDriver = null;

function getDriver() {
  if (!_neo4jDriver) {
    const uri  = process.env.NEO4J_URI  || "bolt://localhost:7687";
    const user = process.env.NEO4J_USER || "neo4j";
    const pass = process.env.NEO4J_PASS || "password";
    _neo4jDriver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
    console.log("🧠 Neo4j driver →", uri);
  }
  return _neo4jDriver;
}

async function cypher(query, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(query, params);
    return result.records;
  } catch (err) {
    console.error("Neo4j cypher error:", err.message);
    return [];
  } finally {
    await session.close();
  }
}

/** Create indexes once on startup. */
async function initGraphSchema() {
  try {
    await cypher(`CREATE INDEX caller_phone IF NOT EXISTS FOR (c:Caller) ON (c.phone)`);
    await cypher(`CREATE INDEX entity_name  IF NOT EXISTS FOR (e:Entity) ON (e.name)`);
    console.log("🧠 Neo4j schema ready");
  } catch (err) {
    console.warn("Neo4j schema init:", err.message);
  }
}

/** Upsert a Caller node at call start. */
async function upsertCaller(phone) {
  await cypher(
    `MERGE (c:Caller { phone: $phone })
     ON CREATE SET c.firstSeen = datetime(), c.lastSeen = datetime()
     ON MATCH  SET c.lastSeen  = datetime()`,
    { phone }
  );
}

/**
 * Ask Ollama to extract a summary + named entities from a single exchange.
 * Returns { summary: string, entities: [{name, type}] }
 */
async function extractMemory(userText, assistantText) {
  const prompt =
    `You are an entity extractor for a knowledge graph memory system.\n` +
    `Given this phone call exchange:\n` +
    `USER: ${userText}\n` +
    `ASSISTANT: ${assistantText}\n\n` +
    `Return ONLY valid JSON — no markdown, no extra text:\n` +
    `{\n` +
    `  "summary": "<one sentence capturing the key fact, preference, or info shared>",\n` +
    `  "entities": [\n` +
    `    { "name": "<canonical lowercase name>", "type": "<Person|Place|Topic|Preference|Fact>" }\n` +
    `  ]\n` +
    `}\n` +
    `If nothing memorable was said, return { "summary": "", "entities": [] }.`;

  try {
    const res = await axios.post(
      "http://localhost:11434/api/chat",
      { model: "qwen2.5:1.5b", messages: [{ role: "user", content: prompt }], stream: false },
      { timeout: 30000 }
    );
    const raw = res.data.message.content.trim().replace(/^```[a-z]*\n?/i, "").replace(/```$/i, "").trim();
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Memory extraction skipped:", err.message);
    return { summary: "", entities: [] };
  }
}

/** Persist one Memory node + entities. Called async after each turn. */
async function saveMemory(phone, callId, userText, assistantText) {
  const { summary, entities } = await extractMemory(userText, assistantText);
  if (!summary) return;

  console.log(`🧠 Saving memory [${phone}]:`, summary);

  await cypher(
    `MATCH (c:Caller { phone: $phone })
     CREATE (m:Memory { text: $summary, timestamp: datetime(), callId: $callId })
     CREATE (c)-[:HAS_MEMORY]->(m)`,
    { phone, summary, callId }
  );

  for (const ent of entities) {
    if (!ent.name?.trim()) continue;
    await cypher(
      `MATCH (c:Caller { phone: $phone })
       MERGE (e:Entity { name: $name }) ON CREATE SET e.type = $type
       MERGE (c)-[:MENTIONED]->(e)
       WITH c, e
       MATCH (m:Memory { callId: $callId }) WHERE (c)-[:HAS_MEMORY]->(m)
       MERGE (m)-[:INVOLVES]->(e)`,
      { phone, name: ent.name.toLowerCase(), type: ent.type || "Topic", callId }
    );
  }
}

/**
 * Recall memories + entities for a caller.
 * Returns a context string (or null if caller is new / no memory).
 */
async function recallMemory(phone) {
  const [memRecs, entRecs] = await Promise.all([
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text ORDER BY m.timestamp DESC LIMIT 12`,
      { phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $phone })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type LIMIT 25`,
      { phone }
    ),
  ]);

  const memories  = memRecs.map(r => r.get("text")).filter(Boolean);
  const entities  = entRecs.map(r => `${r.get("name")} (${r.get("type")})`).filter(Boolean);

  if (!memories.length && !entities.length) return null;

  let ctx = "=== Caller long-term memory (from knowledge graph) ===\n";
  if (entities.length) ctx += `Known interests/entities: ${entities.join(", ")}\n`;
  if (memories.length) {
    ctx += "Recent conversation memories (newest first):\n";
    memories.forEach((m, i) => { ctx += `  ${i + 1}. ${m}\n`; });
  }
  ctx += "=== Use this to personalise your response ===";
  return ctx;
}

// ─── REST: inspect memory ────────────────────────────────────
app.get("/api/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const [memRecs, entRecs] = await Promise.all([
    cypher(
      `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory)
       RETURN m.text AS text, m.timestamp AS ts, m.callId AS callId
       ORDER BY m.timestamp DESC LIMIT 30`,
      { p: phone }
    ),
    cypher(
      `MATCH (c:Caller { phone: $p })-[:MENTIONED]->(e:Entity)
       RETURN e.name AS name, e.type AS type`,
      { p: phone }
    ),
  ]);
  res.json({
    phone,
    memories: memRecs.map(r => ({ text: r.get("text"), callId: r.get("callId") })),
    entities: entRecs.map(r => ({ name: r.get("name"), type: r.get("type") })),
  });
});

// ─── REST: clear memory ──────────────────────────────────────
app.delete("/api/memory/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  await cypher(
    `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m:Memory) DETACH DELETE m`,
    { p: phone }
  );
  res.json({ success: true, cleared: phone });
});

// ─── REST: full graph dump (for Neo4j Browser debugging) ─────
app.get("/api/graph", async (req, res) => {
  const recs = await cypher(
    `MATCH (c:Caller)-[r]->(n)
     RETURN c.phone AS caller, type(r) AS rel,
            labels(n)[0] AS nodeType,
            CASE labels(n)[0]
              WHEN 'Memory' THEN n.text
              WHEN 'Entity' THEN n.name
              ELSE toString(n)
            END AS value
     LIMIT 200`
  );
  res.json(recs.map(r => ({
    caller: r.get("caller"),
    rel:    r.get("rel"),
    type:   r.get("nodeType"),
    value:  r.get("value"),
  })));
});

// ============================================================
// SERP AGENT — Web Search
// ============================================================

const SEARCH_TRIGGERS = [
  /\b(today|tonight|right now|currently|latest|recent|new|just|breaking)\b/i,
  /\b(news|headline|update|weather|price|stock|score|result|winner|match|game)\b/i,
  /\b(who is|what is|when is|where is|how much|how many)\b/i,
  /\b(20\d\d)\b/,
  /\?$/,
];

function needsSearch(text) {
  return SEARCH_TRIGGERS.some((r) => r.test(text));
}

async function serpSearch(query) {
  if (!process.env.SERP_API_KEY) {
    console.warn("⚠️  SERP_API_KEY not set");
    return null;
  }
  try {
    console.log("🔍 SerpAPI:", query);
    const { data } = await axios.get("https://serpapi.com/search", {
      params: { q: query, api_key: process.env.SERP_API_KEY, engine: "google", num: 5, hl: "en", gl: "us" },
      timeout: 10000,
    });

    const snippets = [];
    if (data.answer_box) {
      const ab = data.answer_box;
      const a  = ab.answer || ab.snippet || ab.result || ab.contents || "";
      if (a) snippets.push(`[Direct Answer] ${a}`);
    }
    if (data.knowledge_graph?.description) snippets.push(`[Knowledge Graph] ${data.knowledge_graph.description}`);
    (data.news_results    || []).slice(0, 3).forEach(n => n.snippet && snippets.push(`[News] ${n.title}: ${n.snippet}`));
    (data.organic_results || []).slice(0, 4).forEach(r => r.snippet && snippets.push(`[Web] ${r.title || ""}: ${r.snippet}`));

    if (!snippets.length) return null;
    const ctx = `Live web search for "${query}":\n` + snippets.join("\n");
    console.log("🔍 Preview:", ctx.slice(0, 180) + "…");
    return ctx;
  } catch (err) {
    console.error("SerpAPI error:", err.response ? `${err.response.status}` : err.message);
    return null;
  }
}

// ============================================================
// OLLAMA
// ============================================================

async function askOllama(history, searchCtx, memoryCtx) {
  try {
    // Enrich system prompt with memory
    let systemContent = history[0].content;
    if (memoryCtx) systemContent += "\n\n" + memoryCtx;

    const base = [{ role: "system", content: systemContent }, ...history.slice(1)];

    const messages = searchCtx
      ? [
          ...base.slice(0, -1),
          {
            role: "user",
            content:
              `${base[base.length - 1].content}\n\n` +
              `--- Live search results ---\n${searchCtx}\n--- End ---\n\n` +
              `Use these to answer accurately. 2–4 spoken sentences max.`,
          },
        ]
      : base;

    const res = await axios.post(
      "http://localhost:11434/api/chat",
      { model: "qwen2.5:1.5b", messages, stream: false },
      { timeout: 120000 }
    );

    let text = (res.data.message.content || "").trim();
    if (text.length > MAX_SPOKEN_CHARS) {
      text = text.slice(0, MAX_SPOKEN_CHARS).trim() + " …I'll keep it brief. Want more detail?";
    }
    return text;
  } catch (err) {
    console.error("Ollama error:", err.message);
    return "Sorry, something went wrong on my end.";
  }
}

// ============================================================
// MAIN AGENT
// ============================================================

async function agentReply(history, callerPhone, callId) {
  const lastUser = [...history].reverse().find(m => m.role === "user");
  const query    = lastUser?.content || "";

  // Parallel: recall memory + search web
  const [memoryCtx, searchCtx] = await Promise.all([
    callerPhone ? recallMemory(callerPhone)                  : Promise.resolve(null),
    needsSearch(query) ? serpSearch(query) : Promise.resolve(null),
  ]);

  if (memoryCtx) console.log("🧠 Memory recalled for", callerPhone);
  if (searchCtx) console.log("🔍 Search context ready");

  const reply = await askOllama(history, searchCtx, memoryCtx);

  // Async memory save — never blocks voice response
  if (callerPhone && query && reply) {
    saveMemory(callerPhone, callId, query, reply).catch(e =>
      console.warn("saveMemory error:", e.message)
    );
  }

  return reply;
}

// ============================================================
// TWILIO REST
// ============================================================

app.post("/api/call", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber required" });
  try {
    const call = await twilioClient.calls.create({
      to:   phoneNumber,
      from: process.env.TWILIO_PHONE_NUMBER,
      url:  `${process.env.NGROK_URL}/api/twilio-answer`,
      statusCallback: `${process.env.NGROK_URL}/api/twilio-status`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });
    console.log("📞 Call:", call.sid);
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.all("/api/twilio-answer", (req, res) => {
  const host = process.env.NGROK_URL.replace("https://", "");
  res.type("text/xml").send(
    `<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`
  );
});

app.post("/api/twilio-status", (req, res) => {
  const status = req.body.CallStatus || req.query.CallStatus;
  const sid    = req.body.CallSid   || req.query.CallSid;
  if (status) console.log("📊 Status:", status, sid || "");
  res.sendStatus(200);
});

app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q required" });
  res.json({ query: q, context: await serpSearch(q) });
});

// ============================================================
// TTS — ElevenLabs μ-law
// ============================================================

const ULAW_FRAME_BYTES = 160;
const ULAW_FRAME_MS   = 20;

function padUlaw(chunk) {
  if (chunk.length === ULAW_FRAME_BYTES) return chunk;
  const p = Buffer.alloc(ULAW_FRAME_BYTES, 0xff);
  chunk.copy(p);
  return p;
}

async function sendVoice(ws, streamSid, text, history, gate) {
  try {
    if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
    console.log("🔊 TTS:", text.slice(0, 80) + "…");
    history.push({ role: "assistant", content: text });

    const { data } = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=ulaw_8000`,
      { text, model_id: "eleven_turbo_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      {
        headers: { "xi-api-key": process.env.ELEVEN_LABS_API_KEY, "Content-Type": "application/json" },
        responseType: "arraybuffer",
        timeout: 60000,
      }
    );

    const buf = Buffer.from(data);
    if (!buf.length) { console.error("TTS: empty audio"); return; }

    gate.ignoreUntil = Date.now() + Math.ceil(buf.length / ULAW_FRAME_BYTES) * ULAW_FRAME_MS + 800;

    for (let i = 0; i < buf.length; i += ULAW_FRAME_BYTES) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        event: "media", streamSid,
        media: { payload: padUlaw(buf.subarray(i, i + ULAW_FRAME_BYTES)).toString("base64") },
      }));
      if (i + ULAW_FRAME_BYTES < buf.length) await new Promise(r => setTimeout(r, ULAW_FRAME_MS));
    }
    console.log("🔊 TTS done");
  } catch (err) {
    console.error("TTS error:", err.response
      ? (Buffer.isBuffer(err.response.data) ? err.response.data.toString() : JSON.stringify(err.response.data))
      : err.message);
y  }
}

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("📞 WS connected");

  let streamSid         = null;
  let deepgramWs        = null;
  let isProcessing      = false;
  let greetingDone      = false;
  let lastTurnAt        = 0;
  let callerPhone       = null;
  const callId          = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const gate            = { ignoreUntil: 0 };
  const COOLDOWN        = 1000;

  const history = [
    {
      role: "system",
      content:
        "You are a helpful AI assistant on a phone call. " +
        "You have access to LIVE web search results AND long-term graph memory about this caller. " +
        "Use memory to personalise answers. Reference what the caller told you in past calls when relevant. " +
        "Keep answers to 2–4 spoken sentences. Never say you lack real-time data.",
    },
  ];

  function setupDeepgram() {
    const dg = new WebSocket(
      "wss://api.deepgram.com/v1/listen?" +
        new URLSearchParams({
          encoding: "mulaw", sample_rate: "8000", model: "nova-2-phonecall",
          language: "en", interim_results: "true", endpointing: "400", smart_format: "true",
        }),
      { headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` } }
    );

    dg.on("error", e => console.error("DG error:", e.message));
    dg.on("close",  (c, r) => { if (c !== 1000) console.warn("DG closed:", c, r?.toString()); });

    dg.on("message", async raw => {
      let data; try { data = JSON.parse(raw); } catch { return; }
      const tx = data?.channel?.alternatives?.[0]?.transcript || "";
      if (!data.is_final || !tx.trim() || isProcessing || !greetingDone) return;
      if (Date.now() - lastTurnAt < COOLDOWN || Date.now() < gate.ignoreUntil) return;

      console.log("🎤:", tx);
      isProcessing = true;
      try {
        history.push({ role: "user", content: tx });
        const reply = await agentReply(history, callerPhone, callId);
        await sendVoice(ws, streamSid, reply, history, gate);
        lastTurnAt = Date.now();
      } finally {
        isProcessing = false;
      }
    });

    return dg;
  }

  ws.on("message", async raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {
      case "start": {
        streamSid   = msg.start.streamSid;
        callerPhone = msg.start?.customParameters?.callerPhone || msg.start?.from || null;

        console.log(`🆔 callId: ${callId} | caller: ${callerPhone || "unknown"}`);
        if (callerPhone) upsertCaller(callerPhone).catch(console.warn);

        deepgramWs  = setupDeepgram();
        greetingDone = false;

        // Personalised greeting for returning callers
        const isReturning = callerPhone
          ? ((await cypher(
              `MATCH (c:Caller { phone: $p })-[:HAS_MEMORY]->(m) RETURN count(m) AS n`,
              { p: callerPhone }
            ))[0]?.get("n")?.toNumber() ?? 0) > 0
          : false;

        setTimeout(async () => {
          try {
            await sendVoice(
              ws, streamSid,
              isReturning
                ? "Welcome back! I remember our previous chats. What can I help you with today?"
                : "Hello! I'm your AI assistant with live web search and memory. Ask me anything. What would you like to know?",
              history, gate
            );
          } catch (e) {
            console.error("Greeting error:", e.message);
          } finally {
            greetingDone = true;
            console.log("✅ Greeting done");
          }
        }, 1000);
        break;
      }

      case "media":
        if (deepgramWs?.readyState === WebSocket.OPEN)
          deepgramWs.send(Buffer.from(msg.media.payload, "base64"));
        break;

      case "stop":
        console.log("📵 Call ended:", callId);
        deepgramWs?.close();
        break;
    }
  });
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`🚀  Port     : ${PORT}`);
  console.log(`🔗  Ngrok    : ${process.env.NGROK_URL}`);
  console.log(`🔍  SerpAPI  : ${process.env.SERP_API_KEY  ? "✅ configured" : "❌ SERP_API_KEY missing"}`);
  console.log(`🧠  Neo4j    : ${process.env.NEO4J_URI     || "bolt://localhost:7687 (default)"}`);
  await initGraphSchema();
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] === "/media-stream") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});