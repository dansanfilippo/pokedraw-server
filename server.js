import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// ===== Config =====
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me"; // set in env
const ROUND_SECONDS = parseInt(process.env.ROUND_SECONDS || "60", 10);

// For MVP: local Pokémon list (replace with full list / API later)
const POKEMON = [
  "pikachu", "bulbasaur", "charmander", "squirtle", "gengar",
  "eevee", "snorlax", "psyduck", "jigglypuff", "mewtwo"
];

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

// ===== In-memory state (OK for MVP; use Redis for production/multi-instance) =====
/**
 * lobbies[lobbyId] = {
 *   lobbyId,
 *   adminSocketId,
 *   round: { pokemon, startedAtMs, endsAtMs, active },
 *   scores: { [playerId]: number },
 *   players: { [socketId]: { name, playerId } }
 * }
 */
const lobbies = new Map();

function randomPokemon() {
  return POKEMON[Math.floor(Math.random() * POKEMON.length)];
}

function now() {
  return Date.now();
}

function sanitizeName(name) {
  const n = String(name || "").trim().slice(0, 18);
  return n || "Player";
}

function makeLobbyId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getLobby(lobbyId) {
  return lobbies.get(lobbyId);
}

function lobbySnapshot(lobby) {
  const scores = Object.entries(lobby.scores).map(([playerId, score]) => ({
    playerId,
    score
  }));
  scores.sort((a, b) => b.score - a.score);

  return {
    lobbyId: lobby.lobbyId,
    hasAdmin: Boolean(lobby.adminSocketId),
    round: lobby.round
      ? {
          active: lobby.round.active,
          startedAtMs: lobby.round.startedAtMs,
          endsAtMs: lobby.round.endsAtMs
        }
      : { active: false },
    players: Object.values(lobby.players).map(p => ({
      name: p.name,
      playerId: p.playerId,
      score: lobby.scores[p.playerId] || 0
    }))
  };
}

function createLobby() {
  const lobbyId = makeLobbyId();
  const lobby = {
    lobbyId,
    adminSocketId: null,
    round: null,
    scores: {},
    players: {}
  };
  lobbies.set(lobbyId, lobby);
  return lobby;
}

function startRound(lobby) {
  const pokemon = randomPokemon();
  const startedAtMs = now();
  const endsAtMs = startedAtMs + ROUND_SECONDS * 1000;

  lobby.round = { pokemon, startedAtMs, endsAtMs, active: true };

  // Tell everyone round started (but only admin gets the answer)
  io.to(lobby.lobbyId).emit("round_started", {
    startedAtMs,
    endsAtMs
  });

  if (lobby.adminSocketId) {
    io.to(lobby.adminSocketId).emit("admin_answer", { pokemon });
  }

  // Clear canvas for everyone
  io.to(lobby.lobbyId).emit("canvas_clear");

  // End round timer
  setTimeout(() => {
    const freshLobby = getLobby(lobby.lobbyId);
    if (!freshLobby?.round?.active) return;
    endRound(freshLobby, { reason: "time" });
  }, ROUND_SECONDS * 1000 + 50);
}

function endRound(lobby, { reason, winnerPlayerId } = {}) {
  if (!lobby.round?.active) return;

  const pokemon = lobby.round.pokemon;
  lobby.round.active = false;

  io.to(lobby.lobbyId).emit("round_ended", {
    reason: reason || "unknown",
    pokemon,
    winnerPlayerId: winnerPlayerId || null
  });
}

function awardPoints(lobby, playerId) {
  // Points based on remaining time: faster guess => more points
  const t = now();
  const remainingMs = Math.max(0, (lobby.round?.endsAtMs || t) - t);
  const remainingSec = remainingMs / 1000;

  // Example scoring: 100 max down to 10 min
  const points = Math.max(10, Math.ceil((remainingSec / ROUND_SECONDS) * 100));
  lobby.scores[playerId] = (lobby.scores[playerId] || 0) + points;

  return points;
}

