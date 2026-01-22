import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// ===== Config =====
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

// 2 minutes by default
const ROUND_SECONDS = parseInt(process.env.ROUND_SECONDS || "120", 10);

// Large Pokémon list: replaced at startup via PokéAPI if available
let POKEMON = [
  "pikachu", "bulbasaur", "charmander", "squirtle", "gengar",
  "eevee", "snorlax", "psyduck", "jigglypuff", "mewtwo"
];

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) =>
  res.json({ ok: true, roundSeconds: ROUND_SECONDS, pokemonCount: POKEMON.length })
);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

// ===== In-memory state (MVP) =====
/**
 * lobbies[lobbyId] = {
 *   lobbyId,
 *   adminSocketId,
 *   round: { pokemon, startedAtMs, endsAtMs, active },
 *   roundTimer: Timeout | null,
 *   scores: { [playerId]: number },
 *   players: { [socketId]: { name, playerId } }
 * }
 */
const lobbies = new Map();

function now() {
  return Date.now();
}

function sanitizeName(name) {
  const n = String(name || "").trim().slice(0, 18);
  return n || "Player";
}

function getLobby(lobbyId) {
  return lobbies.get(lobbyId);
}

function createLobby(lobbyIdOverride) {
  const lobbyId = String(lobbyIdOverride || Math.random().toString(36).slice(2, 8))
    .trim()
    .toUpperCase();

  const lobby = {
    lobbyId,
    adminSocketId: null,
    round: null,
    roundTimer: null,
    scores: {},
    players: {}
  };

  lobbies.set(lobbyId, lobby);
  return lobby;
}

function lobbySnapshot(lobby) {
  return {
    lobbyId: lobby.lobbyId,
    hasAdmin: Boolean(lobby.adminSocketId),
    round: lobby.round
      ? { active: lobby.round.active, startedAtMs: lobby.round.startedAtMs, endsAtMs: lobby.round.endsAtMs }
      : { active: false },
    players: Object.values(lobby.players).map(p => ({
      name: p.name,
      playerId: p.playerId,
      score: lobby.scores[p.playerId] || 0
    }))
  };
}

function randomPokemon() {
  return POKEMON[Math.floor(Math.random() * POKEMON.length)];
}

// Normalize guesses/answers (kept for robustness; answers will now be simple alnum)
function normalizePokemonName(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "");
}

function clearLobbyTimer(lobby) {
  if (lobby.roundTimer) {
    clearTimeout(lobby.roundTimer);
    lobby.roundTimer = null;
  }
}

function scheduleRoundEnd(lobby) {
  clearLobbyTimer(lobby);

  const t = now();
  const endsAt = lobby.round?.endsAtMs || t;
  const delay = Math.max(0, endsAt - t) + 50;

  lobby.roundTimer = setTimeout(() => {
    const freshLobby = getLobby(lobby.lobbyId);
    if (!freshLobby?.round?.active) return;
    endRound(freshLobby, { reason: "time" });
  }, delay);
}

function startRound(lobby) {
  const pokemon = randomPokemon();
  const startedAtMs = now();
  const endsAtMs = startedAtMs + ROUND_SECONDS * 1000;

  lobby.round = { pokemon, startedAtMs, endsAtMs, active: true };

  io.to(lobby.lobbyId).emit("round_started", { startedAtMs, endsAtMs });

  if (lobby.adminSocketId) {
    io.to(lobby.adminSocketId).emit("admin_answer", { pokemon });
  }

  io.to(lobby.lobbyId).emit("canvas_clear");

  scheduleRoundEnd(lobby);
}

function endRound(lobby, { reason, winnerPlayerId } = {}) {
  if (!lobby.round?.active) return;

  clearLobbyTimer(lobby);

  const pokemon = lobby.round.pokemon;
  lobby.round.active = false;

  io.to(lobby.lobbyId).emit("round_ended", {
    reason: reason || "unknown",
    pokemon,
    winnerPlayerId: winnerPlayerId || null
  });
}

function awardPoints(lobby, playerId) {
  const t = now();
  const remainingMs = Math.max(0, (lobby.round?.endsAtMs || t) - t);
  const remainingSec = remainingMs / 1000;

  const points = Math.max(10, Math.ceil((remainingSec / ROUND_SECONDS) * 100));
  lobby.scores[playerId] = (lobby.scores[playerId] || 0) + points;
  return points;
}

// ✅ Keep only "simple" Pokémon names: letters/numbers only, no dashes, no punctuation, no spaces.
// This also removes most special forms (because PokéAPI forms are almost always hyphenated).
function isSimplePokemonName(name) {
  // Examples kept: pikachu, charizard, porygon2
  // Examples removed: mr-mime, ho-oh, deoxys-normal, rotom-wash, etc.
  return /^[a-z0-9]+$/.test(name);
}

