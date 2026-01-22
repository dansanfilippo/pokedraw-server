<div id="pokedraw-root" style="max-width:1000px;margin:0 auto;padding:16px;">
  <h1>PokéDraw Live</h1>

  <div style="display:flex;gap:16px;flex-wrap:wrap;">
    <div style="flex: 1 1 520px;">
      <canvas id="pd-canvas" width="800" height="500" style="width:100%;border:1px solid #ddd;border-radius:8px;"></canvas>

      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center;">
        <button id="pd-clear" type="button">Clear</button>
        <button id="pd-fill" type="button">Fill</button>

        <button id="pd-start" type="button">Start Round</button>
        <button id="pd-reroll" type="button">New Pokémon</button>

        <label style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:14px;">Color</span>
          <input id="pd-color" type="color" value="#111111" />
        </label>

        <label style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:14px;">Brush</span>
          <input id="pd-brush" type="range" min="2" max="30" value="6" />
          <span id="pd-brush-val" style="font-size:14px;min-width:18px;display:inline-block;">6</span>
        </label>

        <button id="pd-eraser" type="button">Eraser: Off</button>
        <button id="pd-claim-admin" type="button">Claim Host</button>
      </div>

      <p id="pd-status" style="margin-top:8px;opacity:.85;"></p>
      <p id="pd-token-status" style="margin-top:6px;opacity:.85;"></p>
      <p id="pd-answer" style="margin-top:8px;font-weight:bold;"></p>
    </div>

    <div style="flex: 1 1 320px;">
      <div style="border:1px solid #ddd;border-radius:8px;padding:12px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button id="pd-create" type="button">Create Lobby</button>
          <input id="pd-lobby" placeholder="Lobby Code" style="flex:1;min-width:140px;" />
          <button id="pd-join" type="button">Join / Create</button>
        </div>

        <div style="margin-top:10px;">
          <input id="pd-name" placeholder="Your name" style="width:100%;" />
        </div>

        <h3 style="margin:12px 0 6px;">Chat / Guesses</h3>
        <div id="pd-chat" style="height:220px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px;background:#fafafa;"></div>

        <div style="display:flex;gap:8px;margin-top:8px;">
          <input id="pd-guess" placeholder="Type your guess…" style="flex:1;" />
          <button id="pd-send" type="button">Send</button>
        </div>

        <h3 style="margin:12px 0 6px;">Scoreboard</h3>
        <div id="pd-scores"></div>
      </div>
    </div>
  </div>
</div>

