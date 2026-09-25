const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const SUITS = ['S', 'H', 'D', 'C']; // \u067E\u06CC\u06A9\u060C \u062F\u0644\u060C \u062E\u0634\u062A\u060C \u06AF\u0634\u0646\u06CC\u0632
const SUIT_LABEL = { S: '\u2660 \u067E\u06CC\u06A9', H: '\u2665 \u062F\u0644', D: '\u2666 \u062E\u0634\u062A', C: '\u2663 \u06AF\u0634\u0646\u06CC\u0632' };
const RANK_LABEL = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };

const rooms = {}; // roomId -> room

function shuffleInPlace(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function partialRiffle(deck) {
  const cutAt = Math.floor(Math.random() * deck.length);
  const cutDeck = [...deck.slice(cutAt), ...deck.slice(0, cutAt)];
  const minSplit = Math.floor(cutDeck.length * 0.35);
  const maxSplit = Math.ceil(cutDeck.length * 0.65);
  const splitAt = minSplit + Math.floor(Math.random() * (maxSplit - minSplit + 1));
  const left = cutDeck.slice(0, splitAt);
  const right = cutDeck.slice(splitAt);
  const shuffled = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length || rightIndex < right.length) {
    const takeLeft = rightIndex >= right.length
      || (leftIndex < left.length && Math.random() < 0.5);
    const pile = takeLeft ? left : right;
    let index = takeLeft ? leftIndex : rightIndex;
    const runLength = 1 + Math.floor(Math.random() * 3);
    const end = Math.min(index + runLength, pile.length);
    while (index < end) shuffled.push(pile[index++]);
    if (takeLeft) leftIndex = index;
    else rightIndex = index;
  }

  return shuffled;
}

function makeDeck(partialShuffle = false) {
  if (partialShuffle) {
    const deck = [];
    const suitOrder = shuffleInPlace([...SUITS]);
    for (const suit of suitOrder) {
      const suitCards = [];
      for (let rank = 2; rank <= 14; rank++) suitCards.push({ suit, rank, id: suit + rank });
      deck.push(...shuffleInPlace(suitCards));
    }

    // Three short cut-and-riffle passes retain occasional suit runs without forcing them.
    return [0, 1, 2].reduce((cards) => partialRiffle(cards), deck);
  }

  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ suit: s, rank: r, id: s + r });
  return shuffleInPlace(deck);
}

function cardBonus(card) {
  if (card.rank === 14) return 10;
  if (card.rank === 10) return 10;
  if (card.rank === 5) return 5;
  return 0;
}

function sortHand(cards) {
  return [...cards].sort((a, b) => {
    const si = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    if (si !== 0) return si;
    return b.rank - a.rank;
  });
}

function nextSeat(s) { return (s + 1) % 4; }
function teamOf(seat) { return seat % 2 === 0 ? 'A' : 'B'; }

