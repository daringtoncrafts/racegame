import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const RACE_TIME = 30;
const COUNTDOWN_TIME = 3;
const INTERMISSION_TIME = 5;
const FINISH_LINE = 1000;
const TAP_BOOST = 22;
const SIM_MS = 33;
const BROADCAST_EVERY = 3;
const HOST_TIMEOUT_MS = 4000;

const LANES = [
  { color: '#e74c3c', darkText: false },
  { color: '#3498db', darkText: false },
  { color: '#2ecc71', darkText: true },
  { color: '#f1c40f', darkText: true },
];

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = sanitizeCode(params.get('room'));
const isHost = params.get('host') === '1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 40 } },
});

function sanitizeCode(value) {
  return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function joinUrl(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function channelFor(code, presenceKey) {
  return supabase.channel(`turbo-race-${code}`, {
    config: { broadcast: { self: false }, presence: { key: presenceKey } },
  });
}

/* ---------- Canvas rendering (shared by host and player) ---------- */

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTrack(canvas, view, highlightLane = -1) {
  const { ctx, w, h } = fitCanvas(canvas);
  if (!w || !h) return;
  const laneH = h / 4;
  const startX = Math.min(110, w * 0.22);
  const finishX = w - 30;
  const carW = Math.max(24, Math.min(44, laneH * 0.9));
  const carH = Math.max(14, Math.min(26, laneH * 0.5));

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 4; i++) {
    const y = i * laneH;
    ctx.fillStyle = i === highlightLane ? 'rgba(76, 209, 55, 0.12)' : i % 2 === 0 ? '#0f172a' : '#152036';
    ctx.fillRect(0, y, w, laneH);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    ctx.setLineDash([10, 12]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    ctx.moveTo(startX, y + laneH / 2);
    ctx.lineTo(finishX, y + laneH / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const racer = view.racers[i];
    ctx.fillStyle = racer ? LANES[i].color : '#475569';
    ctx.font = `700 ${Math.max(10, Math.min(14, laneH * 0.3))}px -apple-system, sans-serif`;
    ctx.textBaseline = 'middle';
    const label = racer ? racer.name : 'Open';
    ctx.fillText(label.length > 12 ? label.slice(0, 11) + '…' : label, 8, y + laneH / 2);
  }

  const check = Math.max(5, laneH / 6);
  for (let y = 0, row = 0; y < h; y += check, row++) {
    for (let c = 0; c < 2; c++) {
      ctx.fillStyle = (row + c) % 2 === 0 ? '#ffffff' : '#000000';
      ctx.fillRect(finishX + c * check, y, check, check);
    }
  }

  view.racers.forEach((racer, i) => {
    if (!racer) return;
    const cy = i * laneH + laneH / 2;
    const ratio = Math.min(1, racer.pos / FINISH_LINE);
    const x = startX + ratio * (finishX - startX - carW);
    ctx.fillStyle = LANES[i].color;
    roundRect(ctx, x, cy - carH / 2, carW, carH, 5);
    ctx.fill();
    ctx.strokeStyle = i === highlightLane ? '#ffffff' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth = i === highlightLane ? 2.5 : 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + carW * 0.6, cy - carH / 2 + 3, carW * 0.22, carH - 6);
  });

  let overlay = null;
  if (view.phase === 'countdown') overlay = { big: String(Math.max(1, Math.ceil(view.countdown))), small: 'Get ready' };
  else if (view.phase === 'finished' && view.winner) {
    overlay = { big: `${view.winner.name} wins!`, small: view.nextIn != null ? `Next race in ${Math.max(0, Math.ceil(view.nextIn))}` : '' };
  }
  if (overlay) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.fillStyle = view.phase === 'finished' && view.winner ? LANES[view.winner.lane].color : '#fbc531';
    ctx.font = `900 italic ${Math.min(h * 0.32, w * 0.09, 96)}px -apple-system, sans-serif`;
    ctx.fillText(overlay.big, w / 2, h / 2 - h * 0.06);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `700 ${Math.min(h * 0.09, 20)}px -apple-system, sans-serif`;
    ctx.fillText(overlay.small, w / 2, h / 2 + h * 0.18);
    ctx.textAlign = 'start';
  }
}

/* ---------- Lobby ---------- */

function startLobby() {
  $('lobby').hidden = false;
  $('host-btn').addEventListener('click', () => {
    location.search = `?room=${randomCode()}&host=1`;
  });
  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = sanitizeCode($('join-code').value);
    if (code.length >= 4) location.search = `?room=${code}`;
  });
}

