
"use strict";

const TOURNAMENT_ID = "SZ9uqXw7";
const TOURNAMENT_URL =
  `https://lichess.org/tournament/${TOURNAMENT_ID}`;

const RESULTS_API =
  `https://lichess.org/api/tournament/${TOURNAMENT_ID}/results?nb=100`;

const GAMES_API =
  `https://lichess.org/api/tournament/${TOURNAMENT_ID}/games?nb=100`;

const REFRESH_MS = 60_000;
const RATE_LIMIT_WAIT_MS = 60_000;

const gameList = document.querySelector(".game-list");
const board = document.querySelector("#chessboard");
const statusElement = document.querySelector(".broadcast-status");
const countElement = document.querySelector("#game-count");
const detailsElement = document.querySelector("#game-details");

let refreshing = false;
let selectedGameId = null;
let refreshTimer = null;
let lastGames = [];
let lastRanks = new Map();

function setStatus(text) {
  if (statusElement) statusElement.textContent = text;
}

function setMessage(text) {
  if (countElement) countElement.textContent = text;
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function escapeText(value) {
  return String(value || "").trim();
}

async function fetchText(url, accept) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: accept }
  });

  if (response.status === 429) {
    const error = new Error("RATE_LIMIT");
    throw error;
  }

  if (!response.ok) {
    throw new Error(`Lichess returned HTTP ${response.status}`);
  }

  return response.text();
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseJsonResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const data = JSON.parse(trimmed);

    if (Array.isArray(data)) return data;
    if (Array.isArray(data.users)) return data.users;
    if (Array.isArray(data.results)) return data.results;

    return [];
  } catch {
    return parseJsonLines(trimmed);
  }
}

function parsePgn(text) {
  const games = [];
  const blocks = text
    .replace(/\r/g, "")
    .split(/(?=^\[Event\s)/m)
    .map(block => block.trim())
    .filter(block => block.startsWith("["));

  for (const block of blocks) {
    const headers = {};

    for (const match of block.matchAll(
      /^\[([A-Za-z0-9_]+)\s+"(.*)"\]\s*$/gm
    )) {
      headers[match[1]] = match[2];
    }

    const site = headers.Site || "";
    const idMatch = site.match(
      /lichess\.org\/(?:embed\/)?([a-zA-Z0-9]{8})/i
    );

    const white = escapeText(headers.White) || "White";
    const black = escapeText(headers.Black) || "Black";
    const result = headers.Result || "*";

    games.push({
      id: idMatch ? idMatch[1] : null,
      white,
      black,
      result,
      date: headers.UTCDate || headers.Date || "",
      event: headers.Event || "Lichess tournament",
      rated: headers.Rated || "",
      source: "pgn"
    });
  }

  return games;
}

function normalizeJsonGames(entries) {
  return entries
    .filter(entry => entry && typeof entry === "object")
    .map(entry => {
      const players = entry.players || {};
      const white = players.white || {};
      const black = players.black || {};

      const playerName = player =>
        player.user?.name ||
        player.user?.id ||
        player.name ||
        "Unknown player";

      return {
        id: entry.id || null,
        white: playerName(white),
        black: playerName(black),
        result: entry.winner === "white"
          ? "1-0"
          : entry.winner === "black"
            ? "0-1"
            : entry.status === "draw"
              ? "½-½"
              : entry.status || "*",
        date: "",
        event: "Lichess tournament",
        source: "json"
      };
    });
}

function parseGamesResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try JSON / NDJSON first.
  const jsonGames = parseJsonResponse(trimmed);
  const normalized = normalizeJsonGames(jsonGames);

  if (normalized.length) return normalized;

  // Otherwise, treat the response as PGN.
  return parsePgn(trimmed);
}

async function loadRanks() {
  const text = await fetchText(
    RESULTS_API,
    "application/x-ndjson, application/json"
  );

  const entries = parseJsonResponse(text);
  const ranks = new Map();

  entries.forEach(entry => {
    const name = normalizeName(
      entry.username ||
      entry.user?.name ||
      entry.user?.id ||
      entry.name
    );

    const rank = Number(entry.rank);

    if (name && Number.isFinite(rank) && rank > 0) {
      ranks.set(name, rank);
    }
  });

  return ranks;
}

async function loadGames() {
  const text = await fetchText(
    GAMES_API,
    "application/x-chess-pgn, application/x-ndjson, application/json"
  );

  return parseGamesResponse(text);
}