io.on("connection", (socket) => {
  // Client -> join lobby
  socket.on("join_lobby", ({ lobbyId, name, playerId }) => {
    lobbyId = String(lobbyId || "").trim().toUpperCase();

    let lobby = getLobby(lobbyId);
    if (!lobby) {
      // For MVP: auto-create if not exist
      lobby = createLobby();
      // If user typed a non-existing lobby, keep their typed id? We won't; we return actual id.
      // Better UX: create lobby only via "create_lobby" event.
    }

    const cleanName = sanitizeName(name);
    const cleanPlayerId = String(playerId || socket.id).slice(0, 40);

    socket.join(lobby.lobbyId);
    lobby.players[socket.id] = { name: cleanName, playerId: cleanPlayerId };
    lobby.scores[cleanPlayerId] = lobby.scores[cleanPlayerId] || 0;

    socket.emit("lobby_joined", lobbySnapshot(lobby));
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Create a brand new lobby (preferred)
  socket.on("create_lobby", ({ name, playerId }) => {
    const lobby = createLobby();

    const cleanName = sanitizeName(name);
    const cleanPlayerId = String(playerId || socket.id).slice(0, 40);

    socket.join(lobby.lobbyId);
    lobby.players[socket.id] = { name: cleanName, playerId: cleanPlayerId };
    lobby.scores[cleanPlayerId] = 0;

    socket.emit("lobby_created", lobbySnapshot(lobby));
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Become admin (host)
  socket.on("claim_admin", ({ lobbyId, adminKey }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return socket.emit("error_msg", { message: "Lobby not found." });
    if (adminKey !== ADMIN_KEY) return socket.emit("error_msg", { message: "Bad admin key." });

    lobby.adminSocketId = socket.id;
    socket.emit("admin_claimed", { ok: true });
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));

    // If a round is active, send answer
    if (lobby.round?.active) {
      socket.emit("admin_answer", { pokemon: lobby.round.pokemon });
    }
  });

  // Admin starts a round
  socket.on("start_round", ({ lobbyId }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;
    if (lobby.adminSocketId !== socket.id) return;
    if (lobby.round?.active) return;

    startRound(lobby);
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Admin drawing events broadcast to lobby
  socket.on("draw_stroke", ({ lobbyId, stroke }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;
    if (lobby.adminSocketId !== socket.id) return; // only admin can draw
    if (!lobby.round?.active) return;

    // stroke: {x0,y0,x1,y1,color,width}
    socket.to(lobby.lobbyId).emit("draw_stroke", { stroke });
  });

  socket.on("clear_canvas", ({ lobbyId }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;
    if (lobby.adminSocketId !== socket.id) return;
    io.to(lobby.lobbyId).emit("canvas_clear");
  });

  // Guess submission
  socket.on("submit_guess", ({ lobbyId, guess }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;

    const p = lobby.players[socket.id];
    if (!p) return;

    const cleanGuess = String(guess || "").trim().toLowerCase().slice(0, 40);
    if (!cleanGuess) return;

    // Broadcast guess to chat
    io.to(lobby.lobbyId).emit("chat_msg", {
      name: p.name,
      message: cleanGuess
    });

    if (!lobby.round?.active) return;

    const answer = lobby.round.pokemon.toLowerCase();
    if (cleanGuess === answer) {
      const points = awardPoints(lobby, p.playerId);

      io.to(lobby.lobbyId).emit("correct_guess", {
        playerId: p.playerId,
        name: p.name,
        points
      });

      endRound(lobby, { reason: "guessed", winnerPlayerId: p.playerId });
      io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
    }
  });

  socket.on("disconnect", () => {
    // Remove player from any lobby they were in
    for (const lobby of lobbies.values()) {
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];

        if (lobby.adminSocketId === socket.id) {
          lobby.adminSocketId = null;
          // Optionally end round if admin leaves:
          if (lobby.round?.active) endRound(lobby, { reason: "admin_left" });
        }

        io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`PokeDraw server running on port ${PORT}`);
});
