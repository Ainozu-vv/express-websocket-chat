const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_USERNAME_LEN = 40;
const MAX_MESSAGE_LEN = 100;
const HEARTBEAT_INTERVAL_MS = 30000;

let clients = {}; // userId: { ws, username }
const connectionsByIp = new Map(); // ip -> ws

function getClientIp(req) {
  const forwarded = req && req.headers && req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === "string"
      ? forwarded.split(",")[0]
      : null;
  const ip = (raw || (req && req.socket && req.socket.remoteAddress) || "").trim();
  // Normalize IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function reserveIp(ws, ip) {
  if (!ip) return false;
  if (connectionsByIp.has(ip)) return false;
  connectionsByIp.set(ip, ws);
  ws.clientIp = ip;
  return true;
}

function releaseIp(ws) {
  const ip = ws && ws.clientIp;
  if (!ip) return;
  if (connectionsByIp.get(ip) === ws) connectionsByIp.delete(ip);
  ws.clientIp = null;
}

function safeSend(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // ignore send errors (client might be closing)
  }
}

function normalizeUsername(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return null;
  if (raw.length > MAX_USERNAME_LEN) return "barlangi_troll👺";
  return raw;
}

function getUserList() {
  return Object.keys(clients).map((id) => clients[id].username);
}

function broadcast(data, excludeUserId = null) {
  Object.keys(clients).forEach((clientId) => {
    if (excludeUserId && clientId === excludeUserId) return;
    safeSend(clients[clientId].ws, data);
  });
}

function removeClientByWs(ws) {
  const id = ws && ws.userId;
  if (!id || !clients[id]) return null;
  const username = clients[id].username;
  delete clients[id];
  return { id, username };
}

wss.on("connection", (ws, req) => {
  const ip = getClientIp(req);
  if (!reserveIp(ws, ip)) {
    safeSend(ws, {
      type: "info",
      message: "Erről az IP-ről már van aktív kapcsolat. (1 IP = 1 user)",
      users: getUserList(),
    });
    // Give the client a moment to receive the info, then close.
    setTimeout(() => {
      try {
        ws.close(1008, "1 IP = 1 user");
      } catch {
        // ignore
      }
    }, 50);
    return;
  }

  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (message) => {
    try {
      const text = Buffer.isBuffer(message) ? message.toString("utf8") : String(message);
      const data = JSON.parse(text);

      if (data.type === "setName") {
        const username = normalizeUsername(data.username);
        if (!username) {
          safeSend(ws, { type: "info", message: "Adj meg egy becenevet!", users: getUserList() });
          return;
        }

        // If already registered, ignore repeated setName.
        if (ws.userId && clients[ws.userId]) {
          safeSend(ws, { type: "info", message: `Már be vagy jelentkezve: ${clients[ws.userId].username}`, users: getUserList() });
          return;
        }

        const userId = uuidv4();
        ws.userId = userId;
        clients[userId] = { ws, username };

        console.log(`Új felhasználó csatlakozott: ${username} (${userId})`);
        const users = getUserList();
        broadcast({ type: "info", message: `${username} csatlakozott!`, users });
      } else if (data.type === "message") {
        const userId = ws.userId;
        if (!userId || !clients[userId]) {
          safeSend(ws, { type: "info", message: "Előbb csatlakozz névvel!", users: getUserList() });
          return;
        }

        const msg = typeof data.message === "string" ? data.message : "";
        if (!msg.trim()) return;

        if (msg.length <= MAX_MESSAGE_LEN) {
          console.log(`Üzenet érkezett ${clients[userId].username}-től: ${msg}`);
          broadcast({
            type: "message",
            username: clients[userId].username,
            message: msg,
          });
        } else {
          console.log(`${clients[userId].username} trollkodni akart 👺`);
          broadcast({
            type: "message",
            username: clients[userId].username,
            message: `${clients[userId].username} trollkodni akart 👺👺👺👺👺`,
          });
        }
      }
    } catch (error) {
      // Malformed JSON or unexpected payload
      safeSend(ws, { type: "info", message: "Hibás üzenet formátum.", users: getUserList() });
    }
  });

  ws.on("close", () => {
    const removed = removeClientByWs(ws);
    releaseIp(ws);
    if (!removed) return;
    console.log(`Kliens kilépett: ${removed.username} (${removed.id})`);
    broadcast({
      type: "info",
      message: `${removed.username} kilépett`,
      users: getUserList(),
    });
  });

  ws.on("error", () => {
    // socket errors will likely trigger close; keep server stable
  });
});

// Heartbeat: drop dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const removed = removeClientByWs(ws);
      if (removed) {
        broadcast({
          type: "info",
          message: `${removed.username} kilépett`,
          users: getUserList(),
        });
      }
      releaseIp(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  });
}, HEARTBEAT_INTERVAL_MS);

server.on("close", () => clearInterval(heartbeat));

// Frontend kiszolgálása
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

server.listen(3000, () => {
  console.log("szerver fut :3000");
});