function genId(len = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function newRoom(roomId, creatorClientId, creatorName) {
  const room = {
    id: roomId,
    players: [{ clientId: creatorClientId, socketId: null, name: creatorName, seat: 0, ready: true, connected: true }],
    adminClientId: creatorClientId,
    teamNames: { A: '\u062A\u06CC\u0645 \u06F1', B: '\u062A\u06CC\u0645 \u06F2' },
    scores: { A: 0, B: 0 },
    history: [],
    dealerSeat: 0,
    state: 'lobby', // lobby -> bidding -> kitty -> playing -> roundEnd
    hands: {},
    kitty: [],
    kittyReveal: [],
    buried: [],
    bidding: null,
    hakemSeat: null,
    bidAmount: 0,
    trumpSuit: null,
    trick: null,
    roundNo: 0,
    roundPoints: { A: 0, B: 0 },
    tricksWon: { A: 0, B: 0 },
    chat: [],
  };
  rooms[roomId] = room;
  return room;
}

function getPlayer(room, clientId) {
  return room.players.find((p) => p.clientId === clientId);
}

function moveRoomToLobby(room) {
  room.dealerSeat = nextSeat(room.dealerSeat);
  room.state = 'lobby';
  room.hands = {};
  room.kitty = [];
  room.kittyReveal = [];
  room.buried = [];
  room.bidding = null;
  room.hakemSeat = null;
  room.bidAmount = 0;
  room.trumpSuit = null;
  room.trick = null;
  room.roundPoints = { A: 0, B: 0 };
  room.tricksWon = { A: 0, B: 0 };
  for (const player of room.players) player.ready = player.clientId === room.adminClientId;
}

function removePlayerFromRoom(room, clientId) {
  const index = room.players.findIndex((player) => player.clientId === clientId);
  if (index < 0) return false;
  const [leavingPlayer] = room.players.splice(index, 1);
  if (leavingPlayer.clientId === room.adminClientId) {
    const nextAdmin = room.players.find((player) => player.connected) || room.players[0];
    room.adminClientId = nextAdmin ? nextAdmin.clientId : null;
  }
  if (room.state !== 'lobby') moveRoomToLobby(room);
  return true;
}

function leaveOtherRooms(clientId, keepRoomId, currentSocket) {
  for (const room of Object.values(rooms)) {
    if (room.id === keepRoomId || !getPlayer(room, clientId)) continue;
    const player = getPlayer(room, clientId);
    const previousSocket = player.socketId && io.sockets.sockets.get(player.socketId);
    if (previousSocket) {
      previousSocket.leave(room.id);
      previousSocket.data.roomId = null;
      previousSocket.data.clientId = null;
      previousSocket.emit('leftRoom');
    }
    if (currentSocket.data.roomId === room.id) currentSocket.leave(room.id);
    removePlayerFromRoom(room, clientId);
    if (room.players.length === 0) delete rooms[room.id];
    else broadcast(room);
  }
}

function publicPlayers(room) {
  return room.players.map((p) => ({ name: p.name, seat: p.seat, ready: p.ready, connected: p.connected, isAdmin: p.clientId === room.adminClientId }));
}

function stateFor(room, clientId) {
  const me = getPlayer(room, clientId);
  const mySeat = me ? me.seat : -1;
  return {
    roomId: room.id,
    players: publicPlayers(room),
    teamNames: room.teamNames,
    scores: room.scores,
    history: room.history,
    dealerSeat: room.dealerSeat,
    state: room.state,
    mySeat,
    isAdmin: me ? me.clientId === room.adminClientId : false,
    myHand: mySeat >= 0 && room.hands[mySeat] ? room.hands[mySeat] : [],
    handCounts: [0, 1, 2, 3].map((s) => (room.hands[s] ? room.hands[s].length : 0)),
    bidding: room.bidding,
    hakemSeat: room.hakemSeat,
    bidAmount: room.bidAmount,
    trumpSuit: room.trumpSuit,
    trick: room.trick ? { leaderSeat: room.trick.leaderSeat, turnSeat: room.trick.turnSeat, cards: room.trick.cards, number: room.trick.number } : null,
    roundPoints: room.roundPoints,
    tricksWon: room.tricksWon,
    kittyCount: room.kitty.length,
    kittyReveal: room.state === 'kitty' && room.hakemSeat === mySeat ? room.kittyReveal : [],
    needsDiscard: room.state === 'kitty',
    chat: room.chat.slice(-50),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', stateFor(room, p.clientId));
  }
}

function startDeal(room) {
  const deck = makeDeck(true);
  const dealSeats = [0, 1, 2, 3];
  dealSeats[0] = room.dealerSeat;
  for (let i = 1; i < dealSeats.length; i++) dealSeats[i] = nextSeat(dealSeats[i - 1]);
  room.hands = {};
  for (let i = 0; i < dealSeats.length; i++) {
    room.hands[dealSeats[i]] = sortHand(deck.slice(i * 12, (i + 1) * 12));
  }
  room.kitty = deck.slice(48, 52);
  room.buried = [];
  room.trumpSuit = null;
  room.hakemSeat = null;
  room.bidAmount = 0;
  room.trick = null;
  room.roundPoints = { A: 0, B: 0 };
  room.tricksWon = { A: 0, B: 0 };
  room.roundNo += 1;
  room.state = 'bidding';
  room.bidding = {
    turnSeat: room.dealerSeat,
    currentBid: 0,
    currentBidderSeat: null,
    active: [true, true, true, true],
  };
}

function activeSeats(bidding) {
  return [0, 1, 2, 3].filter((s) => bidding.active[s]);
}

function advanceBidTurn(room) {
  const b = room.bidding;
  const act = activeSeats(b);
  if (act.length <= 1) return;
  let s = nextSeat(b.turnSeat);
  while (!b.active[s]) s = nextSeat(s);
  b.turnSeat = s;
}

function finishBiddingIfNeeded(room) {
  const b = room.bidding;
  const act = activeSeats(b);
  if (act.length === 1) {
    if (b.currentBid > 0) {
      appointHakem(room, act[0], b.currentBid);
    }
    // if currentBid===0, lone player still gets a turn to bid or pass (handled in placeBid/pass)
  } else if (act.length === 0) {
    // everyone passed -> redeal by next seat
    room.dealerSeat = nextSeat(room.dealerSeat);
    startDeal(room);
  }
}

function appointHakem(room, seat, amount) {
  room.hakemSeat = seat;
  room.bidAmount = amount;
  room.kittyReveal = [...room.kitty];
  room.hands[seat] = sortHand([...room.hands[seat], ...room.kitty]);
  room.kitty = [];
  room.state = 'kitty';
  room.bidding = null;
}

function startPlay(room) {
  room.state = 'playing';
  room.trick = { leaderSeat: room.hakemSeat, turnSeat: room.hakemSeat, cards: [], number: 1 };
}

function handHasSuit(hand, suit) {
  return hand.some((c) => c.suit === suit);
}

function resolveTrick(room) {
  const t = room.trick;
  const lead = t.cards[0].card.suit;
  const trump = room.trumpSuit;
  let best = t.cards[0];
  for (const entry of t.cards.slice(1)) {
    const c = entry.card;
    const bestIsTrump = best.card.suit === trump;
    const cIsTrump = c.suit === trump;
    if (cIsTrump && !bestIsTrump) best = entry;
    else if (cIsTrump && bestIsTrump && c.rank > best.card.rank) best = entry;
    else if (!cIsTrump && !bestIsTrump && c.suit === lead && c.rank > best.card.rank) best = entry;
  }
  const winnerSeat = best.seat;
  const wasCut = Boolean(
    trump
    && (
      (lead !== trump && best.card.suit === trump)
      || (lead === trump && best.card.suit === trump && best.card.rank > t.cards[0].card.rank)
    )
  );
  let pts = 5;
  for (const entry of t.cards) pts += cardBonus(entry.card);
  const isLastTrick = room.hands[0].length === 0 && room.hands[1].length === 0 && room.hands[2].length === 0 && room.hands[3].length === 0;
  if (isLastTrick) {
    for (const c of room.buried) pts += cardBonus(c);
  }
  const team = teamOf(winnerSeat);
  room.roundPoints[team] += pts;
  room.tricksWon[team] += 1;
  io.to(room.id).emit('trickResult', { winnerSeat, points: pts, cards: t.cards, trickNumber: t.number, wasCut });
  if (isLastTrick) {
    finalizeRound(room);
  } else {
    room.trick = { leaderSeat: winnerSeat, turnSeat: winnerSeat, cards: [], number: t.number + 1 };
  }
}

function finalizeRound(room) {
  const hakemTeam = teamOf(room.hakemSeat);
  const oppTeam = hakemTeam === 'A' ? 'B' : 'A';
  const pointsHakem = room.roundPoints[hakemTeam];
  const pointsOpp = room.roundPoints[oppTeam];
  const ROUND_TOTAL = pointsHakem + pointsOpp;
  const yasaThreshold = Math.ceil((ROUND_TOTAL * 85) / 165);
  let resultType, deltaHakem, deltaOpp;
  if (room.bidAmount === 165) {
    if (pointsHakem === 165 && pointsOpp === 0) {
      resultType = 'sarshelem-success';
      deltaHakem = 330;
      deltaOpp = -330;
    } else {
      resultType = 'sarshelem-fail';
      deltaHakem = -330;
      deltaOpp = 2 * pointsOpp;
    }
  } else if (pointsHakem === 165 && pointsOpp === 0) {
    resultType = 'shelem';
    deltaHakem = 165;
    deltaOpp = -165;
  } else if (pointsOpp >= yasaThreshold) {
    resultType = 'yasa';
    deltaOpp = 2 * pointsOpp;
    deltaHakem = -2 * room.bidAmount;
  } else if (pointsHakem >= room.bidAmount) {
    resultType = 'success';
    deltaHakem = pointsHakem;
    deltaOpp = pointsOpp;
  } else {
    resultType = 'fail';
    deltaHakem = -room.bidAmount;
    deltaOpp = pointsOpp;
  }
  room.scores[hakemTeam] += deltaHakem;
  room.scores[oppTeam] += deltaOpp;
  room.history.push({
    round: room.roundNo,
    hakemSeat: room.hakemSeat,
    hakemTeam,
    bid: room.bidAmount,
    pointsHakem,
    pointsOpp,
    resultType,
    deltaHakem,
    deltaOpp,
    scoreAfter: { ...room.scores },
  });
  room.state = 'roundEnd';
  room.trick = null;
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ clientId, name }) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return socket.emit('errorMsg', '\u0642\u0628\u0644 \u0627\u0632 \u0648\u0631\u0648\u062F\u060C \u0646\u0627\u0645 \u062E\u0648\u062F \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F');
    leaveOtherRooms(clientId, null, socket);
    let roomId = genId();
    while (rooms[roomId]) roomId = genId();
    const room = newRoom(roomId, clientId, name);
    room.players[0].socketId = socket.id;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = clientId;
    broadcast(room);
  });

  socket.on('joinRoom', ({ clientId, name, roomId }) => {
    name = String(name || '').trim().slice(0, 16);
    if (!name) return socket.emit('errorMsg', '\u0642\u0628\u0644 \u0627\u0632 \u0648\u0631\u0648\u062F\u060C \u0646\u0627\u0645 \u062E\u0648\u062F \u0631\u0627 \u0627\u0646\u062A\u062E\u0627\u0628 \u06A9\u0646\u06CC\u062F');
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '\u0631\u0648\u0645 \u067E\u06CC\u062F\u0627 \u0646\u0634\u062F');
    leaveOtherRooms(clientId, roomId, socket);
    let p = getPlayer(room, clientId);
    if (!p) {
      if (room.players.length >= 4) return socket.emit('errorMsg', '\u0631\u0648\u0645 \u067E\u0631 \u0627\u0633\u062A');
      const usedSeats = room.players.map((pl) => pl.seat);
      const seat = [0, 1, 2, 3].find((s) => !usedSeats.includes(s));
      p = { clientId, socketId: socket.id, name, seat, ready: false, connected: true };
      room.players.push(p);
    } else {
      const previousSocket = p.socketId && io.sockets.sockets.get(p.socketId);
      if (previousSocket && previousSocket.id !== socket.id) {
        previousSocket.leave(roomId);
        previousSocket.data.roomId = null;
        previousSocket.data.clientId = null;
        previousSocket.emit('leftRoom');
      }
      p.socketId = socket.id;
      p.connected = true;
      if (name) p.name = name;
    }
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = clientId;
    broadcast(room);
  });

  socket.on('swapSeats', ({ seatA, seatB }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (getPlayer(room, socket.data.clientId).clientId !== room.adminClientId) return;
    const pa = room.players.find((p) => p.seat === seatA);
    const pb = room.players.find((p) => p.seat === seatB);
    if (pa && pb) { pa.seat = seatB; pb.seat = seatA; }
    broadcast(room);
  });

  socket.on('setTeamName', ({ team, name }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    if (socket.data.clientId !== room.adminClientId) return;
    if (team === 'A' || team === 'B') room.teamNames[team] = String(name).slice(0, 20) || room.teamNames[team];
    broadcast(room);
  });

  socket.on('toggleReady', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    const p = getPlayer(room, socket.data.clientId);
    if (!p || p.clientId === room.adminClientId) return;
    p.ready = !p.ready;
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'lobby') return;
    if (socket.data.clientId !== room.adminClientId) return;
    if (room.players.length < 4) return;
    if (!room.players.every((p) => p.clientId === room.adminClientId || p.ready)) return;
    startDeal(room);
    broadcast(room);
  });

  socket.on('nextRound', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'roundEnd') return;
    if (socket.data.clientId !== room.adminClientId) return;
    room.dealerSeat = nextSeat(room.dealerSeat);
    startDeal(room);
    broadcast(room);
  });

  socket.on('placeBid', ({ amount }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'bidding' || !room.bidding) return;
    const p = getPlayer(room, socket.data.clientId);
    const b = room.bidding;
    if (!p || p.seat !== b.turnSeat) return;
    amount = parseInt(amount, 10);
    if (isNaN(amount) || amount % 5 !== 0 || amount < 100 || amount > 165) return;
    if (amount <= b.currentBid) return;
    b.currentBid = amount;
    b.currentBidderSeat = p.seat;
    if (amount === 165) {
      appointHakem(room, p.seat, amount);
      broadcast(room);
      return;
    }
    advanceBidTurn(room);
    finishBiddingIfNeeded(room);
    broadcast(room);
  });

  socket.on('passBid', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'bidding' || !room.bidding) return;
    const p = getPlayer(room, socket.data.clientId);
    const b = room.bidding;
    if (!p || p.seat !== b.turnSeat) return;
    b.active[p.seat] = false;
    const act = activeSeats(b);
    if (act.length >= 1) {
      let s = nextSeat(b.turnSeat);
      let guard = 0;
      while (!b.active[s] && guard < 4) { s = nextSeat(s); guard++; }
      b.turnSeat = s;
    }
    finishBiddingIfNeeded(room);
    broadcast(room);
  });

  socket.on('discardKitty', ({ cardIds }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'kitty') return;
    const p = getPlayer(room, socket.data.clientId);
    if (!p || p.seat !== room.hakemSeat) return;
    if (!Array.isArray(cardIds) || cardIds.length !== 4) return;
    const hand = room.hands[p.seat];
    const chosen = hand.filter((c) => cardIds.includes(c.id));
    if (chosen.length !== 4) return;
    room.hands[p.seat] = sortHand(hand.filter((c) => !cardIds.includes(c.id)));
    room.buried = chosen;
    room.kittyReveal = [];
    startPlay(room);
    broadcast(room);
  });

  socket.on('playCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.state !== 'playing' || !room.trick) return;
    const p = getPlayer(room, socket.data.clientId);
    if (!p || p.seat !== room.trick.turnSeat) return;
    const hand = room.hands[p.seat];
    const card = hand.find((c) => c.id === cardId);
    if (!card) return;
    const t = room.trick;
    if (t.cards.length > 0) {
      const lead = t.cards[0].card.suit;
      if (card.suit !== lead && handHasSuit(hand, lead)) return; // must follow suit
    } else if (t.number === 1) {
      room.trumpSuit = card.suit;
    }
    room.hands[p.seat] = hand.filter((c) => c.id !== cardId);
    t.cards.push({ seat: p.seat, card });
    if (t.cards.length < 4) {
      t.turnSeat = nextSeat(p.seat);
      broadcast(room);
    } else {
      broadcast(room);
      setTimeout(() => { resolveTrick(room); broadcast(room); }, 1200);
    }
  });

  socket.on('chatMessage', ({ text }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !text) return;
    const p = getPlayer(room, socket.data.clientId);
    if (!p) return;
    room.chat.push({ name: p.name, seat: p.seat, text: String(text).slice(0, 200), t: Date.now() });
    broadcast(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms[socket.data.roomId];
    const clientId = socket.data.clientId;
    if (room && clientId) {
      const roomId = room.id;
      socket.leave(roomId);
      removePlayerFromRoom(room, clientId);
      socket.data.roomId = null;
      socket.data.clientId = null;
      if (room.players.length === 0) delete rooms[roomId];
      else broadcast(room);
    }
    socket.emit('leftRoom');
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const p = getPlayer(room, socket.data.clientId);
    if (p) { p.connected = false; p.socketId = null; }
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('listening on 0.0.0.0:' + PORT));