function getBestRank(game) {
  const whiteRank =
    lastRanks.get(normalizeName(game.white)) ?? Infinity;
  const blackRank =
    lastRanks.get(normalizeName(game.black)) ?? Infinity;

  return Math.min(whiteRank, blackRank);
}

function showGame(game) {
  if (!board || !game) return;

  selectedGameId = game.id || null;
  board.replaceChildren();

  if (!game.id) {
    const note = document.createElement("p");
    note.className = "broadcast-note";
    note.style.padding = "20px";
    note.textContent =
      "Lichess did not provide a game ID for this entry. Open the tournament to view available games.";
    board.appendChild(note);

    if (detailsElement) {
      detailsElement.textContent =
        `${game.white} vs ${game.black} · ${game.result}`;
    }

    return;
  }

  const iframe = document.createElement("iframe");
  iframe.src =
    `https://lichess.org/embed/${encodeURIComponent(game.id)}?theme=dark&bg=dark`;
  iframe.title = `${game.white} vs ${game.black}`;
  iframe.loading = "lazy";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";

  board.appendChild(iframe);

  if (detailsElement) {
    detailsElement.textContent =
      `${game.white} vs ${game.black} · Result: ${game.result}`;
  }
}

function renderGames(games) {
  if (!gameList) return;

  gameList.replaceChildren();

  if (countElement) {
    countElement.textContent =
      `${games.length} game(s) returned by Lichess`;
  }

  if (!games.length) {
    const note = document.createElement("p");
    note.className = "broadcast-note";
    note.textContent =
      "No games were returned. The tournament may not have any published games yet, or Lichess may not expose them through this endpoint.";
    gameList.appendChild(note);

    if (board) {
      board.replaceChildren();
      const boardNote = document.createElement("p");
      boardNote.className = "broadcast-note";
      boardNote.style.padding = "20px";
      boardNote.textContent =
        "No game available to display yet. Check the tournament on Lichess.";
      board.appendChild(boardNote);
    }

    if (detailsElement) {
      detailsElement.textContent = "Waiting for an available game.";
    }

    selectedGameId = null;
    return;
  }

  const sorted = [...games].sort((a, b) => {
    return getBestRank(a) - getBestRank(b);
  });

  sorted.forEach((game, index) => {
    const link = document.createElement("a");
    link.className = "game-item";
    link.href = game.id
      ? `https://lichess.org/${encodeURIComponent(game.id)}`
      : TOURNAMENT_URL;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const title = document.createElement("strong");
    title.textContent = `${game.white} vs ${game.black}`;

    const result = document.createElement("p");
    result.textContent = `Result: ${game.result}`;

    const rank = getBestRank(game);
    if (Number.isFinite(rank)) {
      result.textContent += ` · Best tournament rank: #${rank}`;
    }

    if (index === 0) {
      const featured = document.createElement("p");
      featured.className = "featured-label";
      featured.textContent = "★ Suggested game";
      link.append(title, featured, result);
    } else {
      link.append(title, result);
    }

    link.addEventListener("click", event => {
      if (!game.id) return;
      event.preventDefault();
      showGame(game);
    });

    gameList.appendChild(link);
  });

  // Keep the current selection if it still exists.
  const selected = games.find(game => game.id === selectedGameId);
  const firstWithId = games.find(game => game.id);

  if (selected) {
    showGame(selected);
  } else if (firstWithId) {
    showGame(firstWithId);
  } else {
    showGame(games[0]);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;

  try {
    setStatus("● UPDATING…");

    // Make requests sequentially to avoid sending them together.
    try {
      lastRanks = await loadRanks();
    } catch (error) {
      console.warn("Could not load tournament rankings:", error);
      lastRanks = new Map();
    }

    const games = await loadGames();
    lastGames = games;

    renderGames(lastGames);

    setStatus(
      games.length
        ? "● DATA UPDATED"
        : "● NO GAMES FOUND"
    );
  } catch (error) {
    console.error("Tournament update failed:", error);

    if (error.message === "RATE_LIMIT") {
      setStatus("● RATE LIMITED");
      setMessage("Lichess has limited requests. Retrying in 60 seconds.");
    } else {
      setStatus("● CONNECTION ERROR");
      setMessage(
        "Unable to load games from Lichess. Check your connection and the browser console."
      );
    }
  } finally {
    refreshing = false;

    if (refreshTimer) window.clearTimeout(refreshTimer);

    const delay = REFRESH_MS;
    refreshTimer = window.setTimeout(refresh, delay);
  }
}

refresh();
