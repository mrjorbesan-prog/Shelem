const socket = io({ reconnectionDelayMax: 3000 });
let clientId = localStorage.getItem('shelem_clientId');
if (!clientId) { clientId = Math.random().toString(36).slice(2) + Date.now(); localStorage.setItem('shelem_clientId', clientId); }
let myName = localStorage.getItem('shelem_name') || '';

const SUIT_SYM = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const RED_SUITS = ['H', 'D'];
const RANK_LABEL = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
const RESULT_LABELS = {
  shelem: '\u0634\u0644\u0645!',
  'sarshelem-success': '\u0633\u0631\u0634\u0644\u0645!',
  'sarshelem-fail': '\u0633\u0631\u0634\u0644\u0645 \u0646\u0627\u0645\u0648\u0641\u0642',
  yasa: '\u06CC\u0627\u0633\u0627!',
  success: '\u0628\u0631\u062F \u062D\u0627\u06A9\u0645',
  fail: '\u0628\u0627\u062E\u062A \u062D\u0627\u06A9\u0645',
};

let lastState = null;
let selectedSeats = [];
let selectedKittyCards = [];
let kittyRevealKey = '';
let kittyRevealVisible = false;
let trickFeedbackTimer = null;

const $ = (id) => document.getElementById(id);
$('nameInput').value = myName;
$('roomInput').value = localStorage.getItem('shelem_roomId') || '';

$('createBtn').onclick = () => {
  myName = getChosenName();
  if (!myName) return;
  localStorage.setItem('shelem_name', myName);
  socket.emit('createRoom', { clientId, name: myName });
};
$('joinBtn').onclick = () => {
  myName = getChosenName();
  if (!myName) return;
  const roomId = $('roomInput').value.trim().toUpperCase();
  if (!roomId) {
    $('homeError').textContent = '\u06A9\u062F \u0631\u0648\u0645 \u0631\u0627 \u0648\u0627\u0631\u062F \u06A9\u0646\u06CC\u062F';
    $('roomInput').focus();
    return;
  }
  localStorage.setItem('shelem_name', myName);
  socket.emit('joinRoom', { clientId, name: myName, roomId });
};
function getChosenName() {
  const name = $('nameInput').value.trim();
  if (!name) {
    $('homeError').textContent = '\u0642\u0628\u0644 \u0627\u0632 \u0648\u0631\u0648\u062F\u060C \u0646\u0627\u0645 \u062E\u0648\u062F \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F';
    $('nameInput').focus();
    return '';
  }
  $('homeError').textContent = '';
  return name.slice(0, 16);
}
$('nameInput').addEventListener('input', () => { $('homeError').textContent = ''; });
socket.on('errorMsg', (msg) => { awaitingState = false; clearTimeout(rejoinTimer); updateConnBar(); $('homeError').textContent = msg; });