/* ---------- Host (authoritative simulation) ---------- */

function startHost() {
  $('host').hidden = false;
  $('host-room').textContent = room;
  $('host-join-url').textContent = joinUrl(room);
  new window.QRCode($('qr'), { text: joinUrl(room), width: 180, height: 180, correctLevel: window.QRCode.CorrectLevel.M });

  const game = {
    phase: 'lobby',
    raceId: 0,
    countdown: 0,
    timeLeft: RACE_TIME,
    nextIn: 0,
    winner: null,
    racers: [null, null, null, null],
    waiting: 0,
  };

  const channel = channelFor(room, 'host');
  const occupied = () => game.racers.filter(Boolean).length;

  function resetRacers() {
    game.racers.forEach((r) => {
      if (!r) return;
      r.pos = 0;
      r.taps = 0;
      r.boost = 0;
    });
  }

  function beginCountdown() {
    game.raceId += 1;
    game.winner = null;
    resetRacers();
    game.countdown = COUNTDOWN_TIME;
    game.timeLeft = RACE_TIME;
    game.phase = 'countdown';
    broadcast();
  }

  function finishRace() {
    let leader = -1;
    game.racers.forEach((r, i) => {
      if (r && (leader < 0 || r.pos > game.racers[leader].pos)) leader = i;
    });
    game.winner = leader >= 0 ? { name: game.racers[leader].name, lane: leader } : null;
    game.phase = 'finished';
    game.nextIn = INTERMISSION_TIME;
    broadcast();
  }

  function simulate(dt) {
    if (game.phase === 'countdown') {
      game.countdown -= dt;
      if (game.countdown <= 0) {
        game.phase = 'racing';
        broadcast();
      }
    } else if (game.phase === 'racing') {
      game.timeLeft -= dt;
      const base = FINISH_LINE / RACE_TIME;
      let crossed = false;
      game.racers.forEach((r) => {
        if (!r) return;
        r.boost *= Math.pow(0.92, dt * 60);
        r.pos += (base + r.boost) * dt;
        if (r.pos >= FINISH_LINE) crossed = true;
      });
      if (crossed || game.timeLeft <= 0) finishRace();
      if (occupied() === 0) game.phase = 'lobby';
    } else if (game.phase === 'finished') {
      game.nextIn -= dt;
      if (game.nextIn <= 0) {
        if (occupied() > 0) beginCountdown();
        else game.phase = 'lobby';
      }
    }
  }

  function snapshot() {
    return {
      phase: game.phase,
      raceId: game.raceId,
      countdown: game.countdown,
      timeLeft: game.timeLeft,
      nextIn: game.nextIn,
      winner: game.winner,
      waiting: game.waiting,
      racers: game.racers.map((r) => (r ? { id: r.id, name: r.name, pos: Math.round(r.pos), taps: r.taps } : null)),
    };
  }

  function broadcast() {
    channel.send({ type: 'broadcast', event: 'state', payload: snapshot() });
  }

  function syncPresence() {
    const state = channel.presenceState();
    const present = new Map();
    for (const key of Object.keys(state)) {
      if (key === 'host') continue;
      const meta = state[key][0];
      present.set(key, String(meta?.name || 'Racer').slice(0, 14));
    }
    game.racers = game.racers.map((r) => (r && present.has(r.id) ? r : null));
    for (const [id, name] of present) {
      const existing = game.racers.find((r) => r && r.id === id);
      if (existing) {
        existing.name = name;
        continue;
      }
      const free = game.racers.findIndex((r) => !r);
      if (free >= 0) game.racers[free] = { id, name, pos: 0, taps: 0, boost: 0 };
    }
    game.waiting = [...present.keys()].filter((id) => !game.racers.some((r) => r && r.id === id)).length;
    renderPanel();
    broadcast();
  }

  channel
    .on('presence', { event: 'sync' }, syncPresence)
    .on('broadcast', { event: 'taps' }, ({ payload }) => {
      if (game.phase !== 'racing' || payload.raceId !== game.raceId) return;
      const racer = game.racers.find((r) => r && r.id === payload.id);
      if (!racer || typeof payload.taps !== 'number') return;
      const diff = Math.min(payload.taps - racer.taps, 40);
      if (diff > 0) {
        racer.taps += diff;
        racer.boost += diff * TAP_BOOST;
      }
    })
    .subscribe((status) => {
      const conn = $('host-conn');
      if (status === 'SUBSCRIBED') {
        conn.textContent = 'Live — players can join';
        conn.classList.add('ok');
        channel.track({ role: 'host' });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        conn.textContent = 'Connection lost — retrying…';
        conn.classList.remove('ok');
      }
    });

  $('start-btn').addEventListener('click', () => {
    if (occupied() > 0 && (game.phase === 'lobby' || game.phase === 'finished')) beginCountdown();
  });

  function renderPanel() {
    $('lane-list').innerHTML = game.racers
      .map((r, i) => {
        const name = r ? escapeHtml(r.name) : '<span class="open">Open lane</span>';
        return `<li><span class="swatch" style="background:${LANES[i].color}"></span>${name}</li>`;
      })
      .join('');
    $('host-waiting').textContent = game.waiting > 0 ? `${game.waiting} more waiting for a free lane` : '';
  }

  function renderHud() {
    const status = {
      lobby: occupied() > 0 ? `${occupied()} racer${occupied() === 1 ? '' : 's'} ready` : 'Waiting for players',
      countdown: 'Get ready',
      racing: 'Racing',
      finished: 'Race over',
    }[game.phase];
    $('host-status').textContent = status;
    $('host-timer').textContent = formatTime(game.timeLeft);
    const startBtn = $('start-btn');
    startBtn.disabled = !(occupied() > 0 && game.phase === 'lobby');
    startBtn.textContent = game.phase === 'lobby' ? 'Start race' : 'Race running';
  }

  let tick = 0;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    simulate(dt);
    if (++tick % BROADCAST_EVERY === 0 && game.phase !== 'lobby') broadcast();
    else if (tick % 30 === 0) broadcast();
  }, SIM_MS);

  const canvas = $('host-canvas');
  renderPanel();
  (function frame() {
    drawTrack(canvas, game);
    renderHud();
    requestAnimationFrame(frame);
  })();
}

