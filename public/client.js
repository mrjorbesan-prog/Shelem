const socket = io();
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
socket.on('errorMsg', (msg) => { $('homeError').textContent = msg; });

$('readyBtn').onclick = () => socket.emit('toggleReady');
$('startBtn').onclick = () => socket.emit('startGame');
$('nextRoundBtn').onclick = () => socket.emit('nextRound');
$('leaveRoomBtn').onclick = () => {
  if (!lastState) return;
  const unfinishedRound = !['lobby', 'roundEnd'].includes(lastState.state);
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
let chatExpanded = false;
function setChatExpanded(expanded) {
  chatExpanded = expanded;
  $('chatBox').classList.toggle('expanded', expanded);
  $('chatExpanded').classList.toggle('hidden', !expanded);
  $('chatToggle').setAttribute('aria-expanded', String(expanded));
  if (expanded) {
    $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
    $('chatInput').focus();
  }
}
$('teamAName').addEventListener('change', () => socket.emit('setTeamName', { team: 'A', name: $('teamAName').value }));
$('teamBName').addEventListener('change', () => socket.emit('setTeamName', { team: 'B', name: $('teamBName').value }));

socket.on('state', (state) => {
  lastState = state;
  localStorage.setItem('shelem_roomId', state.roomId);
  render(state);
});
socket.on('leftRoom', () => {
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
});

socket.on('trickResult', ({ winnerSeat, points, trickNumber, wasCut }) => {
  if (!lastState) return;
  if (wasCut) triggerTableShake();
  const winner = lastState.players.find((player) => player.seat === winnerSeat);
  const feedback = $('trickFeedback');
  feedback.innerHTML = `<strong>دست ${Number(trickNumber).toLocaleString('fa-IR')}</strong><span>${winner ? escapeHtml(winner.name) : ''} · ${Number(points).toLocaleString('fa-IR')} امتیاز</span>`;
  feedback.classList.remove('hidden');
  feedback.classList.remove('feedback-in');
  void feedback.offsetWidth;
  feedback.classList.add('feedback-in');
  clearTimeout(trickFeedbackTimer);
  trickFeedbackTimer = setTimeout(() => feedback.classList.add('hidden'), 1700);
});

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
  $('leaveRoomBtn').classList.remove('hidden');
  $('leaveRoomBtn').disabled = false;
  if (state.state === 'lobby') {
    $('lobby').classList.remove('hidden');
    $('game').classList.add('hidden');
    renderLobby(state);
  } else {
    $('lobby').classList.add('hidden');
    $('game').classList.remove('hidden');
    renderGame(state);
  }
}