// Load big Pokémon list from PokéAPI at startup (filtered to simple names)
async function loadPokemonList() {
  try {
    const res = await fetch("https://pokeapi.co/api/v2/pokemon?limit=10000");
    if (!res.ok) throw new Error(`PokéAPI HTTP ${res.status}`);
    const data = await res.json();

    const names = (data.results || [])
      .map(r => String(r.name || "").toLowerCase().trim())
      .filter(Boolean)
      .filter(isSimplePokemonName);

    // De-dupe just in case
    const unique = Array.from(new Set(names));

    if (unique.length >= 700) {
      POKEMON = unique;
      console.log(`Loaded ${POKEMON.length} simple Pokémon names (no dashes/forms)`);
    } else {
      console.log(`Filtered list too small (${unique.length}); keeping fallback list`);
    }
  } catch (e) {
    console.log("Failed to load PokéAPI list; using fallback list. Error:", e.message);
  }
}

io.on("connection", (socket) => {
  // Create lobby with random code (still supported)
  socket.on("create_lobby", ({ name, playerId }) => {
    const lobby = createLobby();

    const cleanName = sanitizeName(name);
    const cleanPlayerId = String(playerId || socket.id).slice(0, 40);

    socket.join(lobby.lobbyId);
    lobby.players[socket.id] = { name: cleanName, playerId: cleanPlayerId };
    lobby.scores[cleanPlayerId] = lobby.scores[cleanPlayerId] || 0;

    socket.emit("lobby_created", lobbySnapshot(lobby));
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Anyone can create a lobby by entering a code and joining
  socket.on("join_lobby", ({ lobbyId, name, playerId }) => {
    lobbyId = String(lobbyId || "").trim().toUpperCase();
    if (!lobbyId) return socket.emit("error_msg", { message: "Missing lobby code." });

    let lobby = getLobby(lobbyId);
    const createdNow = !lobby;

    if (!lobby) lobby = createLobby(lobbyId);

    const cleanName = sanitizeName(name);
    const cleanPlayerId = String(playerId || socket.id).slice(0, 40);

    socket.join(lobby.lobbyId);
    lobby.players[socket.id] = { name: cleanName, playerId: cleanPlayerId };
    lobby.scores[cleanPlayerId] = lobby.scores[cleanPlayerId] || 0;

    if (createdNow) socket.emit("lobby_created", lobbySnapshot(lobby));
    else socket.emit("lobby_joined", lobbySnapshot(lobby));

    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Claim admin (host)
  socket.on("claim_admin", ({ lobbyId, adminKey }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return socket.emit("error_msg", { message: "Lobby not found." });
    if (adminKey !== ADMIN_KEY) return socket.emit("error_msg", { message: "Bad admin key." });

    lobby.adminSocketId = socket.id;

    socket.emit("admin_claimed", { ok: true });
    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));

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

  // Admin rerolls Pokémon anytime (optionally resets timer)
  socket.on("reroll_pokemon", ({ lobbyId, resetTimer }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;
    if (lobby.adminSocketId !== socket.id) return;
    if (!lobby.round?.active) return;

    lobby.round.pokemon = randomPokemon();

    const doResetTimer = resetTimer !== false;
    if (doResetTimer) {
      const startedAtMs = now();
      lobby.round.startedAtMs = startedAtMs;
      lobby.round.endsAtMs = startedAtMs + ROUND_SECONDS * 1000;
      scheduleRoundEnd(lobby);
    }

    io.to(lobby.lobbyId).emit("canvas_clear");
    io.to(lobby.lobbyId).emit("round_started", {
      startedAtMs: lobby.round.startedAtMs,
      endsAtMs: lobby.round.endsAtMs
    });

    io.to(lobby.adminSocketId).emit("admin_answer", { pokemon: lobby.round.pokemon });

    io.to(lobby.lobbyId).emit("chat_msg", {
      name: "SYSTEM",
      message: "Host rerolled the Pokémon!"
    });

    io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
  });

  // Admin drawing events broadcast to lobby
  socket.on("draw_stroke", ({ lobbyId, stroke }) => {
    const lobby = getLobby(String(lobbyId || "").trim().toUpperCase());
    if (!lobby) return;
    if (lobby.adminSocketId !== socket.id) return;
    if (!lobby.round?.active) return;

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

    const rawGuess = String(guess || "").trim().slice(0, 60);
    const cleanGuessChat = rawGuess.toLowerCase();
    if (!cleanGuessChat) return;

    io.to(lobby.lobbyId).emit("chat_msg", { name: p.name, message: cleanGuessChat });

    if (!lobby.round?.active) return;

    const answerNorm = normalizePokemonName(lobby.round.pokemon);
    const guessNorm = normalizePokemonName(rawGuess);

    if (guessNorm && guessNorm === answerNorm) {
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
    for (const lobby of lobbies.values()) {
      if (lobby.players[socket.id]) {
        delete lobby.players[socket.id];

        if (lobby.adminSocketId === socket.id) {
          lobby.adminSocketId = null;
          if (lobby.round?.active) endRound(lobby, { reason: "admin_left" });
        }

        io.to(lobby.lobbyId).emit("lobby_update", lobbySnapshot(lobby));
      }
    }
  });
});

// Startup
await loadPokemonList();

server.listen(PORT, () => {
  console.log(`PokeDraw server running on port ${PORT}`);
  console.log(`Round length: ${ROUND_SECONDS}s`);
  console.log(`Pokémon loaded (simple names only): ${POKEMON.length}`);
});