$('readyBtn').onclick = () => socket.emit('toggleReady');
$('startBtn').onclick = () => socket.emit('startGame');
$('nextRoundBtn').onclick = () => socket.emit('nextRound');
$('leaveRoomBtn').onclick = () => {
  if (!lastState) return;
  const unfinishedRound = !['lobby', 'roundEnd', 'gameOver'].includes(lastState.state);
  if (unfinishedRound && !window.confirm('\u0628\u0627 \u062E\u0631\u0648\u062C \u0634\u0645\u0627\u060C \u062F\u0633\u062A \u0646\u0627\u062A\u0645\u0627\u0645 \u0644\u063A\u0648 \u0648 \u0631\u0648\u0645 \u0628\u0647 \u0644\u0627\u0628\u06CC \u0628\u0631\u0645\u06CC\u200C\u06AF\u0631\u062F\u062F. \u0627\u062F\u0627\u0645\u0647 \u0645\u06CC\u200C\u062F\u0647\u06CC\u062F\u061F')) return;
  $('leaveRoomBtn').disabled = true;
  socket.emit('leaveRoom');
};
$('passBtn').onclick = () => socket.emit('passBid');
$('confirmDiscard').onclick = () => {
  if (selectedKittyCards.length !== 4) return;
  socket.emit('discardKitty', { cardIds: selectedKittyCards });
  selectedKittyCards = [];
};
$('scoreBtn').onclick = () => { $('scoreModal').classList.remove('hidden'); renderScoreModal(); };
$('closeScore').onclick = () => $('scoreModal').classList.add('hidden');
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
$('chatToggle').onclick = () => setChatExpanded(!chatExpanded);
document.addEventListener('click', (event) => {
  if (chatExpanded && !$('chatBox').contains(event.target)) setChatExpanded(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && chatExpanded) setChatExpanded(false);
});
function sendChat() {
  const v = $('chatInput').value.trim();
  if (!v) return;
  socket.emit('chatMessage', { text: v });
  $('chatInput').value = '';
}
let chatExpanded = false, chatSeenT = null, chatKey = '', chatBubbleTimer = null;
function setChatExpanded(expanded) {
  chatExpanded = expanded;
  $('chatBox').classList.toggle('expanded', expanded);
  $('chatExpanded').classList.toggle('hidden', !expanded);
  $('chatToggle').setAttribute('aria-expanded', String(expanded));
  if (expanded) {
    $('chatLatest').classList.add('hidden');
    if (lastState) renderChat(lastState);
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    $('chatInput').focus();
  }
}
function renderChat(state) {
  const msgs = state.chat || [];
  const latest = msgs[msgs.length - 1];
  if (chatSeenT === null) chatSeenT = latest ? latest.t : 0;
  const key = latest ? latest.t + '|' + msgs.length : '';
  if (key !== chatKey) {
    const firstRender = chatKey === '' && !latest ? false : chatKey === '';
    chatKey = key;
    const el = $('chatMessages');
    el.innerHTML = msgs.map((m) => `<div><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
    if (latest && !firstRender && !chatExpanded && latest.seat !== state.mySeat) {
      const bubble = $('chatLatest');
      bubble.textContent = `${latest.name}: ${latest.text}`;
      bubble.classList.remove('hidden');
      Sfx.play('pop');
      clearTimeout(chatBubbleTimer);
      chatBubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 4000);
    }
  }
  if (chatExpanded && latest) chatSeenT = latest.t;
  const unread = chatExpanded ? 0 : msgs.filter((m) => m.t > chatSeenT && m.seat !== state.mySeat).length;
  const badge = $('chatBadge');
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', unread === 0);
  $('chatBox').classList.toggle('expanded', chatExpanded);
  $('chatExpanded').classList.toggle('hidden', !chatExpanded);
}
$('teamAName').addEventListener('change', () => socket.emit('setTeamName', { team: 'A', name: $('teamAName').value }));
$('teamBName').addEventListener('change', () => socket.emit('setTeamName', { team: 'B', name: $('teamBName').value }));

const SUIT_CH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const cardHTML = (card) => `<span class="ci"><b>${RANK_LABEL[card.rank]}</b><i>${SUIT_CH[card.suit]}</i></span><span class="cs">${SUIT_CH[card.suit]}</span>`;
let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
socket.on('notice', (n) => { toast(n.text); if (n.type === 'redeal') Sfx.play('deal'); });
function paintAudio() {
  $('musicBtn').classList.toggle('off', !Sfx.music);
  $('sfxBtn').classList.toggle('off', !Sfx.sfx);
}
$('musicBtn').onclick = () => { Sfx.toggleMusic(); paintAudio(); };
$('sfxBtn').onclick = () => { Sfx.toggleSfx(); paintAudio(); };
paintAudio();
let prevPhase = null, prevMyActive = false, prevBids = null, prevTrump = null, prevPlayerCount = -1, prevOffline = 0;
const POS = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
const faNum = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const relPos = (seat) => (seat - lastState.mySeat + 4) % 4; // 0 me, 1 right, 2 top, 3 left

let everConnected = false, awaitingState = false, rejoinTimer = null;
let collectingUntil = 0, collectTimer = null;
let renderedTrickIds = new Set(), trickSeeded = false;
let gameOverShownKey = -1;

function rejoin() {
  const rid = (lastState && lastState.roomId) || localStorage.getItem('shelem_roomId');
  const nm = myName || localStorage.getItem('shelem_name');
  if (!rid || !nm || !socket.connected) return;
  awaitingState = true;
  socket.emit('joinRoom', { clientId, name: nm, roomId: rid });
  clearTimeout(rejoinTimer);
  rejoinTimer = setTimeout(() => { if (awaitingState && socket.connected) rejoin(); }, 6000);
  updateConnBar();
}
function updateConnBar() {
  const bar = $('connBar');
  let msg = '', cls = '';
  const offline = (everConnected && !socket.connected) || navigator.onLine === false;
  if (offline) {
    msg = '🔴 اتصال شما قطع شده؛ در حال اتصال مجدد...';
    cls = 'bad';
  } else if (awaitingState) {
    msg = '🟡 اتصال برقرار شد؛ در حال همگام‌سازی با میز...';
    cls = 'warn';
  } else if (lastState) {
    const off = lastState.players.filter((p) => !p.connected && p.seat !== lastState.mySeat).map((p) => p.name);
    if (off.length) {
      msg = `🟠 ${off.join('، ')} ${off.length > 1 ? 'قطع شده‌اند' : 'قطع شده'}؛ بازی تا بازگشت منتظر می‌ماند`;
      cls = 'warn';
    }
  }
  bar.textContent = msg;
  bar.className = 'conn-bar ' + cls + (msg ? '' : ' hidden');
  document.body.classList.toggle('has-conn-bar', Boolean(msg));
}
socket.on('connect', () => { everConnected = true; rejoin(); updateConnBar(); });
socket.on('disconnect', (reason) => {
  Sfx.play('warn');
  if (reason === 'io server disconnect') socket.connect();
  updateConnBar();
});
socket.on('connect_error', updateConnBar);
socket.io.on('reconnect_attempt', updateConnBar);
window.addEventListener('online', () => { socket.connect(); updateConnBar(); });
window.addEventListener('offline', updateConnBar);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!socket.connected) socket.connect();
  else if (lastState) rejoin(); // همگام‌سازی مجدد بعد از برگشتن به صفحه
  updateConnBar();
});
setInterval(() => { fetch('/health').catch(() => {}); }, 4 * 60 * 1000);

socket.on('state', (state) => {
  awaitingState = false;
  clearTimeout(rejoinTimer);
  lastState = state;
  localStorage.setItem('shelem_roomId', state.roomId);
  try { render(state); } catch (e) { console.error(e); }
  updateConnBar();
});
socket.on('leftRoom', () => {
  awaitingState = false;
  clearTimeout(rejoinTimer);
  localStorage.removeItem('shelem_roomId');
  $('roomInput').value = '';
  $('leaveRoomBtn').disabled = false;
  $('leaveRoomBtn').classList.add('hidden');
  $('lobby').classList.add('hidden');
  $('game').classList.add('hidden');
  $('scoreModal').classList.add('hidden');
  $('home').classList.remove('hidden');
  $('homeError').textContent = '';
  lastState = null;
  selectedSeats = [];
  selectedKittyCards = [];
  setChatExpanded(false);
  chatSeenT = null; chatKey = '';
  $('myHand').innerHTML = '';
  $('trickArea').innerHTML = '';
  $('trickArea').dataset.sig = '';
  renderedTrickIds = new Set(); trickSeeded = false; gameOverShownKey = -1;
  prevPhase = null; prevBids = null; prevTrump = null; prevPlayerCount = -1; prevOffline = 0;
  $('chatBox').classList.add('hidden');
  updateConnBar();
});

socket.on('trickResult', ({ winnerSeat, points, trickNumber }) => {
  if (!lastState) return;
  // جمع شدن نرم کارت‌ها به سمت برنده دست
  const pos = POS[relPos(winnerSeat)];
  $('trickArea').querySelectorAll('.trick-card').forEach((el) => el.classList.add('collect', 'to-' + pos));
  collectingUntil = Date.now() + 460;
  clearTimeout(collectTimer);
  collectTimer = setTimeout(() => { collectingUntil = 0; if (lastState) renderGame(lastState); }, 480);
  Sfx.play((winnerSeat % 2) === (lastState.mySeat % 2) ? 'good' : 'swish');
  const winner = lastState.players.find((player) => player.seat === winnerSeat);
  const feedback = $('trickFeedback');
  feedback.innerHTML = `<strong>دست ${faNum(trickNumber)}</strong><span>${winner ? escapeHtml(winner.name) : ''} · ${faNum(points)} امتیاز</span>`;
  feedback.classList.remove('hidden');
  feedback.classList.remove('feedback-in');
  void feedback.offsetWidth;
  feedback.classList.add('feedback-in');
  clearTimeout(trickFeedbackTimer);
  trickFeedbackTimer = setTimeout(() => feedback.classList.add('hidden'), 1700);
});

// قانون خال‌تبعیت؛ دقیقاً مطابق سرور
function legalCards(hand, trick) {
  if (!trick || trick.cards.length === 0 || trick.cards.length >= 4) return hand.slice();
  const lead = trick.cards[0].card.suit;
  return hand.some((c) => c.suit === lead) ? hand.filter((c) => c.suit === lead) : hand.slice();
}
// آیا کارت شماره i برش است؟ (اولین برش با حکم، یا برش بالاتر روی برش قبلی)
function isCutPlay(cards, i, trump) {
  if (!trump || i === 0) return false;
  const lead = cards[0].card.suit;
  const c = cards[i].card;
  if (lead === trump || c.suit !== trump) return false;
  const prev = cards.slice(1, i).filter((e) => e.card.suit === trump);
  return prev.length === 0 || c.rank > Math.max(...prev.map((e) => e.card.rank));
}

function cardLabel(card) { return RANK_LABEL[card.rank] + SUIT_SYM[card.suit]; }
function isRed(card) { return RED_SUITS.includes(card.suit); }

function triggerTableShake() {
  const table = $('table');
  table.classList.remove('trump-cut');
  void table.offsetWidth;
  table.classList.add('trump-cut');
  setTimeout(() => table.classList.remove('trump-cut'), 720);
}

function render(state) {
  $('home').classList.add('hidden');
  $('chatBox').classList.remove('hidden');
  $('leaveRoomBtn').classList.remove('hidden');
  $('leaveRoomBtn').disabled = false;
  if (state.state === 'lobby') {
    gameOverShownKey = -1;
    prevPhase = 'lobby'; prevBids = null; prevTrump = null;
    if (prevPlayerCount >= 0 && state.players.length !== prevPlayerCount) Sfx.play('join');
    prevPlayerCount = state.players.length;
    $('lobby').classList.remove('hidden');
    $('game').classList.add('hidden');
    renderLobby(state);
    renderChat(state);
  } else {
    prevPlayerCount = state.players.length;
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    renderGame(state);
  }
  if (!$('scoreModal').classList.contains('hidden')) renderScoreModal();
}

const TARGETS = [[0, 'آزاد'], [330, '۳۳۰'], [660, '۶۶۰'], [1165, '۱۱۶۵'], [1650, '۱۶۵۰']];
function renderTarget(state) {
  const el = $('targetOptions');
  el.innerHTML = '';
  for (const [value, label] of TARGETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = 'target-btn' + (state.targetScore === value ? ' active' : '');
    b.disabled = !state.isAdmin;
    b.onclick = () => socket.emit('setTarget', { target: value });
    el.appendChild(b);
  }
  $('targetHint').textContent = state.isAdmin ? '' : 'فقط مدیر روم می‌تواند امتیاز نهایی را تغییر دهد';
}

function renderLobby(state) {
  $('lobbyRoomId').textContent = state.roomId;
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  for (let s = 0; s < 4; s++) {
    const pl = state.players.find((p) => p.seat === s);
    const box = document.createElement('div');
    box.className = 'seatbox' + (selectedSeats.includes(s) ? ' selected' : '');
    const team = escapeHtml(s % 2 === 0 ? state.teamNames.A : state.teamNames.B);
    const who = pl
      ? (pl.isAdmin ? '⚙️ ' : '') + escapeHtml(pl.name) + (pl.ready || pl.isAdmin ? ' ✅' : '') + (pl.connected === false ? ' <small>⚠️ قطع</small>' : '')
      : '— خالی —';
    box.innerHTML = `<div class="tag">صندلی ${s + 1} · ${team}</div><div>${who}</div>`;
    if (state.isAdmin) {
      box.onclick = () => {
        selectedSeats.push(s);
        if (selectedSeats.length === 2) {
          socket.emit('swapSeats', { seatA: selectedSeats[0], seatB: selectedSeats[1] });
          selectedSeats = [];
        }
        renderLobby(state);
      };
    }
    seatsEl.appendChild(box);
  }
  renderTarget(state);
  $('teamNameEditor').classList.toggle('hidden', !state.isAdmin);
  if (state.isAdmin) { $('teamAName').value = state.teamNames.A; $('teamBName').value = state.teamNames.B; }
  const me = state.players.find((p) => p.seat === state.mySeat);
  $('readyBtn').classList.toggle('hidden', state.isAdmin || !me);
  if (me) $('readyBtn').textContent = me.ready ? 'آماده‌ام ✅ (لغو)' : 'آماده‌ام';
  $('startBtn').classList.toggle('hidden', !state.isAdmin);
  $('startBtn').disabled = state.players.length < 4 || !state.players.every((p) => p.isAdmin || p.ready);
}

function renderGame(state) {
  const revealCards = state.kittyReveal || [];
  const revealKey = revealCards.map((card) => card.id).join(',');
  if (revealKey && revealKey !== kittyRevealKey) {
    kittyRevealKey = revealKey;
    kittyRevealVisible = true;
    Sfx.play('reveal');
    setTimeout(() => {
      kittyRevealVisible = false;
      if (lastState && lastState.state === 'kitty') renderGame(lastState);
    }, 3200);
  } else if (!revealKey) {
    kittyRevealKey = '';
    kittyRevealVisible = false;
  }
  const rel = (seat) => (seat - state.mySeat + 4) % 4;
  const bidTag = (s) => {
    if (state.state !== 'bidding' || !state.bidding || !state.bidding.bids) return '';
    const v = state.bidding.bids[s];
    return v === 'pass' ? ' · پاس' : v ? ' · ' + v : '';
  };
  const trickFull = Boolean(state.trick && state.trick.cards.length >= 4);
  const activeSeat = state.state === 'bidding' && state.bidding ? state.bidding.turnSeat
    : state.state === 'kitty' ? state.hakemSeat
    : state.state === 'playing' && state.trick && !trickFull ? state.trick.turnSeat
    : null;
  for (let s = 0; s < 4; s++) {
    const pl = state.players.find((p) => p.seat === s);
    const nameEl = $('name-' + POS[rel(s)]);
    if (!nameEl) continue;
    const offline = Boolean(pl) && pl.connected === false;
    nameEl.innerHTML = pl ? `<span class="av">${escapeHtml(Array.from(pl.name)[0] || '?')}</span><span class="nm">${escapeHtml(pl.name)}</span>${state.hakemSeat === s ? '<em class="tg">👑</em>' : ''}${bidTag(s) ? `<em class="tg">${escapeHtml(bidTag(s).replace(' · ', ''))}</em>` : ''}${offline ? '<em class="tg off">قطع</em>' : ''}${activeSeat === s ? '<em class="tg">⏳</em>' : ''}` : '';
    nameEl.classList.toggle('mine', (s % 2) === (state.mySeat % 2));
    nameEl.classList.toggle('opp', (s % 2) !== (state.mySeat % 2));
    nameEl.classList.toggle('turn', Boolean(pl) && activeSeat === s);
    nameEl.classList.toggle('offline', offline);
  }
  const over = state.state === 'roundEnd' || state.state === 'gameOver';
  $('roundInfo').textContent = 'دست ' + faNum(state.history.length + (over ? 0 : 1))
    + (state.hakemSeat !== null && state.bidAmount ? ' · حاکم امتیاز ' + faNum(state.bidAmount) + ' خوانده' : '');
  if (state.trumpSuit) {
    const ht = (state.hakemSeat || 0) % 2 === 0 ? 'A' : 'B';
    const ot = ht === 'A' ? 'B' : 'A';
    const rp = state.roundPoints || { A: 0, B: 0 };
    const mineHakem = (ht === 'A') === (state.mySeat % 2 === 0);
    $('trumpInfo').innerHTML = `<span class="tsuit ${state.trumpSuit === 'H' || state.trumpSuit === 'D' ? 'red' : ''}">${SUIT_CH[state.trumpSuit]}</span><span class="tpts"><b class="${mineHakem ? 'blue' : 'redbg'}">${faNum(rp[ht])}/${faNum(state.bidAmount || 0)}</b><b class="${mineHakem ? 'redbg' : 'blue'}">${faNum(rp[ot])}</b></span>`;
  }
  $('trumpInfo').classList.toggle('hidden', !state.trumpSuit);
  const turnPlayer = state.players.find((player) => player.seat === activeSeat);
  const myActive = activeSeat !== null && activeSeat === state.mySeat;
  // --- sound events (state transitions) ---
  if (prevPhase !== null && state.state !== prevPhase) {
    if (state.state === 'bidding') Sfx.play('deal');
    else if (state.state === 'kitty') Sfx.play('hakem');
    else if (state.state === 'roundEnd' || state.state === 'gameOver') {
      const last = state.history[state.history.length - 1];
      const myTeam = state.mySeat % 2 === 0 ? 'A' : 'B';
      const delta = last ? (myTeam === last.hakemTeam ? last.deltaHakem : last.deltaOpp) : 0;
      if (state.state === 'gameOver') Sfx.play(state.winnerTeam === myTeam ? 'win' : 'lose');
      else Sfx.play(delta > 0 ? 'chime' : 'sad');
    }
  }
  prevPhase = state.state;
  if (myActive && !prevMyActive) Sfx.play('turn');
  prevMyActive = myActive;
  if (state.state === 'bidding' && state.bidding && state.bidding.bids) {
    if (prevBids) state.bidding.bids.forEach((v, s) => { if (v !== prevBids[s] && v !== null) Sfx.play(v === 'pass' ? 'pass' : 'bid'); });
    prevBids = state.bidding.bids.slice();
  } else prevBids = null;
  if (state.trumpSuit && !prevTrump && state.state === 'playing') Sfx.play('trump');
  prevTrump = state.trumpSuit;
  const offCount = state.players.filter((p) => !p.connected && p.seat !== state.mySeat).length;
  if (offCount > prevOffline) Sfx.play('warn');
  prevOffline = offCount;
  renderFans(state);

  if (state.state === 'bidding') {
    $('turnHint').textContent = myActive ? 'نوبت خوانش شماست' : turnPlayer ? 'نوبت خواندن: ' + turnPlayer.name : '';
  } else if (state.state === 'kitty') {
    $('turnHint').textContent = state.hakemSeat === state.mySeat ? 'کارت‌ها را بخوابان' : 'در انتظار کارت خواباندن حاکم';
  } else if (state.state === 'playing') {
    $('turnHint').textContent = myActive ? 'نوبت شماست' : turnPlayer ? 'نوبت بازی: ' + turnPlayer.name : '';
  } else {
    $('turnHint').textContent = '';
  }

  for (const team of ['A', 'B']) {
    const teamEl = $('teamTricks' + team);
    const anchorSeat = team === 'A' ? 0 : 1;
    const position = POS[rel(anchorSeat)];
    const count = state.tricksWon ? state.tricksWon[team] : 0;
    teamEl.className = 'team-tricks at-' + position;
    const pile = count ? `<div class="trick-pile" aria-hidden="true">${Array.from({ length: count }, (_, i) => `<span class="trick-pile-card" style="--stack-index:${i}"></span>`).join('')}</div>` : '';
    teamEl.innerHTML = `${pile}<div class="team-tricks-label"><span>${escapeHtml(state.teamNames[team])}</span><b>${faNum(count)} دست</b></div>`;
  }

  // trick area (فقط وقتی محتوا عوض شد بازسازی می‌شود تا انیمیشن‌ها تکرار نشوند)
  const trickArea = $('trickArea');
  if (Date.now() >= collectingUntil) {
    let sig, build = null;
    if (state.state === 'bidding') {
      sig = 'bidding';
      build = () => {
        const kittyPile = document.createElement('div');
        kittyPile.className = 'kitty-pile';
        for (let i = 0; i < 4; i++) {
          const back = document.createElement('div');
          back.className = 'kitty-back';
          back.setAttribute('aria-label', 'کارت وسط');
          kittyPile.appendChild(back);
        }
        trickArea.appendChild(kittyPile);
      };
    } else if (state.state === 'kitty') {
      const show = kittyRevealVisible && revealCards.length;
      sig = 'kitty:' + (show ? revealKey : '');
      build = () => {
        if (!show) return;
        const reveal = document.createElement('div');
        reveal.className = 'kitty-reveal';
        reveal.innerHTML = `<span class="reveal-caption">کارت‌های وسط</span><div class="reveal-cards">${revealCards.map((card) => `<div class="reveal-card${isRed(card) ? ' red' : ''}"><b>${RANK_LABEL[card.rank]}</b><span>${SUIT_SYM[card.suit]}</span></div>`).join('')}</div>`;
        trickArea.appendChild(reveal);
      };
    } else if (state.trick) {
      const cards = state.trick.cards;
      sig = 'trick:' + cards.map((e) => e.card.id).join(',');
      build = () => {
        if (!cards.length) renderedTrickIds = new Set();
        let cut = false;
        cards.forEach((entry, idx) => {
          const d = document.createElement('div');
          const isNew = trickSeeded && !renderedTrickIds.has(entry.card.id);
          const cutPlay = isNew && isCutPlay(cards, idx, state.trumpSuit);
          if (cutPlay) cut = true;
          d.className = `trick-card at-${POS[rel(entry.seat)]}` + (isRed(entry.card) ? ' red' : '') + (isNew ? ' enter' : '') + (cutPlay ? ' cut-flash' : '');
          d.innerHTML = cardHTML(entry.card);
          if (isNew) Sfx.play('flick');
          const player = state.players.find((candidate) => candidate.seat === entry.seat);
          if (player) d.title = `${player.name}: ${cardLabel(entry.card)}`;
          trickArea.appendChild(d);
        });
        renderedTrickIds = new Set(cards.map((e) => e.card.id));
        trickSeeded = true;
        if (cut) triggerTableShake();
      };
    } else {
      sig = 'none';
      build = () => { renderedTrickIds = new Set(); };
    }
    if (trickArea.dataset.sig !== sig) {
      trickArea.dataset.sig = sig;
      trickArea.innerHTML = '';
      build();
    }
  }

  // hand
  const inKitty = state.state === 'kitty' && state.hakemSeat === state.mySeat;
  renderHand(state, inKitty);

  // previous trick button
  $('prevTrickBtn').classList.toggle('hidden', !state.lastTrick);

  // bidding panel
  const biddingOn = state.state === 'bidding' && state.bidding;
  $('biddingPanel').classList.toggle('hidden', !biddingOn);
  if (biddingOn) {
    const myTurn = state.bidding.turnSeat === state.mySeat;
    const bidderName = (state.players.find((p) => p.seat === state.bidding.turnSeat) || {}).name || '';
    $('bidStatus').textContent = (state.bidding.currentBid ? '\u0628\u0627\u0644\u0627\u062A\u0631\u06CC\u0646 \u0631\u0642\u0645: ' + state.bidding.currentBid + ' \u00B7 ' : '\u06A9\u0633\u06CC \u0646\u062E\u0648\u0627\u0646\u062F\u0647 \u00B7 ') + '\u0646\u0648\u0628\u062A: ' + bidderName;
    $('bidPlayers').innerHTML = [0, 1, 2, 3].map((k) => {
      const s = (state.dealerSeat + k) % 4;
      const pl = state.players.find((p) => p.seat === s);
      const v = state.bidding.bids ? state.bidding.bids[s] : null;
      const turn = state.bidding.turnSeat === s;
      const txt = v === 'pass' ? 'پاس' : v ? String(v) : (turn ? 'نوبت او' : 'هنوز نخوانده');
      return `<div class="bid-chip${turn ? ' turn' : ''}${v === 'pass' ? ' passed' : ''}"><b>${escapeHtml(pl ? pl.name : '')}</b><span>${txt}${turn && v ? ' \u23F3' : ''}${turn && !v ? ' \u23F3' : ''}</span></div>`;
    }).join('');
    const opts = $('bidOptions');
    opts.innerHTML = '';
    for (let v = Math.max(100, state.bidding.currentBid + 5); v <= 165; v += 5) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.onclick = () => { Sfx.play('tick'); socket.emit('placeBid', { amount: v }); };
      opts.appendChild(b);
    }
    $('bidMenuInfo').textContent = state.bidding.currentBid ? 'بالاترین رقم تا الان: ' + state.bidding.currentBid : 'هنوز کسی نخوانده؛ حداقل ۱۰۰';
    $('passBtn').disabled = false;
    $('bidMenu').classList.toggle('hidden', !myTurn);
  } else {
    $('bidMenu').classList.add('hidden');
  }

  // kitty panel
  $('kittyPanel').classList.toggle('hidden', !inKitty);
  if (inKitty) $('confirmDiscard').disabled = selectedKittyCards.length !== 4;
  else $('confirmDiscard').textContent = '\u062A\u0627\u06CC\u06CC\u062F (\u06F4 \u06A9\u0627\u0631\u062A \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646)';
  if (inKitty) $('confirmDiscard').textContent = selectedKittyCards.length === 4 ? 'تایید خواباندن' : `انتخاب شده: ${selectedKittyCards.length}/4`;

  // round end / game over panel
  const gameOver = state.state === 'gameOver';
  const roundEnd = state.state === 'roundEnd' || gameOver;
  $('roundEndPanel').classList.toggle('hidden', !roundEnd);
  if (roundEnd) {
    const last = state.history[state.history.length - 1];
    const hakemName = escapeHtml((state.players.find((p) => p.seat === last.hakemSeat) || {}).name || '');
    const teamName = (t) => escapeHtml(state.teamNames[t]);
    const resLabel = RESULT_LABELS[last.resultType] || last.resultType;
    const oppTeam = last.hakemTeam === 'A' ? 'B' : 'A';
    const sign = (n) => (n >= 0 ? '+' : '') + n;
    $('roundEndText').innerHTML = `<b>${resLabel}</b><br>حاکم: ${hakemName} (خوانده: ${last.bid})<br>امتیاز ${teamName(last.hakemTeam)}: ${last.pointsHakem} (${sign(last.deltaHakem)})<br>امتیاز ${teamName(oppTeam)}: ${last.pointsOpp} (${sign(last.deltaOpp)})<br><br>جمع کل: ${teamName('A')} = ${state.scores.A} | ${teamName('B')} = ${state.scores.B}`
      + (gameOver ? `<br><br><span class="winner-banner">🏆 برنده بازی: ${teamName(state.winnerTeam)}</span>` : '');
    $('nextRoundBtn').classList.toggle('hidden', gameOver || !state.isAdmin);
    $('restartBtn').classList.toggle('hidden', !(gameOver && state.isAdmin));
    $('gameOverNote').classList.toggle('hidden', !(gameOver && !state.isAdmin));
  }
  renderChat(state);
}

const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 };
function layoutHand() {
  const handEl = $('myHand');
  const n = handEl.children.length;
  if (!n) return;
  const cw = handEl.children[0].offsetWidth || 64;
  const avail = handEl.clientWidth - 8;
  const step = n > 1 ? Math.min(cw * 0.78, (avail - cw) / (n - 1)) : cw;
  handEl.style.setProperty('--ov', Math.max(0, cw - step) + 'px');
}
window.addEventListener('resize', layoutHand);
function renderHand(state, inKitty) {
  const handEl = $('myHand');
  const myTurnToPlay = state.state === 'playing' && state.trick && state.trick.turnSeat === state.mySeat && state.trick.cards.length < 4;
  const legal = myTurnToPlay ? new Set(legalCards(state.myHand, state.trick).map((c) => c.id)) : null;
  const sorted = state.myHand.slice().sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.rank - b.rank);
  const existing = new Map(Array.from(handEl.children).map((el) => [el.dataset.id, el]));
  const keep = new Set(sorted.map((c) => c.id));
  existing.forEach((el, id) => { if (!keep.has(id)) el.remove(); });
  const n = sorted.length;
  sorted.forEach((card, idx) => {
    let el = existing.get(card.id);
    if (!el) {
      el = document.createElement('div');
      el.dataset.id = card.id;
      el.innerHTML = cardHTML(card);
      el.className = 'card deal-in' + (isRed(card) ? ' red' : '');
      el.addEventListener('animationend', () => el.classList.remove('deal-in'));
    }
    const d = idx - (n - 1) / 2;
    el.style.setProperty('--i', idx);
    el.style.setProperty('--rot', (d * 1.9).toFixed(2) + 'deg');
    el.style.setProperty('--arc', (d * d * 0.32).toFixed(1) + 'px');
    const isLegal = Boolean(legal) && legal.has(card.id);
    el.classList.toggle('selected', inKitty && selectedKittyCards.includes(card.id));
    el.classList.toggle('playable', isLegal);
    el.classList.toggle('dimmed', myTurnToPlay && !isLegal);
    el.classList.toggle('clickable', inKitty || isLegal);
    el.onclick = () => {
      if (inKitty) {
        const i = selectedKittyCards.indexOf(card.id);
        if (i >= 0) selectedKittyCards.splice(i, 1);
        else if (selectedKittyCards.length < 4) selectedKittyCards.push(card.id);
        Sfx.play('tick');
        if (lastState) renderGame(lastState);
      } else if (isLegal) {
        socket.emit('playCard', { cardId: card.id });
      } else if (myTurnToPlay) {
        Sfx.play('deny');
        el.classList.remove('deny'); void el.offsetWidth; el.classList.add('deny');
      }
    };
    if (handEl.children[idx] !== el) handEl.insertBefore(el, handEl.children[idx] || null);
  });
  layoutHand();
}

function renderFans(state) {
  for (let s = 0; s < 4; s++) {
    const r = (s - state.mySeat + 4) % 4;
    if (r === 0) continue;
    const el = $('fan-' + POS[r]);
    const n = Math.min(16, (state.handCounts && state.handCounts[s]) || 0);
    if (el.dataset.n !== String(n)) { el.dataset.n = String(n); el.innerHTML = '<i class="fb"></i>'.repeat(n); }
  }
}

function showPrevTrick() {
  if (!lastState || !lastState.lastTrick) return;
  const lt = lastState.lastTrick;
  const winner = lastState.players.find((p) => p.seat === lt.winnerSeat);
  $('prevTrickTitle').textContent = 'دست قبل' + (winner ? ' · برنده: ' + winner.name : '');
  $('prevTrickCards').innerHTML = lt.cards.map((e) => `<div class="trick-card at-${POS[relPos(e.seat)]}${isRed(e.card) ? ' red' : ''}${e.seat === lt.winnerSeat ? ' winner' : ''}">${cardHTML(e.card)}</div>`).join('');
  $('prevTrick').classList.remove('hidden');
}
function hidePrevTrick() { $('prevTrick').classList.add('hidden'); }
const prevBtn = $('prevTrickBtn');
prevBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { prevBtn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  showPrevTrick();
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => prevBtn.addEventListener(ev, hidePrevTrick));
['contextmenu', 'selectstart', 'dragstart', 'touchstart', 'touchmove'].forEach((ev) => prevBtn.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

$('restartBtn').onclick = () => socket.emit('restartGame');

function renderScoreModal() {
  if (!lastState) return;
  const scoreA = Number(lastState.scores.A) || 0;
  const scoreB = Number(lastState.scores.B) || 0;
  const teamAName = escapeHtml(lastState.teamNames.A);
  const teamBName = escapeHtml(lastState.teamNames.B);
  const target = lastState.targetScore ? faNum(lastState.targetScore) : 'آزاد';
  const gameOver = lastState.state === 'gameOver';
  const banner = gameOver ? `<div class="winner-banner big">🏆 برنده بازی: ${escapeHtml(lastState.teamNames[lastState.winnerTeam])}</div>` : '';
  $('scoreTotals').innerHTML = `${banner}<div class="scoreboard-caption"><span>میز: بازی آنلاین</span><b>امتیاز هدف: ${target}</b></div><div class="scoreboard-teambar"><div class="scoreboard-team team-a"><small>${teamAName}</small><strong>${scoreA.toLocaleString('fa-IR')}</strong><span>امتیاز کل</span></div><div class="scoreboard-vs">VS</div><div class="scoreboard-team team-b"><small>${teamBName}</small><strong>${scoreB.toLocaleString('fa-IR')}</strong><span>امتیاز کل</span></div></div>`;
  const actions = $('modalActions');
  actions.innerHTML = '';
  if (gameOver) {
    if (lastState.isAdmin) {
      const b = document.createElement('button');
      b.textContent = '🔁 بازی مجدد';
      b.onclick = () => { socket.emit('restartGame'); $('scoreModal').classList.add('hidden'); };
      actions.appendChild(b);
    } else {
      actions.textContent = 'در انتظار مدیر روم برای شروع بازی مجدد...';
    }
  }
  if (!lastState.history.length) {
    $('scoreHistory').innerHTML = '<div class="empty-history">\u0647\u0646\u0648\u0632 \u062F\u0633\u062A\u06CC \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0646\u0631\u0633\u06CC\u062F\u0647 \u0627\u0633\u062A.</div>';
    return;
  }
  let rows = '<div class="history-caption">\u0627\u0645\u062A\u06CC\u0627\u0632 \u0647\u0631 \u0631\u0627\u0648\u0646\u062F\u060C \u062A\u0639\u0647\u062F \u062D\u0627\u06A9\u0645\u060C \u0646\u062A\u06CC\u062C\u0647 \u0648 \u062C\u0645\u0639 \u06A9\u0644 \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u0633\u0637\u0631 \u0645\u06CC\u200C\u0628\u06CC\u0646\u06CC\u062F.</div><div class="score-table-wrap"><table class="scoreboard-table"><thead><tr><th>\u062F\u0633\u062A</th><th><b>' + escapeHtml(lastState.teamNames.B) + '</b><br><small>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</small></th><th>\u0627\u0645\u062A\u06CC\u0627\u0632 \u0627\u06CC\u0646 \u062F\u0633\u062A</th><th>\u062A\u0639\u0647\u062F \u062D\u0627\u06A9\u0645</th><th>\u0627\u0645\u062A\u06CC\u0627\u0632 \u0627\u06CC\u0646 \u062F\u0633\u062A</th><th><b>' + escapeHtml(lastState.teamNames.A) + '</b><br><small>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</small></th><th>\u0646\u062A\u06CC\u062C\u0647</th></tr></thead><tbody>';
  for (const h of lastState.history) {
    const hakemName = (lastState.players.find((p) => p.seat === h.hakemSeat) || {}).name || '';
    const oppTeam = h.hakemTeam === 'A' ? 'B' : 'A';
    const resultClass = h.resultType === 'success' || h.resultType === 'shelem' || h.resultType === 'sarshelem-success' ? 'positive' : 'negative';
    const teamAPoints = h.hakemTeam === 'A' ? h.pointsHakem : h.pointsOpp;
    const teamBPoints = h.hakemTeam === 'B' ? h.pointsHakem : h.pointsOpp;
    const teamADelta = h.hakemTeam === 'A' ? h.deltaHakem : h.deltaOpp;
    const teamBDelta = h.hakemTeam === 'B' ? h.deltaHakem : h.deltaOpp;
    rows += `<tr><td><b>${Number(h.round).toLocaleString('fa-IR')}</b><small>${escapeHtml(hakemName)} \u00B7 ${escapeHtml(lastState.teamNames[h.hakemTeam])}</small></td><td><b>${h.scoreAfter.B}</b></td><td><b>${teamBPoints}</b><small class="${teamBDelta >= 0 ? 'gain' : 'loss'}">${teamBDelta >= 0 ? '+' : ''}${teamBDelta}</small></td><td><b>${h.bid}</b><small>${escapeHtml(lastState.teamNames[h.hakemTeam])} \u00B7 حاکم</small></td><td><b>${teamAPoints}</b><small class="${teamADelta >= 0 ? 'gain' : 'loss'}">${teamADelta >= 0 ? '+' : ''}${teamADelta}</small></td><td><b>${h.scoreAfter.A}</b></td><td><span class="result-pill ${resultClass}">${RESULT_LABELS[h.resultType] || escapeHtml(h.resultType)}</span></td></tr>`;
  }
  rows += '</tbody></table></div>';
  $('scoreHistory').innerHTML = rows;
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