/* ---------- Player (controller) ---------- */

function getPlayerId() {
  let id = sessionStorage.getItem('turbo-player-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    sessionStorage.setItem('turbo-player-id', id);
  }
  return id;
}

function startPlayer() {
  $('player').hidden = false;
  $('name-room').textContent = room;
  const nameInput = $('name-input');
  nameInput.value = localStorage.getItem('turbo-player-name') || '';
  nameInput.focus();

  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 14);
    if (!name) return;
    localStorage.setItem('turbo-player-name', name);
    $('name-form').hidden = true;
    $('controller').hidden = false;
    runController(name);
  });
}

function runController(name) {
  const myId = getPlayerId();
  $('player-room').textContent = room;
  $('player-name').textContent = name;

  const view = { phase: 'lobby', racers: [null, null, null, null], countdown: 0, timeLeft: RACE_TIME, nextIn: 0, winner: null };
  const display = [0, 0, 0, 0];
  let lastState = null;
  let lastStateAt = 0;
  let raceId = -1;
  let myTaps = 0;
  let sentTaps = 0;
  let lastSendAt = 0;

  const channel = channelFor(room, myId);
  const tapBtn = $('tap-btn');

  channel
    .on('broadcast', { event: 'state' }, ({ payload }) => {
      lastState = payload;
      lastStateAt = performance.now();
      if (payload.raceId !== raceId) {
        raceId = payload.raceId;
        myTaps = 0;
        sentTaps = 0;
        for (let i = 0; i < 4; i++) display[i] = payload.racers[i]?.pos || 0;
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') channel.track({ name });
    });

  const myLane = () => (lastState ? lastState.racers.findIndex((r) => r && r.id === myId) : -1);

  function sendTaps(force) {
    if (!lastState || lastState.phase !== 'racing') return;
    const lane = myLane();
    const hostTaps = lane >= 0 ? lastState.racers[lane].taps : 0;
    const now = performance.now();
    if (myTaps > sentTaps || (force && myTaps > hostTaps && now - lastSendAt > 400)) {
      channel.send({ type: 'broadcast', event: 'taps', payload: { id: myId, raceId, taps: myTaps } });
      sentTaps = myTaps;
      lastSendAt = now;
    }
  }
  setInterval(() => sendTaps(true), 100);

  function tap() {
    if (tapBtn.disabled) return;
    myTaps += 1;
    $('tap-count').textContent = `${myTaps} tap${myTaps === 1 ? '' : 's'}`;
    if (navigator.vibrate) navigator.vibrate(8);
    tapBtn.classList.add('pressed');
    setTimeout(() => tapBtn.classList.remove('pressed'), 70);
  }

  tapBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tap();
  });
  tapBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
      e.preventDefault();
      tap();
    }
  });

  const canvas = $('player-canvas');
  let prev = performance.now();
  (function frame(now) {
    const dt = Math.min(0.1, ((now || performance.now()) - prev) / 1000);
    prev = now || performance.now();
    const hostAlive = lastState && performance.now() - lastStateAt < HOST_TIMEOUT_MS;
    const lane = myLane();

    if (lastState) {
      view.phase = lastState.phase;
      view.countdown = lastState.countdown;
      view.timeLeft = lastState.timeLeft;
      view.nextIn = lastState.nextIn;
      view.winner = lastState.winner;
      view.racers = lastState.racers.map((r, i) => {
        if (!r) return null;
        display[i] += (r.pos - display[i]) * Math.min(1, dt * 12);
        return { ...r, pos: display[i] };
      });
    }

    let status;
    if (!hostAlive) status = lastState ? 'Host disconnected' : 'Waiting for host…';
    else if (lane < 0) status = 'Race full — spectating';
    else status = { lobby: 'Waiting for host to start', countdown: 'Get ready!', racing: 'Tap tap tap!', finished: 'Race over' }[view.phase];

    $('player-status').textContent = status;
    $('player-timer').textContent = formatTime(view.timeLeft);

    const canTap = hostAlive && lane >= 0 && view.phase === 'racing';
    tapBtn.disabled = !canTap;
    if (lane >= 0) {
      tapBtn.style.setProperty('--lane', LANES[lane].color);
      tapBtn.classList.toggle('dark-text', LANES[lane].darkText);
    }
    $('tap-label').textContent = canTap ? 'TAP!' : view.phase === 'countdown' && hostAlive ? String(Math.max(1, Math.ceil(view.countdown))) : 'WAIT';
    if (myTaps === 0) $('tap-count').textContent = lane >= 0 ? `Lane ${lane + 1}` : '0 taps';

    drawTrack(canvas, view, lane);
    requestAnimationFrame(frame);
  })();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

if (!room) startLobby();
else if (isHost) startHost();
else startPlayer();
