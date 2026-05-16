/**
 * Chronicles of Fate — TRPG Server
 * Node.js + WebSocket (ws) + Gemini API proxy
 *
 * npm install ws
 * node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════
//  방 상태 관리
// ═══════════════════════════════════════
const rooms = new Map();
// roomId → {
//   hostApiKey: string,       ← 절대 클라이언트에 전송 안 함
//   gmStyle: string,
//   scenario: string,
//   players: Map<ws, {id, name, cls, color, isHost}>,
//   history: [],              ← Gemini 대화 히스토리
//   currentTurnIdx: number,
//   pendingActions: [],
//   roundCount: number,
//   waitingGM: boolean,
// }

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getRoomSafeInfo(room) {
  // API 키 제외한 방 정보
  return {
    gmStyle: room.gmStyle,
    scenario: room.scenario,
    playerCount: room.players.size,
  };
}

function getPlayerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    cls: p.cls,
    color: p.color,
    isHost: p.isHost,
  }));
}

function broadcast(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const [ws, p] of room.players) {
    if (ws !== excludeWs && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ═══════════════════════════════════════
//  Gemini API 호출 (서버에서만)
// ═══════════════════════════════════════
const GM_STYLE_DESC = {
  epic:    '서사적이고 웅장한 판타지 소설처럼 묘사하라. 영웅적 어조, 생생한 장면 묘사.',
  horror:  '공포와 긴장감을 조성하라. 어둠, 불안, 미지의 공포를 강조. 암울한 분위기.',
  comedy:  '유쾌하고 엉뚱한 상황을 만들어라. 예상치 못한 코믹한 반전을 넣어라.',
  mystery: '단서와 수수께끼를 중심으로 전개하라. 플레이어가 추리하게 만들어라.',
  sandbox: '플레이어의 선택을 존중하고 자유로운 탐험을 돕는 중립적 서술.',
};

function buildSystemPrompt(room) {
  const party = [...room.players.values()].map(p => `- ${p.name} (${p.cls})`).join('\n');
  return `너는 뛰어난 TRPG 게임 마스터(GM)야. 반드시 한국어로 진행한다.

【세계관/시나리오】
${room.scenario}

【파티 구성】
${party}

【GM 스타일】
${GM_STYLE_DESC[room.gmStyle] || GM_STYLE_DESC.epic}

【규칙】
- 묘사는 2~4문단, 생생하고 몰입감 있게 써라.
- 플레이어 행동의 결과를 공정하게 서술하라.
- 주사위 결과가 언급되면 수치에 맞게 성공/실패를 반영하라 (높은 수치=성공, 낮은 수치=실패/예상 밖 결과).
- 가끔 긴장감 있는 선택지나 위기 상황을 만들어라.
- 절대 플레이어 대신 행동을 결정하지 마라.
- GM의 서술만 출력하라. 메타 코멘트 없이.`;
}

async function callGemini(room, userMsg) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${room.hostApiKey}`;
  const contents = [...room.history, { role: 'user', parts: [{ text: userMsg }] }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemPrompt(room) }] },
      contents,
      generationConfig: { temperature: 0.92, maxOutputTokens: 900 },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '(응답 없음)';

  room.history.push({ role: 'user', parts: [{ text: userMsg }] });
  room.history.push({ role: 'model', parts: [{ text: reply }] });
  if (room.history.length > 40) room.history = room.history.slice(-40);

  return reply;
}

async function gmNarrate(roomId, prompt) {
  const room = rooms.get(roomId);
  if (!room || room.waitingGM) return;
  room.waitingGM = true;

  // 타이핑 인디케이터 ON
  broadcastAll(room, { type: 'gm_typing', on: true });

  try {
    const reply = await callGemini(room, prompt);
    broadcastAll(room, { type: 'gm_typing', on: false });
    broadcastAll(room, { type: 'gm_message', text: reply });
  } catch (e) {
    broadcastAll(room, { type: 'gm_typing', on: false });
    broadcastAll(room, { type: 'system_msg', text: `❌ GM 오류: ${e.message}` });
  }

  room.waitingGM = false;
}

// ═══════════════════════════════════════
//  턴 관리
// ═══════════════════════════════════════
function getCurrentTurnPlayer(room) {
  const list = [...room.players.values()];
  return list[room.currentTurnIdx % list.length] || null;
}

function advanceTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const total = room.players.size;
  room.currentTurnIdx = (room.currentTurnIdx + 1) % total;
  const cur = getCurrentTurnPlayer(room);
  if (cur) {
    broadcastAll(room, { type: 'turn_change', playerId: cur.id, playerName: cur.name, color: cur.color });
  }
}

// ═══════════════════════════════════════
//  HTTP 서버 (index.html 서빙)
// ═══════════════════════════════════════
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ═══════════════════════════════════════
//  WebSocket 서버
// ═══════════════════════════════════════
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.playerId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── 방 만들기 (방장) ──
    if (msg.type === 'create_room') {
      const { apiKey, scenario, gmStyle, name, cls, color } = msg;
      if (!apiKey || !name) return send(ws, { type: 'error', text: 'API 키와 이름이 필요합니다.' });

      const roomId = makeRoomId();
      const playerId = 'host_' + Date.now();
      const room = {
        hostApiKey: apiKey,
        scenario: scenario || '고대의 악이 깨어나는 판타지 세계. 선택받은 영웅들이 운명에 맞서 모험을 떠난다.',
        gmStyle: gmStyle || 'epic',
        players: new Map(),
        history: [],
        currentTurnIdx: 0,
        pendingActions: [],
        roundCount: 0,
        waitingGM: false,
      };
      room.players.set(ws, { id: playerId, name, cls: cls || '전사', color: color || '#c9a84c', isHost: true });
      rooms.set(roomId, room);

      ws.roomId = roomId;
      ws.playerId = playerId;

      send(ws, {
        type: 'room_created',
        roomId,
        playerId,
        players: getPlayerList(room),
        scenario: room.scenario,
        gmStyle: room.gmStyle,
        currentTurnPlayerId: getCurrentTurnPlayer(room)?.id,
      });

      console.log(`[방 생성] ${roomId} — 방장: ${name}`);
    }

    // ── 방 참가 ──
    else if (msg.type === 'join_room') {
      const { roomId, name, cls, color } = msg;
      const room = rooms.get(roomId?.toUpperCase());
      if (!room) return send(ws, { type: 'error', text: '방을 찾을 수 없습니다.' });
      if (room.players.size >= 6) return send(ws, { type: 'error', text: '방이 가득 찼습니다. (최대 6명)' });

      const playerId = 'p_' + Date.now();
      room.players.set(ws, { id: playerId, name, cls: cls || '전사', color: color || '#4a90d9', isHost: false });
      ws.roomId = roomId.toUpperCase();
      ws.playerId = playerId;

      // 기존 멤버에게 알림
      broadcast(room, { type: 'player_joined', player: { id: playerId, name, cls, color, isHost: false } }, ws);

      // 새 플레이어에게 현재 상태 전달
      send(ws, {
        type: 'room_joined',
        roomId: ws.roomId,
        playerId,
        players: getPlayerList(room),
        scenario: room.scenario,
        gmStyle: room.gmStyle,
        currentTurnPlayerId: getCurrentTurnPlayer(room)?.id,
      });

      broadcastAll(room, { type: 'system_msg', text: `✦ ${name}이(가) 파티에 합류했습니다.` });
      console.log(`[참가] ${ws.roomId} — ${name}`);
    }

    // ── 게임 시작 (방장만) ──
    else if (msg.type === 'start_game') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const me = room.players.get(ws);
      if (!me?.isHost) return send(ws, { type: 'error', text: '방장만 게임을 시작할 수 있습니다.' });
      if (room.players.size < 1) return;

      broadcastAll(room, { type: 'game_started', players: getPlayerList(room) });

      // 첫 턴 알림
      const first = getCurrentTurnPlayer(room);
      if (first) broadcastAll(room, { type: 'turn_change', playerId: first.id, playerName: first.name, color: first.color });

      // GM 오프닝
      const party = [...room.players.values()].map(p => `${p.name}(${p.cls})`).join(', ');
      const firstPlayer = [...room.players.values()][0];
      const openingPrompt = `게임을 시작한다. 파티(${party})가 처음 만나는 오프닝 장면을 극적으로 묘사하라. 세계와 상황을 소개하고, 첫 번째 플레이어 ${firstPlayer.name}에게 행동을 요청하라.`;
      gmNarrate(ws.roomId, openingPrompt);
    }

    // ── 플레이어 행동 ──
    else if (msg.type === 'player_action') {
      const room = rooms.get(ws.roomId);
      if (!room || room.waitingGM) return;
      const me = room.players.get(ws);
      if (!me) return;

      const cur = getCurrentTurnPlayer(room);
      if (!cur || cur.id !== me.id) {
        return send(ws, { type: 'error', text: '지금은 당신의 차례가 아닙니다.' });
      }

      const text = (msg.text || '').trim();
      if (!text) return;

      // 전체에게 행동 브로드캐스트
      broadcastAll(room, {
        type: 'player_message',
        playerId: me.id,
        playerName: me.name,
        playerCls: me.cls,
        color: me.color,
        text,
      });

      room.pendingActions.push({ playerId: me.id, playerName: me.name, playerCls: me.cls, text });

      // 다음 턴으로
      room.currentTurnIdx = (room.currentTurnIdx + 1) % room.players.size;
      const nextPlayer = getCurrentTurnPlayer(room);
      broadcastAll(room, { type: 'turn_change', playerId: nextPlayer?.id, playerName: nextPlayer?.name, color: nextPlayer?.color });

      // 한 바퀴 완료 → GM 반응
      if (room.pendingActions.length >= room.players.size) {
        room.roundCount++;
        const summary = room.pendingActions.map(a => `${a.playerName}(${a.playerCls}): ${a.text}`).join('\n');
        room.pendingActions = [];
        const gmPrompt = `라운드 ${room.roundCount} 파티 행동:\n${summary}\n\n위 행동들의 결과를 서술하고 이야기를 진행시켜라. 마지막에 ${nextPlayer?.name}에게 다음 행동을 유도하라.`;
        gmNarrate(ws.roomId, gmPrompt);
      } else {
        broadcastAll(room, { type: 'system_msg', text: `— ${nextPlayer?.name}의 차례 —` });
      }
    }

    // ── 주사위 ──
    else if (msg.type === 'roll_dice') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const me = room.players.get(ws);
      if (!me) return;
      const dices = [4, 6, 8, 10, 12, 20];
      const d = dices[Math.floor(Math.random() * dices.length)];
      const result = Math.floor(Math.random() * d) + 1;
      broadcastAll(room, { type: 'dice_result', playerName: me.name, color: me.color, dice: `d${d}`, result });
    }

    // ── 채팅 (OOC) ──
    else if (msg.type === 'chat') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const me = room.players.get(ws);
      if (!me) return;
      const text = (msg.text || '').slice(0, 300);
      if (!text) return;
      broadcastAll(room, { type: 'chat_msg', playerName: me.name, color: me.color, text });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const me = room.players.get(ws);
    if (!me) return;
    room.players.delete(ws);
    broadcastAll(room, { type: 'player_left', playerId: me.id, playerName: me.name });
    broadcastAll(room, { type: 'system_msg', text: `✦ ${me.name}이(가) 파티를 떠났습니다.` });
    if (room.players.size === 0) {
      rooms.delete(ws.roomId);
      console.log(`[방 삭제] ${ws.roomId}`);
    }
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, () => {
  console.log(`\n✦ Chronicles of Fate 서버 가동 중`);
  console.log(`  → http://localhost:${PORT}\n`);
});