<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
(function(){
  // ====== IMPORTANT: set this to your deployed server URL ======
  const SERVER_URL = "https://YOUR-GAME-SERVER.com"; // <-- replace

  function onReady(fn){
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function makeToken(){
    return (
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2) +
      Date.now().toString(36)
    );
  }

  function tokenKeyForLobby(lobbyId){
    return "pokedraw_host_token_" + String(lobbyId || "").toUpperCase();
  }

  onReady(function(){
    const $ = (id) => document.getElementById(id);

    const statusEl = $("pd-status");
    const tokenStatusEl = $("pd-token-status");
    const answerEl = $("pd-answer");
    const chatEl = $("pd-chat");
    const scoresEl = $("pd-scores");
    const canvas = $("pd-canvas");
    const ctx = canvas ? canvas.getContext("2d") : null;

    function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }

    function setTokenStatus(lobbyId, isAdmin){
      if (!tokenStatusEl) return;
      if (!lobbyId) {
        tokenStatusEl.textContent = "";
        return;
      }
      const t = localStorage.getItem(tokenKeyForLobby(lobbyId));
      const has = Boolean(t);
      tokenStatusEl.textContent =
        `Host token on this device: ${has ? "YES" : "NO"} • You are host: ${isAdmin ? "YES" : "NO"}`;
    }

    function addChat(line){
      if (!chatEl) return;
      const div = document.createElement("div");
      div.textContent = line;
      chatEl.appendChild(div);
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>"']/g, m => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
      }[m]));
    }

    function renderScores(players){
      if (!scoresEl) return;
      const sorted = [...(players || [])].sort((a,b)=> (b.score||0) - (a.score||0));
      scoresEl.innerHTML = sorted.map(p =>
        `<div style="display:flex;justify-content:space-between;gap:12px;">
          <span>${escapeHtml(p.name || "Player")}</span><strong>${p.score || 0}</strong>
        </div>`
      ).join("") || "<em>No players yet</em>";
    }

    function applyLobbySnapshot(snap){
      if (!snap) return;
      const lobbyInput = $("pd-lobby");
      if (lobbyInput) lobbyInput.value = snap.lobbyId || "";
      renderScores(snap.players || []);
      setStatus(`Lobby: ${snap.lobbyId} • Host: ${snap.hasAdmin ? "yes" : "no"} • Round: ${snap.round?.active ? "active" : "idle"}`);
    }

    if (!window.io) { setStatus("Error: Socket.IO library failed to load."); return; }
    if (!SERVER_URL || SERVER_URL.includes("YOUR-GAME-SERVER")) {
      setStatus("Error: You must set SERVER_URL in the page code (replace YOUR-GAME-SERVER).");
      addChat("⚠️ The host has not configured SERVER_URL yet.");
      return;
    }
    if (!canvas || !ctx) { setStatus("Error: Canvas not found on page."); return; }

    // Persistent player id
    const storageKey = "pokedraw_player_id";
    let playerId = localStorage.getItem(storageKey);
    if (!playerId) {
      playerId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(storageKey, playerId);
    }

    let lobbyId = null;
    let isAdmin = false;

    // Brush settings
    let brushColor = "#111111";
    let eraserOn = false;
    let brushWidth = 6;

    // Drawing state
    let drawing = false;
    let last = null;

    // IMPORTANT: token only gets stored if you actually created the lobby (or created via join),
    // or if you already had it from before.
    let pendingHostToken = null;
    let pendingHostTokenLobbyId = null;

    function getCanvasPos(e) {
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (canvas.height / rect.height);
      return {x,y};
    }

    function drawStrokeLocal(stroke) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = stroke.width || brushWidth;

      if (stroke.mode === "erase") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = stroke.color || "#111";
      }

      ctx.beginPath();
      ctx.moveTo(stroke.x0, stroke.y0);
      ctx.lineTo(stroke.x1, stroke.y1);
      ctx.stroke();
      ctx.restore();
    }

    function fillCanvasLocal(color){
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    function saveHostToken(lobbyId, token){
      localStorage.setItem(tokenKeyForLobby(lobbyId), token);
      setTokenStatus(lobbyId, isAdmin);
    }

    function getHostToken(lobbyId){
      return localStorage.getItem(tokenKeyForLobby(lobbyId));
    }

    const socket = io(SERVER_URL, { transports: ["websocket"] });

    socket.on("connect", () => setStatus("Connected. Create or join a lobby."));
    socket.on("connect_error", (err) => {
      setStatus("Connection error. Check SERVER_URL and server CORS/HTTPS.");
      addChat("⚠️ Connection error: " + (err && err.message ? err.message : "unknown"));
    });

    // ===== Controls =====
    $("pd-color")?.addEventListener("input", (e) => {
      brushColor = e.target.value;
    });

    const brushSlider = $("pd-brush");
    const brushVal = $("pd-brush-val");
    if (brushSlider) {
      brushSlider.addEventListener("input", (e) => {
        brushWidth = parseInt(e.target.value, 10) || 6;
        if (brushVal) brushVal.textContent = String(brushWidth);
      });
    }

    $("pd-eraser")?.addEventListener("click", () => {
      eraserOn = !eraserOn;
      $("pd-eraser").textContent = `Eraser: ${eraserOn ? "On" : "Off"}`;
    });

    // Create random lobby: generate token, send it, save it once lobby_created returns
    $("pd-create")?.addEventListener("click", () => {
      const name = ($("pd-name")?.value || "Player").trim();
      pendingHostToken = makeToken();
      pendingHostTokenLobbyId = null;
      socket.emit("create_lobby", { name, playerId, hostToken: pendingHostToken });
    });

    // Join / Create with code:
    // - If you already have a token for that lobby, send it (so you can auto-reclaim if host disconnected)
    // - If you do NOT have a token, generate one *but do not save it unless the lobby is created now*
    $("pd-join")?.addEventListener("click", () => {
      const name = ($("pd-name")?.value || "Player").trim();
      const code = ($("pd-lobby")?.value || "").trim().toUpperCase();
      if (!code) return alert("Enter lobby code");
      lobbyId = code;

      const existing = getHostToken(code);
      if (existing) {
        pendingHostToken = null;
        pendingHostTokenLobbyId = null;
        socket.emit("join_lobby", { lobbyId: code, name, playerId, hostToken: existing });
      } else {
        // might create this lobby, so generate token but only save if lobby_created comes back
        pendingHostToken = makeToken();
        pendingHostTokenLobbyId = code;
        socket.emit("join_lobby", { lobbyId: code, name, playerId, hostToken: pendingHostToken });
      }
    });

    $("pd-claim-admin")?.addEventListener("click", () => {
      if (!lobbyId) return alert("Join a lobby first");

      const token = getHostToken(lobbyId);
      if (!token) {
        addChat("⚠️ No host token saved on this device for this lobby.");
        addChat("Only the device/browser that created the lobby can reclaim host.");
        setTokenStatus(lobbyId, isAdmin);
        return;
      }

      socket.emit("claim_admin", { lobbyId, hostToken: token });
    });

    $("pd-start")?.addEventListener("click", () => {
      if (!lobbyId) return alert("Join a lobby first");
      socket.emit("start_round", { lobbyId });
    });

    $("pd-reroll")?.addEventListener("click", () => {
      if (!lobbyId) return alert("Join a lobby first");
      if (!isAdmin) return;
      socket.emit("reroll_pokemon", { lobbyId, resetTimer: true });
    });

    $("pd-clear")?.addEventListener("click", () => {
      if (!lobbyId) return;
      if (isAdmin) socket.emit("clear_canvas", { lobbyId });
    });

    // Fill tool (admin only): fill locally + broadcast
    $("pd-fill")?.addEventListener("click", () => {
      if (!lobbyId) return;
      if (!isAdmin) return;
      // Fill with current color (eraser doesn't apply)
      fillCanvasLocal(brushColor);
      socket.emit("fill_canvas", { lobbyId, color: brushColor });
    });

    function sendGuess(){
      if (!lobbyId) return alert("Join a lobby first");
      const guessInput = $("pd-guess");
      const g = guessInput ? guessInput.value : "";
      if (guessInput) guessInput.value = "";
      socket.emit("submit_guess", { lobbyId, guess: g });
    }

    $("pd-send")?.addEventListener("click", sendGuess);
    $("pd-guess")?.addEventListener("keydown", (e)=>{ if (e.key === "Enter") sendGuess(); });

    // ===== Drawing (admin only) =====
    canvas.addEventListener("pointerdown", (e) => {
      if (!isAdmin || !lobbyId) return;
      drawing = true;
      last = getCanvasPos(e);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drawing || !isAdmin || !lobbyId) return;
      const cur = getCanvasPos(e);

      const stroke = {
        x0:last.x, y0:last.y, x1:cur.x, y1:cur.y,
        color: brushColor,
        width: brushWidth,
        mode: eraserOn ? "erase" : "draw"
      };

      drawStrokeLocal(stroke);
      socket.emit("draw_stroke", { lobbyId, stroke });
      last = cur;
    });

    window.addEventListener("pointerup", ()=>{ drawing = false; last = null; });

    // ===== Events =====
    function resetClientStateOnLobbyEnter(snap, label){
      if (answerEl) answerEl.textContent = "";
      if (chatEl) chatEl.innerHTML = "";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyLobbySnapshot(snap);
      addChat(label);
      setTokenStatus(snap.lobbyId, isAdmin);
    }

    socket.on("lobby_created", (snap) => {
      lobbyId = snap.lobbyId;

      // If this was a random-code create, store pending token under that new lobbyId
      if (pendingHostToken && !pendingHostTokenLobbyId) {
        saveHostToken(lobbyId, pendingHostToken);
      }

      // If this was join-create (you typed a code), store token under that code ONLY if lobby was created now
      if (pendingHostToken && pendingHostTokenLobbyId && pendingHostTokenLobbyId === lobbyId) {
        saveHostToken(lobbyId, pendingHostToken);
      }

      pendingHostToken = null;
      pendingHostTokenLobbyId = null;

      isAdmin = false; // will flip true if admin_claimed arrives
      resetClientStateOnLobbyEnter(snap, `Created lobby ${snap.lobbyId}`);
    });

    socket.on("lobby_joined", (snap) => {
      lobbyId = snap.lobbyId;
      pendingHostToken = null;
      pendingHostTokenLobbyId = null;

      isAdmin = false;
      resetClientStateOnLobbyEnter(snap, `Joined lobby ${snap.lobbyId}`);
    });

    socket.on("lobby_update", (snap) => {
      applyLobbySnapshot(snap);
      if (snap?.lobbyId) setTokenStatus(snap.lobbyId, isAdmin);
    });

    socket.on("admin_claimed", () => {
      isAdmin = true;
      addChat("You are now the host.");
      setTokenStatus(lobbyId, isAdmin);
    });

    socket.on("admin_answer", ({ pokemon }) => {
      if (isAdmin && answerEl) answerEl.textContent = `Draw this: ${String(pokemon).toUpperCase()}`;
    });

    socket.on("round_started", () => addChat("Round started! Guess the Pokémon!"));

    socket.on("round_ended", ({ reason, pokemon }) => {
      addChat(`Round ended (${reason}). Answer: ${String(pokemon).toUpperCase()}`);
      if (!isAdmin && answerEl) answerEl.textContent = "";
      setTokenStatus(lobbyId, isAdmin);
    });

    socket.on("chat_msg", ({ name, message }) => addChat(`${name}: ${message}`));

    socket.on("correct_guess", ({ name, points }) => addChat(`✅ ${name} guessed it! +${points} points`));

    socket.on("canvas_clear", () => ctx.clearRect(0, 0, canvas.width, canvas.height));

    // ✅ NEW: fill sync
    socket.on("canvas_fill", ({ color }) => {
      if (typeof color === "string") fillCanvasLocal(color);
    });

    socket.on("draw_stroke", ({ stroke }) => drawStrokeLocal(stroke));

    socket.on("error_msg", ({ message }) => addChat(`⚠️ ${message}`));

    setStatus("Connecting…");
    setTokenStatus(lobbyId, isAdmin);
  });
})();
</script>
