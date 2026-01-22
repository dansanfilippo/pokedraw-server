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
async function loadPokemonList(