function renderLobby(state) {
  $('lobbyRoomId').textContent = state.roomId;
  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  for (let s = 0; s < 4; s++) {
    const pl = state.players.find((p) => p.seat === s);
    const box = document.createElement('div');
    box.className = 'seatbox' + (selectedSeats.includes(s) ? ' selected' : '');
    const team = s % 2 === 0 ? state.teamNames.A : state.teamNames.B;
    box.innerHTML = `<div class="tag">\u0635\u0646\u062F\u0644\u06CC ${s + 1} \u00B7 ${team}</div><div>${pl ? (pl.isAdmin ? '\u2699\uFE0F ' : '') + pl.name + (pl.ready || pl.isAdmin ? ' \u2705' : '') : '\u2014 \u062E\u0627\u0644\u06CC \u2014'}</div>`;
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
  $('teamNameEditor').classList.toggle('hidden', !state.isAdmin);
  if (state.isAdmin) { $('teamAName').value = state.teamNames.A; $('teamBName').value = state.teamNames.B; }
  const me = state.players.find((p) => p.seat === state.mySeat);
  $('readyBtn').classList.toggle('hidden', state.isAdmin || !me);
  if (me) $('readyBtn').textContent = me.ready ? '\u0622\u0645\u0627\u062F\u0647\u200C\u0627\u0645 \u2705 (\u0644\u063A\u0648)' : '\u0622\u0645\u0627\u062F\u0647\u200C\u0627\u0645';
  $('startBtn').classList.toggle('hidden', !state.isAdmin);
  $('startBtn').disabled = state.players.length < 4 || !state.players.every((p) => p.isAdmin || p.ready);
}

function renderGame(state) {
  const revealCards = state.kittyReveal || [];
  const revealKey = revealCards.map((card) => card.id).join(',');
  if (revealKey && revealKey !== kittyRevealKey) {
    kittyRevealKey = revealKey;
    kittyRevealVisible = true;
    setTimeout(() => {
      kittyRevealVisible = false;
      if (lastState && lastState.state === 'kitty') renderGame(lastState);
    }, 3200);
  } else if (!revealKey) {
    kittyRevealKey = '';
    kittyRevealVisible = false;
  }
  const rel = (seat) => (seat - state.mySeat + 4) % 4; // 0 me,1 right,2 top,3 left
  const posName = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  for (let s = 0; s < 4; s++) {
    const pl = state.players.find((p) => p.seat === s);
    const pos = posName[rel(s)];
    const nameEl = $('name-' + pos);
    if (nameEl) nameEl.textContent = pl ? pl.name + (state.hakemSeat === s ? ' \u{1F451}' : '') + (state.trick && state.trick.turnSeat === s ? ' \u23F3' : '') : '';
  }
  const me = state.players.find((p) => p.seat === state.mySeat);
  $('name-bottom').textContent = me ? me.name + (state.hakemSeat === state.mySeat ? ' \u{1F451}' : '') + (state.trick && state.trick.turnSeat === state.mySeat ? ' \u23F3' : '') : '';
  $('roundInfo').textContent = '\u062F\u0633\u062A ' + (state.history.length + 1) + (state.hakemSeat !== null && state.bidAmount ? ' \u00B7 \u062D\u0627\u06A9\u0645 \u0627\u0645\u062A\u06CC\u0627\u0632 ' + state.bidAmount + ' \u062E\u0648\u0627\u0646\u062F\u0647' : '');
  $('trumpInfo').textContent = state.trumpSuit ? '\u062D\u06A9\u0645: ' + SUIT_SYM[state.trumpSuit] : '';
  $('trumpInfo').classList.toggle('hidden', !state.trumpSuit);
  const turnSeat = state.bidding ? state.bidding.turnSeat : state.trick && state.trick.turnSeat;
  const turnPlayer = state.players.find((player) => player.seat === turnSeat);
  if (state.state === 'bidding') {
    $('turnHint').textContent = turnPlayer ? '\u0646\u0648\u0628\u062A \u062E\u0648\u0627\u0646\u062F\u0646: ' + turnPlayer.name : '';
  } else if (state.state === 'kitty') {
    $('turnHint').textContent = state.hakemSeat === state.mySeat ? '\u0686\u0647\u0627\u0631 \u06A9\u0627\u0631\u062A \u0648\u0633\u0637 \u0631\u0627 \u0628\u0628\u06CC\u0646 \u0648 \u06F4 \u06A9\u0627\u0631\u062A \u0628\u0631\u0627\u06CC \u0632\u06CC\u0631\u0633\u0627\u0632\u06CC \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F' : '\u062D\u0627\u06A9\u0645 \u062F\u0631 \u062D\u0627\u0644 \u0632\u06CC\u0631\u0633\u0627\u0632\u06CC \u0627\u0633\u062A';
  } else if (state.state === 'playing') {
    $('turnHint').textContent = turnPlayer ? '\u0646\u0648\u0628\u062A \u0628\u0627\u0632\u06CC: ' + turnPlayer.name : '';
  } else {
    $('turnHint').textContent = '';
  }

  for (const team of ['A', 'B']) {
    const teamEl = $('teamTricks' + team);
    const anchorSeat = team === 'A' ? 0 : 1;
    const position = posName[rel(anchorSeat)];
    const count = state.tricksWon ? state.tricksWon[team] : 0;
    teamEl.className = 'team-tricks at-' + position;
    const pile = count ? `<div class="trick-pile" aria-hidden="true">${Array.from({ length: count }, (_, i) => `<span class="trick-pile-card" style="--stack-index:${i}"></span>`).join('')}</div>` : '';
    teamEl.innerHTML = `${pile}<div class="team-tricks-label"><span>${escapeHtml(state.teamNames[team])}</span><b>${count.toLocaleString('fa-IR')} \u062F\u0633\u062A</b></div>`;
  }

  // trick area
  const trickArea = $('trickArea');
  trickArea.innerHTML = '';
  if (state.state === 'bidding') {
    const kittyPile = document.createElement('div');
    kittyPile.className = 'kitty-pile';
    for (let i = 0; i < 4; i++) {
      const back = document.createElement('div');
      back.className = 'kitty-back';
      back.setAttribute('aria-label', '\u06A9\u0627\u0631\u062A \u0648\u0633\u0637');
      kittyPile.appendChild(back);
    }
    trickArea.appendChild(kittyPile);
  } else if (state.state === 'kitty') {
    if (kittyRevealVisible && revealCards.length) {
      const reveal = document.createElement('div');
      reveal.className = 'kitty-reveal';
      reveal.innerHTML = `<span class="reveal-caption">\u06A9\u0627\u0631\u062A\u200C\u0647\u0627\u06CC \u0645\u0648\u0633\u0637 \u0628\u0631\u0627\u06CC \u062D\u0627\u06A9\u0645</span><div class="reveal-cards">${revealCards.map((card) => `<div class="reveal-card${isRed(card) ? ' red' : ''}"><b>${RANK_LABEL[card.rank]}</b><span>${SUIT_SYM[card.suit]}</span></div>`).join('')}</div>`;
      trickArea.appendChild(reveal);
    }
  } else if (state.trick) {
    for (const entry of state.trick.cards) {
      const d = document.createElement('div');
      const position = posName[rel(entry.seat)];
      d.className = `trick-card at-${position}` + (isRed(entry.card) ? ' red' : '');
      d.textContent = cardLabel(entry.card);
      const player = state.players.find((candidate) => candidate.seat === entry.seat);
      if (player) d.title = `${player.name}: ${cardLabel(entry.card)}`;
      trickArea.appendChild(d);
    }
  }

  // hand
  const handEl = $('myHand');
  handEl.innerHTML = '';
  const inKitty = state.state === 'kitty' && state.hakemSeat === state.mySeat;
  const myTurnToPlay = state.state === 'playing' && state.trick && state.trick.turnSeat === state.mySeat;
  for (const card of state.myHand) {
    const d = document.createElement('div');
    d.className = 'card' + (isRed(card) ? ' red' : '');
    d.innerHTML = `<div>${RANK_LABEL[card.rank]}</div><div class="suit">${SUIT_SYM[card.suit]}</div>`;
    if (inKitty) {
      if (selectedKittyCards.includes(card.id)) d.classList.add('selected');
      d.onclick = () => {
        const idx = selectedKittyCards.indexOf(card.id);
        if (idx >= 0) selectedKittyCards.splice(idx, 1);
        else if (selectedKittyCards.length < 4) selectedKittyCards.push(card.id);
        renderGame(state);
      };
    } else if (myTurnToPlay) {
      d.onclick = () => socket.emit('playCard', { cardId: card.id });
    } else {
      d.style.cursor = 'default';
    }
    handEl.appendChild(d);
  }

  // bidding panel
  const biddingOn = state.state === 'bidding' && state.bidding;
  $('biddingPanel').classList.toggle('hidden', !biddingOn);
  if (biddingOn) {
    const myTurn = state.bidding.turnSeat === state.mySeat;
    const bidderName = (state.players.find((p) => p.seat === state.bidding.turnSeat) || {}).name || '';
    $('bidStatus').textContent = (state.bidding.currentBid ? '\u0628\u0627\u0644\u0627\u062A\u0631\u06CC\u0646 \u0631\u0642\u0645: ' + state.bidding.currentBid + ' \u00B7 ' : '\u06A9\u0633\u06CC \u0646\u062E\u0648\u0627\u0646\u062F\u0647 \u00B7 ') + '\u0646\u0648\u0628\u062A: ' + bidderName;
    const opts = $('bidOptions');
    opts.innerHTML = '';
    for (let v = 100; v <= 165; v += 5) {
      const b = document.createElement('button');
      b.textContent = v;
      const disabled = !myTurn || v <= state.bidding.currentBid;
      if (disabled) b.classList.add('disabledbid');
      b.disabled = disabled;
      b.onclick = () => socket.emit('placeBid', { amount: v });
      opts.appendChild(b);
    }
    $('passBtn').disabled = !myTurn;
  }

  // kitty panel
  $('kittyPanel').classList.toggle('hidden', !inKitty);
  if (inKitty) $('confirmDiscard').disabled = selectedKittyCards.length !== 4;
  else $('confirmDiscard').textContent = '\u062A\u0627\u06CC\u06CC\u062F (\u06F4 \u06A9\u0627\u0631\u062A \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646)';
  if (inKitty) $('confirmDiscard').textContent = selectedKittyCards.length === 4 ? '\u062A\u0627\u06CC\u06CC\u062F \u0632\u06CC\u0631\u0633\u0627\u0632\u06CC' : `\u0627\u0646\u062A\u062E\u0627\u0628 \u0634\u062F\u0647: ${selectedKittyCards.length}/4`;

  // round end panel
  const roundEnd = state.state === 'roundEnd';
  $('roundEndPanel').classList.toggle('hidden', !roundEnd);
  if (roundEnd) {
    const last = state.history[state.history.length - 1];
    const hakemName = (state.players.find((p) => p.seat === last.hakemSeat) || {}).name || '';
    const teamName = (t) => state.teamNames[t];
    const resLabel = RESULT_LABELS[last.resultType] || last.resultType;
    $('roundEndText').innerHTML = `<b>${resLabel}</b><br>\u062D\u0627\u06A9\u0645: ${hakemName} (\u062E\u0648\u0627\u0646\u062F\u0647: ${last.bid})<br>\u0627\u0645\u062A\u06CC\u0627\u0632 ${teamName(last.hakemTeam)}: ${last.pointsHakem} (${last.deltaHakem >= 0 ? '+' : ''}${last.deltaHakem})<br>\u0627\u0645\u062A\u06CC\u0627\u0632 ${teamName(last.hakemTeam === 'A' ? 'B' : 'A')}: ${last.pointsOpp} (${last.deltaOpp >= 0 ? '+' : ''}${last.deltaOpp})<br><br>\u062C\u0645\u0639 \u06A9\u0644: ${teamName('A')} = ${state.scores.A} | ${teamName('B')} = ${state.scores.B}`;
    $('nextRoundBtn').classList.toggle('hidden', !state.isAdmin);
  }

  // chat
  const chatEl = $('chatMessages');
  chatEl.innerHTML = state.chat.map((m) => `<div><b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}</div>`).join('');
  chatEl.scrollTop = chatEl.scrollHeight;
  const latest = state.chat[state.chat.length - 1];
  $('chatLatest').textContent = latest ? `${latest.name}: ${latest.text}` : '\u0647\u0646\u0648\u0632 \u067E\u06CC\u0627\u0645\u06CC \u0646\u06CC\u0633\u062A';
  $('chatBox').classList.toggle('expanded', chatExpanded);
  $('chatExpanded').classList.toggle('hidden', !chatExpanded);
  $('chatToggle').setAttribute('aria-expanded', String(chatExpanded));
}

function renderScoreModal() {
  if (!lastState) return;
  const scoreA = Number(lastState.scores.A) || 0;
  const scoreB = Number(lastState.scores.B) || 0;
  const teamAName = escapeHtml(lastState.teamNames.A);
  const teamBName = escapeHtml(lastState.teamNames.B);
  $('scoreTotals').innerHTML = `<div class="scoreboard-caption"><span>\u0645\u06CC\u0632: \u0628\u0627\u0632\u06CC \u0622\u0646\u0644\u0627\u06CC\u0646</span><b>\u0627\u0645\u062A\u06CC\u0627\u0632 \u0647\u062F\u0641: \u06F1\u06F6\u06F5</b></div><div class="scoreboard-teambar"><div class="scoreboard-team team-a"><small>${teamAName}</small><strong>${scoreA.toLocaleString('fa-IR')}</strong><span>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</span></div><div class="scoreboard-vs">VS</div><div class="scoreboard-team team-b"><small>${teamBName}</small><strong>${scoreB.toLocaleString('fa-IR')}</strong><span>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</span></div></div>`;
  if (!lastState.history.length) {
    $('scoreHistory').innerHTML = '<div class="empty-history">\u0647\u0646\u0648\u0632 \u062F\u0633\u062A\u06CC \u0628\u0647 \u067E\u0627\u06CC\u0627\u0646 \u0646\u0631\u0633\u06CC\u062F\u0647 \u0627\u0633\u062A.</div>';
    return;
  }
  let rows = '<div class="history-caption">\u0627\u0645\u062A\u06CC\u0627\u0632 \u0647\u0631 \u0631\u0627\u0648\u0646\u062F\u060C \u062A\u0639\u0647\u062F \u062D\u0627\u06A9\u0645\u060C \u0646\u062A\u06CC\u062C\u0647 \u0648 \u062C\u0645\u0639 \u06A9\u0644 \u0631\u0627 \u062F\u0631 \u06CC\u06A9 \u0633\u0637\u0631 \u0645\u06CC\u200C\u0628\u06CC\u0646\u06CC\u062F.</div><div class="score-table-wrap"><table class="scoreboard-table"><thead><tr><th>\u062F\u0633\u062A</th><th>${escapeHtml(lastState.teamNames.B)}<br><small>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</small></th><th>\u0627\u0645\u062A\u06CC\u0627\u0632 \u0627\u06CC\u0646 \u062F\u0633\u062A</th><th>\u062A\u0639\u0647\u062F \u062D\u0627\u06A9\u0645</th><th>\u0627\u0645\u062A\u06CC\u0627\u0632 \u0627\u06CC\u0646 \u062F\u0633\u062A</th><th>${escapeHtml(lastState.teamNames.A)}<br><small>\u0627\u0645\u062A\u06CC\u0627\u0632 \u06A9\u0644</small></th><th>\u0646\u062A\u06CC\u062C\u0647</th></tr></thead><tbody>';
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
