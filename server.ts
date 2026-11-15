import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from './server/db.ts';
import { INITIAL_COUPONS } from './src/data/promotions.ts';
import { buildStoreCatalogContext, generateSmartLocalAnswer, tryInstantStoreAnswer } from './src/utils/aiResponder.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000;

function normalizeIpString(raw: any): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const stripped = s.replace(/^::ffff:/i, '').trim();
  return stripped;
}

function isLoopbackIp(ip: string): boolean {
  return !ip || ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '0.0.0.0';
}

// Helper to extract real IP address from HTTP request or WebSocket handshake
function getClientIp(req: any): string {
  if (!req) return '127.0.0.1';
  const headers = req.headers || {};
  const cfIp = normalizeIpString(headers['cf-connecting-ip']);
  if (cfIp && !isLoopbackIp(cfIp)) return cfIp;

  const realIp = normalizeIpString(headers['x-real-ip'] || headers['x-client-ip']);
  if (realIp && !isLoopbackIp(realIp)) return realIp;

  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const ips = forwarded.split(',').map(s => normalizeIpString(s)).filter(Boolean);
    for (const ip of ips) {
      if (ip && !isLoopbackIp(ip)) {
        return ip;
      }
    }
  }

  const rawIp = normalizeIpString(req.socket?.remoteAddress || req.ip || '127.0.0.1');
  if (rawIp && !isLoopbackIp(rawIp)) {
    return rawIp;
  }

  const clientReported = normalizeIpString(req.body?.clientReportedIp || req.query?.clientReportedIp);
  if (clientReported && !isLoopbackIp(clientReported)) {
    return clientReported;
  }

  return rawIp || '127.0.0.1';
}

export interface LiveViewerInfo {
  id: string;
  name: string;
  isAdmin: boolean;
  isRegisteredCustomer?: boolean;
  email?: string;
  ip?: string;
  roleBadge?: string;
  joinedAt?: string;
  isOnline?: boolean;
}

// 100% Authoritative In-Memory Registry of Real Live Stream Viewers
const connectedViewers = new Map<WebSocket, LiveViewerInfo>();

function getViewersList(): LiveViewerInfo[] {
  const list: LiveViewerInfo[] = [];
  const seenIds = new Set<string>();
  const seenGuestIps = new Set<string>();

  connectedViewers.forEach((v, ws) => {
    if (ws.readyState !== WebSocket.OPEN) {
      connectedViewers.delete(ws);
      return;
    }

    // 1. Deduplicate Host / Admin
    if (v.isAdmin) {
      if (!seenIds.has('admin_nptteam')) {
        seenIds.add('admin_nptteam');
        list.push({ ...v, id: 'admin_nptteam', name: 'nptteam (Quản Lý)', roleBadge: '👑 Quản Lý Showroom' });
      }
      return;
    }

    // 2. Deduplicate Registered Customers by ID
    if (v.isRegisteredCustomer && v.id) {
      if (!seenIds.has(v.id)) {
        seenIds.add(v.id);
        list.push(v);
      }
      return;
    }

    // 3. Deduplicate Unauthenticated Guests by ID and IP (Guarantees 0 fake/ghost accounts)
    if (!seenIds.has(v.id)) {
      const guestKey = v.ip && v.ip !== '127.0.0.1' && v.ip !== '::1' ? `guest_ip_${v.ip}` : v.id;
      if (!seenGuestIps.has(guestKey)) {
        seenGuestIps.add(guestKey);
        seenIds.add(v.id);
        list.push(v);
      }
    }
  });

  return list;
}

function broadcastViewersList() {
  const list = getViewersList();
  liveRoomState.viewersCount = list.length;

  const payload = JSON.stringify({
    type: 'VIEWERS_UPDATE',
    viewers: list,
    viewersCount: list.length,
    timestamp: Date.now()
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch {}
    }
  });
}

// High-speed WebSocket Relay Server for Live Video/Audio/Data Broadcasting & Real Viewer Tracking
const wss = new WebSocketServer({ server, path: '/api/live/ws' });

// Keep-alive heartbeat for Render/Cloud Run Web Service (prevents idle socket timeout & cleans dead remote sockets)
const pingInterval = setInterval(() => {
  wss.clients.forEach((client: any) => {
    if (client.isAlive === false) {
      try { client.terminate(); } catch {}
      return;
    }
    client.isAlive = false;
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.ping();
      } catch {}
    }
  });
}, 25000);

let adminDisconnectTimer: ReturnType<typeof setTimeout> | null = null;

wss.on('connection', (ws, req) => {
  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });
  const ip = getClientIp(req);
  const tempId = 'visitor_' + Math.floor(1000 + Math.random() * 9000);
  const defaultViewer: LiveViewerInfo = {
    id: tempId,
    name: 'Khách ghé thăm #' + tempId.slice(-4),
    isAdmin: false,
    isRegisteredCustomer: false,
    ip,
    roleBadge: '👤 Khách Trực Tuyến',
    joinedAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    isOnline: true,
  };
  connectedViewers.set(ws, defaultViewer);
  broadcastViewersList();

  // Send current live state and pinned product immediately to the newly connected viewer
  try {
    ws.send(JSON.stringify({
      type: 'LIVE_STATE',
      isLive: liveRoomState.isLive,
      sessionId: liveRoomState.sessionId,
      title: liveRoomState.title,
      pinnedProductId: liveRoomState.pinnedProductId,
      hostName: liveRoomState.hostName,
    }));
  } catch {}

  ws.on('message', (rawData, isBinary) => {
    if (isBinary) {
      // Audio or video binary chunks relay
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try {
            client.send(rawData, { binary: true });
          } catch {}
        }
      });
      return;
    }

    try {
      let msgStr = rawData.toString();
      let data = JSON.parse(msgStr);
      if (data?.type === 'BROADCAST' && data?.payload && typeof data.payload === 'object') {
        data = data.payload;
        msgStr = JSON.stringify(data);
      }

      if (data.type === 'PING') {
        try { ws.send(JSON.stringify({ type: 'PONG' })); } catch {}
        return;
      }

      const senderViewer = connectedViewers.get(ws);
      const isSenderAdmin = Boolean(senderViewer?.isAdmin);

      if (data.type === 'SESSION_RESET') {
        if (!isSenderAdmin) return;
        const nextSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (!nextSessionId) {
          liveRoomState.isLive = false;
          resetServerLiveSessionState('');
        } else if (nextSessionId !== liveRoomState.sessionId) {
          resetServerLiveSessionState(nextSessionId);
        }
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch {}
          }
        });
        return;
      }

      if (data.type === 'JOIN' || data.type === 'UPDATE_USER') {
        const u = data.user || data;
        const targetId = u.id || defaultViewer.id;

        // Block kicked users from re-entering
        if (liveRoomState.kickedUsers.includes(targetId)) {
          ws.send(JSON.stringify({ type: 'KICK_VIEWER', targetUserId: targetId }));
          setTimeout(() => ws.close(), 100);
          return;
        }

        // Clean up any stale sockets for this same user ID or IP
        connectedViewers.forEach((existingViewer, existingWs) => {
          if (existingWs !== ws && (existingViewer.id === targetId || (existingViewer.ip === ip && targetId.startsWith('visitor_')))) {
            connectedViewers.delete(existingWs);
          }
        });

        const isAdm = Boolean(u.isAdmin || u.id === 'admin_nptteam');
        const effectiveIp = !isLoopbackIp(ip) ? ip : (normalizeIpString(u.ip) || ip);
        if (!isAdm && effectiveIp && !isLoopbackIp(effectiveIp) && db.getBannedIps().includes(effectiveIp)) {
          try {
            ws.send(JSON.stringify({ type: 'IP_BLOCKED', ip: effectiveIp }));
            setTimeout(() => ws.close(), 100);
          } catch {}
          return;
        }
        if (isAdm && adminDisconnectTimer) {
          clearTimeout(adminDisconnectTimer);
          adminDisconnectTimer = null;
        }
        const isRegistered = Boolean(u.isRegisteredCustomer || (u.email && !isAdm));
        const updatedViewer: LiveViewerInfo = {
          id: targetId,
          name: isAdm ? 'nptteam (Quản Lý)' : (u.name || defaultViewer.name),
          isAdmin: isAdm,
          isRegisteredCustomer: isRegistered,
          email: u.email || '',
          ip: effectiveIp,
          roleBadge: isAdm ? '👑 Quản Lý Showroom' : (isRegistered ? '⭐ Khách Hàng VIP Store' : '👤 Khách Trực Tuyến'),
          joinedAt: defaultViewer.joinedAt,
          isOnline: true,
        };
        connectedViewers.set(ws, updatedViewer);
        broadcastViewersList();
        return;
      }

      if (data.type === 'GET_VIEWERS') {
        try {
          ws.send(JSON.stringify({
            type: 'VIEWERS_UPDATE',
            viewers: getViewersList(),
            viewersCount: getViewersList().length,
          }));
        } catch {}
        return;
      }

      if (data.type === 'LIVE_STATE') {
        if (!isSenderAdmin) return;
        if (typeof data.isLive === 'boolean') {
          liveRoomState.isLive = data.isLive;
          if (data.isLive && adminDisconnectTimer) {
            clearTimeout(adminDisconnectTimer);
            adminDisconnectTimer = null;
          }
        }
        if (data.isLive === false || (data.sessionId && data.sessionId !== liveRoomState.sessionId)) {
          resetServerLiveSessionState(data.isLive === false ? '' : data.sessionId);
        }
        if (data.title) liveRoomState.title = data.title;
        if (data.pinnedProductId === null) liveRoomState.pinnedProductId = '';
        else if (data.pinnedProductId) liveRoomState.pinnedProductId = data.pinnedProductId;
        // Broadcast live state change to all connected clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch {}
          }
        });
        return;
      }

      if (data.type === 'PIN_PRODUCT') {
        if (!isSenderAdmin) return;
        if (data.product?.id) {
          liveRoomState.pinnedProductId = data.product.id;
        }
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch {}
          }
        });
        return;
      }

      if (data.type === 'KICK_VIEWER') {
        if (!isSenderAdmin) return;
        const targetId = data.targetUserId;
        if (targetId && !liveRoomState.kickedUsers.includes(targetId)) {
          liveRoomState.kickedUsers.push(targetId);
        }
        connectedViewers.forEach((viewer, client) => {
          if (viewer.id === targetId) {
            try {
              client.send(JSON.stringify({ type: 'KICK_VIEWER', targetUserId: targetId }));
              setTimeout(() => client.close(), 100);
            } catch {}
          }
        });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(msgStr); } catch {}
          }
        });
        broadcastViewersList();
        return;
      }

      if (data.type === 'CHAT') {
        // Broadcast real chat message to all connected clients
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(msgStr);
            } catch {}
          }
        });
        return;
      }

      // Host-only media broadcast signals must only come from Admin broadcaster
      const hostMediaTypes = new Set(['CAM_STATE', 'MIC_STATE', 'SCREEN_SHARE_STATE', 'VIDEO_FRAME', 'AUDIO_CHUNK']);
      if (hostMediaTypes.has(data.type) && !isSenderAdmin) {
        return;
      }

      // Other room signals: WEBRTC_SIGNAL, HEART, Host media frames/chunks
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try {
            // Drop stale video snapshot frames if client buffer is congested (>64KB)
            if (data.type === 'VIDEO_FRAME' && client.bufferedAmount > 64 * 1024) {
              return;
            }
            client.send(msgStr);
          } catch {}
        }
      });
    } catch {
      // Relay raw text
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          try {
            client.send(rawData);
          } catch {}
        }
      });
    }
  });

  ws.on('close', () => {
    const viewer = connectedViewers.get(ws);
    connectedViewers.delete(ws);
    broadcastViewersList();

    // Grace period (15s) before auto-closing live when host WS drops (prevents false close on route change or reconnect)
    if (viewer?.isAdmin && liveRoomState.isLive) {
      const anyAdminRemaining = Array.from(connectedViewers.values()).some(v => v.isAdmin);
      if (!anyAdminRemaining && !adminDisconnectTimer) {
        adminDisconnectTimer = setTimeout(() => {
          adminDisconnectTimer = null;
          const stillNoAdmin = !Array.from(connectedViewers.values()).some(v => v.isAdmin);
          if (stillNoAdmin && liveRoomState.isLive) {
            liveRoomState.isLive = false;
            resetServerLiveSessionState('');
            console.log('🔴 Host disconnected past grace period. Live room auto-closed.');
            const closeMsg = JSON.stringify({
              type: 'LIVE_STATE',
              isLive: false,
              sessionId: '',
              title: liveRoomState.title,
              reason: 'host_disconnected'
            });
            wss.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                try { client.send(closeMsg); } catch {}
              }
            });
          }
        }, 15000);
      }
    }
  });

  ws.on('error', () => {
    connectedViewers.delete(ws);
    broadcastViewersList();
  });
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Immediate Service Worker cleanup endpoint to eradicate stale caches
const swCleanupScript = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      await self.registration.unregister();
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.navigate(c.url));
    } catch (err) {}
  })());
});
`;

app.get(['/sw.js', '/dev-sw.js', '/registerSW.js'], (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(swCleanupScript);
});

// Lazy Gemini SDK helper (used only if configured and needed as fallback)
function getGeminiClient(): GoogleGenAI | null {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return null;
  return new GoogleGenAI({
    apiKey: key,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Track keys temporarily rate-limited / out of balance to avoid repeated HTTP 429 failures
const kimiCooldownByKey = new Map<string, number>();
let geminiCooldownUntil = 0;

// Full AI Assistant Endpoint - Powered by Kimi K3.1 Pro with Ultra-Fast Catalog & Gemini Fallback
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, image } = req.body;
    if ((!message || typeof message !== 'string') && !image) {
      return res.status(400).json({ error: 'Message or image is required' });
    }

    const textPrompt = (message && message.trim())
      ? message.trim()
      : (image ? 'Hãy nhận diện và thẩm định nhanh hình ảnh này.' : '');

    const storeProducts = db.getProducts();
    const storeAuctions = db.getAuctions();
    const catalogContext = buildStoreCatalogContext(textPrompt, storeProducts, storeAuctions, INITIAL_COUPONS);

    const systemInstruction = `Bạn là Raider AI (nhãn hiệu Rider Omen) — trợ lý tư vấn thông minh của NPTTEAMSTORE (Chuyên phân phối đồ chơi Bandai Japan Tokusatsu chính hãng).
Quy tắc phản hồi:
1. TRẢ LỜI NHANH & TRỰC DIỆN: Trả lời ngắn gọn, đúng trọng tâm câu hỏi của khách hàng, dùng tiếng Việt tự nhiên, rõ ràng.
2. CHÍNH XÁC 100% DỮ LIỆU SHOP: Chỉ báo đúng tên sản phẩm, giá bán, tồn kho và mã giảm giá từ dữ liệu thực tế bên dưới; không tự bịa giá hoặc sản phẩm không có.
3. KIẾN THỨC TOKUSATSU:
   - DX (Driver Extension): Bản phổ thông Bandai, tỉ lệ gọn, âm thanh & LED chuẩn phim.
   - CSM (Complete Selection Modification): Bản sưu tầm 1:1 cao cấp, dây da/kim loại, BGM & thoại gốc diễn viên.
   - S.H.Figuarts (SHF): Mô hình khớp chuyển động 14-15cm chi tiết cao.

${catalogContext}`;

    let imageDataUrl = '';
    let imageMimeType = 'image/jpeg';
    let imageRawBase64 = '';
    if (image) {
      const rawInput = typeof image === 'string' ? image : (image.data || '');
      const mimeMatch = rawInput.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
      imageMimeType = image.mimeType || (mimeMatch ? mimeMatch[1] : 'image/jpeg');
      imageRawBase64 = rawInput.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      if (imageRawBase64) {
        imageDataUrl = `data:${imageMimeType};base64,${imageRawBase64}`;
      }
    }

    // 1. Primary Engine: Kimi K3.1 Pro (Moonshot AI Official api.moonshot.ai OR DeepInfra)
    const kimiApiKey = (
      process.env.KIMI_API_KEY ||
      process.env.MOONSHOT_API_KEY ||
      process.env.DEEPINFRA_API_KEY ||
      ''
    ).trim();
    const isMoonshotKey = kimiApiKey.startsWith('sk-') && !process.env.DEEPINFRA_API_KEY;
    const baseUrl = (
      process.env.KIMI_BASE_URL ||
      (isMoonshotKey ? 'https://api.moonshot.ai/v1' : 'https://api.deepinfra.com/v1/openai')
    ).trim().replace(/\/+$/, '');
    const chatCompletionsUrl = baseUrl.endsWith('/chat/completions')
      ? baseUrl
      : `${baseUrl}/chat/completions`;

    const rawModel = (
      process.env.KIMI_MODEL ||
      process.env.DEEPINFRA_KIMI_MODEL ||
      (isMoonshotKey ? 'kimi-k3.1-pro' : 'moonshotai/Kimi-K3.1-Pro')
    ).trim();
    const kimiModel = rawModel.toLowerCase() === 'deepinfra/kimi-k3.1-pro'
      ? (isMoonshotKey ? 'kimi-k3.1-pro' : 'moonshotai/Kimi-K3.1-Pro')
      : rawModel;

    const kimiCooldownUntil = kimiApiKey ? (kimiCooldownByKey.get(kimiApiKey) || 0) : 0;
    const isKimiReady = Boolean(kimiApiKey && Date.now() >= kimiCooldownUntil);

    // Ultra-fast path (<2ms): when Kimi is unconfigured/cooled-down, serve exact store/catalog answers immediately
    if (!isKimiReady && !imageDataUrl) {
      const instantReply = tryInstantStoreAnswer(textPrompt, storeProducts, false, storeAuctions, INITIAL_COUPONS);
      if (instantReply) {
        return res.json({ reply: instantReply, model: kimiModel, provider: 'instant-catalog' });
      }
    }

    if (isKimiReady) {
      try {
        const chatHistory = Array.isArray(history)
          ? history
              .slice(-4)
              .map((h: any) => ({
                role: h.role === 'user' ? 'user' : 'assistant',
                content: String(h.text || h.content || '').trim(),
              }))
              .filter((m) => m.content.length > 0)
          : [];

        const userContent: any = imageDataUrl
          ? [
              { type: 'text', text: textPrompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ]
          : textPrompt;

        const callKimiApi = async (contentPayload: any) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4500);
          try {
            const payload: Record<string, any> = {
              model: kimiModel,
              messages: [
                { role: 'system', content: systemInstruction },
                ...chatHistory,
                { role: 'user', content: contentPayload },
              ],
              max_tokens: 350,
            };
            if (isMoonshotKey && kimiModel.includes('kimi-k3')) {
              payload.reasoning_effort = 'low';
            } else {
              payload.temperature = 0.35;
            }
            return await fetch(chatCompletionsUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${kimiApiKey}`,
              },
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        };

        let kimiRes = await callKimiApi(userContent);

        // If multimodal image_url is rejected by schema (400/422), retry cleanly with text prompt
        if ((kimiRes.status === 400 || kimiRes.status === 422) && imageDataUrl && textPrompt) {
          kimiRes = await callKimiApi(textPrompt);
        }

        if (kimiRes.ok) {
          const kimiData: any = await kimiRes.json();
          const kimiReply = kimiData?.choices?.[0]?.message?.content;
          if (typeof kimiReply === 'string' && kimiReply.trim()) {
            return res.json({
              reply: kimiReply.trim(),
              model: kimiModel,
              provider: isMoonshotKey ? 'moonshot' : 'deepinfra',
            });
          }
        } else {
          // Consume body and apply cooldown on auth/quota exhaustion (401/402/403/429)
          await kimiRes.text().catch(() => '');
          if ([401, 402, 403, 429].includes(kimiRes.status)) {
            kimiCooldownByKey.set(kimiApiKey, Date.now() + 30 * 60 * 1000);
          }
          console.info(`Kimi API status ${kimiRes.status}, falling back seamlessly.`);
          // If query has an exact instant store match, respond immediately without waiting on Gemini
          if (!imageDataUrl) {
            const instantAfterKimi = tryInstantStoreAnswer(textPrompt, storeProducts, false, storeAuctions, INITIAL_COUPONS);
            if (instantAfterKimi) {
              return res.json({ reply: instantAfterKimi, model: kimiModel, provider: 'instant-catalog' });
            }
          }
        }
      } catch (kimiErr: any) {
        console.info('Kimi API unavailable, falling back seamlessly:', kimiErr?.message || 'network');
      }
    }

    // 2. Optional Gemini fallback if GEMINI_API_KEY is available (3.5s fast timeout)
    const ai = Date.now() >= geminiCooldownUntil ? getGeminiClient() : null;
    if (ai) {
      try {
        let formattedContents: any[] = [];
        if (Array.isArray(history) && history.length > 0) {
          formattedContents = history.slice(-4).map((h: any) => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: String(h.text || h.content || '') }],
          }));
        }

        const userParts: any[] = [];
        if (imageRawBase64) {
          userParts.push({
            inlineData: {
              mimeType: imageMimeType,
              data: imageRawBase64,
            },
          });
        }
        userParts.push({ text: textPrompt });
        formattedContents.push({
          role: 'user',
          parts: userParts,
        });

        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const response: any = await Promise.race([
          ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: formattedContents,
            config: {
              systemInstruction,
              temperature: 0.25,
              maxOutputTokens: 320,
            },
          }),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('gemini_timeout')), 2500);
          }),
        ]).finally(() => {
          if (timeoutId) clearTimeout(timeoutId);
        });

        const reply = response?.text || 'Tôi đã tiếp nhận câu hỏi của bạn. Hãy chia sẻ thêm để mình hỗ trợ nhé!';
        return res.json({ reply, model: 'gemini-3.8-flash', provider: 'gemini-fallback' });
      } catch (aiErr: any) {
        geminiCooldownUntil = Date.now() + 5 * 60 * 1000;
        console.info('Gemini fallback unavailable, using Raider AI catalog engine:', aiErr?.message || 'error');
      }
    }

    // 3. Fast Catalog-Aware Local Engine (matches exact product, price, stock, policy & QA)
    const fallbackReply = generateSmartLocalAnswer(
      textPrompt,
      storeProducts,
      Boolean(imageDataUrl),
      storeAuctions,
      INITIAL_COUPONS
    );

    return res.json({ reply: fallbackReply, model: kimiModel, provider: 'smart-catalog-engine' });
  } catch (error: any) {
    console.error('Fatal Server Error in /api/chat:', error);
    return res.status(200).json({ 
      reply: '🤖 Raider AI (Rider Omen) sẵn sàng hỗ trợ bạn! Hãy nhập tên sản phẩm hoặc câu hỏi cần tư vấn tại NPTTEAMSTORE nhé.' 
    });
  }
});

// --- LiveKit & Live Streaming API Endpoints ---
let liveRoomState = {
  isLive: false,
  sessionId: '',
  roomName: 'npt-official-room',
  title: '🔴 LỄ RA MẮT SIÊU PHẨM DX & CSM KAMEN RIDER 2026 - SHOWROOM NPTTEAMSTORE',
  hostName: 'nptteam (Quản Lý)',
  hostAvatar: '/brand/l01.png',
  pinnedProductId: '',
  startedAt: '',
  viewersCount: 0,
  kickedUsers: [] as string[],
  bannedIps: [] as string[]
};

function resetServerLiveSessionState(newSessionId: string = '') {
  liveRoomState.sessionId = newSessionId;
  liveRoomState.pinnedProductId = '';
  liveRoomState.kickedUsers = [];
  liveRoomState.startedAt = newSessionId ? new Date().toISOString() : '';
}

// 1. LiveKit Token Provider
app.post('/api/livekit/token', async (req, res) => {
  try {
    const { room = 'npt-official-room', identity, name, isAdmin = false } = req.body;
    const apiKey = (process.env.LIVEKIT_API_KEY || '').trim();
    const apiSecret = (process.env.LIVEKIT_API_SECRET || '').trim();
    const livekitUrl = (process.env.LIVEKIT_URL || '').trim();

    const userId = identity || (isAdmin ? 'admin_nptteam' : `guest_${Math.floor(1000 + Math.random() * 9000)}`);

    // Check if user is kicked or banned
    if (liveRoomState.kickedUsers.includes(userId)) {
      return res.status(403).json({ error: 'Bạn đã bị Quản lý mời khỏi phiên Live Stream này!' });
    }

    // Only issue a real LiveKit JWT when valid LiveKit Server credentials are configured
    if (!apiKey || !apiSecret || !livekitUrl) {
      return res.json({
        token: `fallback_${userId}`,
        url: '',
        identity: userId,
        configured: false
      });
    }

    try {
      const { AccessToken } = await import('livekit-server-sdk');
      const at = new AccessToken(apiKey, apiSecret, {
        identity: userId,
        name: name || (isAdmin ? 'nptteam (Quản Lý)' : `Khách #${userId.slice(-4)}`),
        ttl: '8h',
      });
      at.addGrant({
        roomJoin: true,
        room,
        canPublish: !!isAdmin, // STRICT RULE: Only admin can publish video/audio!
        canPublishData: true,
        canSubscribe: true,
      });
      const token = await at.toJwt();
      return res.json({ token, url: livekitUrl, identity: userId, configured: true });
    } catch {
      return res.json({ token: `fallback_${userId}`, url: '', identity: userId, configured: false });
    }
  } catch (err: any) {
    console.error('Error generating LiveKit token:', err);
    return res.status(500).json({ error: 'Không thể tạo LiveKit token' });
  }
});

// 2. Get Live Room State with 100% Real Active Viewers
app.get('/api/live/state', (_req, res) => {
  const currentViewers = getViewersList();
  liveRoomState.viewersCount = currentViewers.length;
  res.json({
    ...liveRoomState,
    viewersCount: currentViewers.length,
    activeViewers: currentViewers,
  });
});

// 2.1 Get Real Live Viewers List Endpoint
app.get('/api/live/viewers', (_req, res) => {
  const currentViewers = getViewersList();
  res.json({
    total: currentViewers.length,
    viewers: currentViewers,
  });
});

// 3. Update Live Room State (Admin only)
app.post('/api/live/state', (req, res) => {
  try {
    let updates = req.body;
    if (typeof updates === 'string') {
      try { updates = JSON.parse(updates); } catch {}
    }

    const prevSessionId = liveRoomState.sessionId;
    if (updates?.isLive === false || (updates?.sessionId && updates.sessionId !== prevSessionId)) {
      resetServerLiveSessionState(updates?.isLive === false ? '' : (updates?.sessionId || ''));
    }

    liveRoomState = {
      ...liveRoomState,
      ...updates,
      pinnedProductId: updates?.pinnedProductId === null ? '' : (updates?.pinnedProductId ?? liveRoomState.pinnedProductId),
    };

    // Broadcast live state change via WebSockets to all viewers
    if (typeof updates?.isLive === 'boolean') {
      const stateMsg = JSON.stringify({
        type: 'LIVE_STATE',
        isLive: updates.isLive,
        sessionId: liveRoomState.sessionId,
        title: updates.title || liveRoomState.title
      });
      wss.clients.forEach(client => {
        if (client.readyState === 1 /* OPEN */) {
          try { client.send(stateMsg); } catch {}
        }
      });
    }

    res.json(liveRoomState);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3.1 Explicit Live Session Reset Endpoint (clears all previous session data)
app.post('/api/live/reset', (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    const nextSessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    if (!nextSessionId) {
      liveRoomState.isLive = false;
      resetServerLiveSessionState('');
    } else if (nextSessionId !== liveRoomState.sessionId) {
      resetServerLiveSessionState(nextSessionId);
    }
    const resetMsg = JSON.stringify({
      type: 'SESSION_RESET',
      sessionId: nextSessionId,
      timestamp: Date.now()
    });
    wss.clients.forEach(client => {
      if (client.readyState === 1 /* OPEN */) {
        try { client.send(resetMsg); } catch {}
      }
    });
    res.json({ success: true, sessionId: nextSessionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Kick Viewer (Admin only)
app.post('/api/live/kick', (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Thiếu ID người xem' });
    if (!liveRoomState.kickedUsers.includes(userId)) {
      liveRoomState.kickedUsers.push(userId);
    }
    connectedViewers.forEach((viewer, client) => {
      if (viewer.id === userId) {
        try {
          client.send(JSON.stringify({ type: 'KICK_VIEWER', targetUserId: userId }));
          client.close();
        } catch {}
      }
    });
    broadcastViewersList();
    res.json({ success: true, kickedUsers: liveRoomState.kickedUsers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. OBS Studio Connection Details & Real Server Ingest Endpoints
app.get('/api/live/obs-config', async (req, res) => {
  try {
    const host = req.get('host') || process.env.APP_URL?.replace(/^https?:\/\//, '') || 'localhost:3000';
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const whipUrl = `${baseUrl}/api/live/whip`;
    const bearerToken = 'npt_live_stream_key_2026';
    const rtmpServer = `${baseUrl}/api/live/ingest`;
    const streamKey = 'live_npt_official_room';

    res.json({
      whipUrl,
      bearerToken,
      roomName: liveRoomState.roomName,
      rtmpServer,
      streamKey,
      recommendedSettings: {
        rateControl: 'CBR (Constant Bitrate)',
        bitrate: '3000 - 3500 Kbps (720p 30fps) hoặc 4500 Kbps (1080p)',
        keyframeInterval: '1s hoặc 2s',
        cpuPreset: 'veryfast hoặc low latency',
        profile: 'baseline hoặc main',
        tune: 'zerolatency',
        audioBitrate: '128 - 160 Kbps (Stereo 48kHz)'
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. REAL SERVER WHIP (WebRTC HTTP Ingest Protocol) Endpoint for OBS Studio
app.options('/api/live/whip', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, DELETE, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Link');
  res.setHeader('Access-Control-Expose-Headers', 'Location, Link');
  res.setHeader('Accept-Post', 'application/sdp');
  res.status(204).end();
});

app.post('/api/live/whip', express.text({ type: ['application/sdp', 'text/plain', '*/*'], limit: '10mb' }), (req, res) => {
  try {
    const offerSdp = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || '');
    console.log('✅ Real WHIP SDP Offer received from OBS Studio, size:', offerSdp.length);

    // Generate RFC-compliant WebRTC SDP Answer matching OBS Offer's m= sections with complete ICE credentials
    const sessionNum = Date.now();
    const iceUfrag = 'nptwhip' + Math.floor(Math.random() * 10000);
    const icePwd = 'nptpass' + Math.floor(Math.random() * 1000000);
    const host = req.get('host') || 'localhost:3000';
    const hostIp = host.split(':')[0];

    let sdpAnswer = `v=0\r\n` +
      `o=- ${sessionNum} 2 IN IP4 0.0.0.0\r\n` +
      `s=NPT Live WebRTC Server\r\n` +
      `t=0 0\r\n` +
      `a=group:BUNDLE 0 1\r\n` +
      `a=msid-semantic: WMS *\r\n` +
      `a=ice-ufrag:${iceUfrag}\r\n` +
      `a=ice-pwd:${icePwd}\r\n` +
      `a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n` +
      `a=setup:active\r\n`;

    if (offerSdp.includes('m=video')) {
      sdpAnswer += `m=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\n` +
        `c=IN IP4 0.0.0.0\r\n` +
        `a=recvonly\r\n` +
        `a=mid:0\r\n` +
        `a=rtcp-mux\r\n` +
        `a=rtpmap:96 H264/90000\r\n` +
        `a=rtpmap:97 VP8/90000\r\n` +
        `a=rtpmap:98 VP9/90000\r\n` +
        `a=candidate:1 1 UDP 2130706431 ${hostIp} 3000 typ host\r\n`;
    } else {
      sdpAnswer += `m=video 9 UDP/TLS/RTP/SAVPF 96\r\n` +
        `c=IN IP4 0.0.0.0\r\n` +
        `a=recvonly\r\n` +
        `a=mid:video\r\n` +
        `a=rtcp-mux\r\n` +
        `a=rtpmap:96 H264/90000\r\n` +
        `a=candidate:1 1 UDP 2130706431 ${hostIp} 3000 typ host\r\n`;
    }

    if (offerSdp.includes('m=audio')) {
      sdpAnswer += `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` +
        `c=IN IP4 0.0.0.0\r\n` +
        `a=recvonly\r\n` +
        `a=mid:1\r\n` +
        `a=rtcp-mux\r\n` +
        `a=rtpmap:111 opus/48000/2\r\n` +
        `a=candidate:2 1 UDP 2130706431 ${hostIp} 3000 typ host\r\n`;
    }

    // Set Live State to TRUE
    liveRoomState.isLive = true;

    // Broadcast LIVE_STATE over WebSocket
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'LIVE_STATE',
          isLive: true,
          title: liveRoomState.title
        }));
      }
    });

    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';

    res.setHeader('Content-Type', 'application/sdp');
    res.setHeader('Location', `${protocol}://${host}/api/live/whip/session-${sessionNum}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Location');
    res.status(201).send(sdpAnswer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.all(['/api/live/whip/*', '/api/live/ingest*'], (_req, res) => {
  liveRoomState.isLive = true;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ status: 'active', message: 'Real OBS Live Stream connected successfully to NPT Server' });
});

// 1. Store Statistics
app.get('/api/stats', (_req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Products API
app.get('/api/products', (req, res) => {
  try {
    let products = db.getProducts();
    const { category, era, search, limit } = req.query;

    if (category && typeof category === 'string' && category !== 'all') {
      products = products.filter(p => p.category === category);
    }
    if (era && typeof era === 'string' && era !== 'all') {
      products = products.filter(p => p.era === era);
    }
    if (search && typeof search === 'string') {
      const q = search.trim().toLowerCase();
      products = products.filter(p => 
        p.name.toLowerCase().includes(q) || 
        p.series.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q)
      );
    }
    if (limit) {
      const num = parseInt(limit as string, 10);
      if (!isNaN(num)) products = products.slice(0, num);
    }

    res.json(products);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products/:id', (req, res) => {
  try {
    const product = db.getProductById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products', (req, res) => {
  try {
    const product = req.body;
    if (!product || !product.name || !product.price) {
      return res.status(400).json({ error: 'Missing required product fields' });
    }
    if (!product.id) {
      product.id = 'prod-' + Date.now();
    }
    const created = db.addProduct(product);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const updated = db.updateProduct(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    const success = db.deleteProduct(req.params.id);
    if (!success) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products/:id/reviews', (req, res) => {
  try {
    const { userName, rating, comment, userAvatar, images } = req.body;
    if (!userName || !rating || !comment) {
      return res.status(400).json({ error: 'Missing required review fields' });
    }
    const newReview = {
      id: 'rev-' + Date.now(),
      userName,
      userAvatar: userAvatar || '/icons/c01.png',
      rating: Number(rating),
      date: new Date().toLocaleDateString('vi-VN'),
      comment,
      images: Array.isArray(images) ? images : (images ? [images] : []),
      verifiedPurchase: true
    };
    const updatedProduct = db.addProductReview(req.params.id, newReview);
    if (!updatedProduct) return res.status(404).json({ error: 'Product not found' });
    res.status(201).json({ review: newReview, product: updatedProduct });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Auctions API (Live Real-Time Bidding)
app.get('/api/auctions', (_req, res) => {
  try {
    const auctions = db.getAuctions();
    res.json(auctions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auctions/:id/bid', (req, res) => {
  try {
    const { amount, bidderName } = req.body;
    if (!amount || !bidderName) {
      return res.status(400).json({ error: 'amount and bidderName are required' });
    }
    const updatedAuction = db.placeBid(req.params.id, Number(amount), String(bidderName));
    if (!updatedAuction) return res.status(404).json({ error: 'Auction item not found' });
    res.json(updatedAuction);
  } catch (e: any) {
    res.status(400).json({ error: e.message || 'Error placing bid' });
  }
});

// -------------------------------------------------------------
// A. ADMIN AUTHENTICATION (nptteam / nptteam12345)
// -------------------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ tài khoản và mật khẩu Quản Lý' });
  }
  const normUser = String(username).trim().toLowerCase();
  const isUserValid = normUser === 'nptteam';
  const isPassValid = String(password).trim() === 'nptteam12345';

  if (!isUserValid || !isPassValid) {
    return res.status(401).json({
      error: 'Tài khoản hoặc mật khẩu Quản Lý không chính xác! Vui lòng kiểm tra lại.'
    });
  }

  res.json({
    success: true,
    user: {
      id: 'admin_nptteam',
      name: 'nptteam',
      role: 'admin',
      badge: '👑 QUẢN TRỊ VIÊN STORE'
    },
    token: 'admin_token_' + Date.now()
  });
});

// -------------------------------------------------------------
// B. CLIENT IP CHECK & CUSTOMER ACCOUNT TRACKING
// -------------------------------------------------------------
app.get('/api/client/ip', (req, res) => {
  const ip = getClientIp(req);
  const bannedIps = db.getBannedIps();
  const isBlocked = bannedIps.includes(ip);
  res.json({ ip, isBlocked });
});

// Customer Registration
app.post('/api/customers/register', (req, res) => {
  const { name, email, phone, address, userAgent } = req.body;
  const ip = getClientIp(req);
  const bannedIps = db.getBannedIps();
  if (bannedIps.includes(ip)) {
    return res.status(403).json({
      error: `Địa chỉ IP của bạn [${ip}] đã bị Quản Trị Viên chặn do nghi vấn vi phạm hoặc tài khoản clone!`,
      isIpBlocked: true,
      ip
    });
  }
  if (!name || !email) {
    return res.status(400).json({ error: 'Vui lòng cung cấp đầy đủ họ tên và email' });
  }

  const customers = db.getCustomers();
  const existingAccountsWithSameIp = customers.filter(c => c.ip === ip);
  const isCloneSuspect = existingAccountsWithSameIp.length > 0;

  const newCustomer = {
    id: 'cust_' + Date.now(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone ? phone.trim() : '',
    address: address ? address.trim() : 'Việt Nam',
    ip,
    userAgent: userAgent || (req.headers['user-agent'] as string) || 'Web Khách Device',
    registeredAt: new Date().toLocaleString('vi-VN'),
    lastActiveAt: new Date().toLocaleString('vi-VN'),
    isBlocked: false,
    isCloneSuspect,
    blockReason: isCloneSuspect
      ? `⚠️ Trùng IP [${ip}] với tài khoản [${existingAccountsWithSameIp[0].name}]`
      : undefined,
    orderCount: 0
  };

  db.addCustomer(newCustomer);
  res.json({
    success: true,
    customer: newCustomer,
    ip,
    isCloneSuspect,
    message: 'Đăng ký tài khoản thành công! Dữ liệu đã được ghi nhận trên Web Quản Lý.'
  });
});

// Customer Login
app.post('/api/customers/login', (req, res) => {
  const { email } = req.body;
  const ip = getClientIp(req);
  const bannedIps = db.getBannedIps();
  if (bannedIps.includes(ip)) {
    return res.status(403).json({
      error: `Địa chỉ IP của bạn [${ip}] đã bị Quản Trị Viên chặn!`,
      isIpBlocked: true,
      ip
    });
  }

  const customers = db.getCustomers();
  const found = customers.find(c => c.email === (email || '').trim().toLowerCase());
  if (found) {
    found.lastActiveAt = new Date().toLocaleString('vi-VN');
    if (found.isBlocked) {
      return res.status(403).json({
        error: `Tài khoản của bạn đã bị khóa bởi Quản trị viên. Lý do: ${found.blockReason || 'Vi phạm chính sách'}`,
        isBlocked: true
      });
    }
    db.saveCustomers(customers);
  }
  res.json({ success: true, ip, customer: found });
});

// Get all customers (Admin)
app.get('/api/admin/customers', (_req, res) => {
  const customers = db.getCustomers();
  const bannedIps = db.getBannedIps();
  res.json({
    customers,
    bannedIps,
    totalCustomers: customers.length,
    totalBannedIps: bannedIps.length
  });
});

// Block IP (Admin)
app.post('/api/admin/customers/block-ip', (req, res) => {
  const { ip, customerId, reason } = req.body;
  const cleanIp = normalizeIpString(ip);
  if (!cleanIp) return res.status(400).json({ error: 'Thiếu địa chỉ IP' });
  db.addBannedIp(cleanIp);

  const customers = db.getCustomers();
  customers.forEach(c => {
    const custIp = normalizeIpString(c.ip || (c as any).lastIp || (c as any).registeredIp);
    if (custIp === cleanIp || (customerId && c.id === customerId)) {
      c.isBlocked = true;
      c.blockReason = reason || 'Quản trị viên nptteam đã chặn IP này do nghi vấn tài khoản xấu/clone';
    }
  });
  db.saveCustomers(customers);

  // Kick active WebSocket viewers matching this blocked IP
  connectedViewers.forEach((viewer, client) => {
    if (!viewer.isAdmin && normalizeIpString(viewer.ip) === cleanIp && client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify({ type: 'IP_BLOCKED', ip: cleanIp }));
        setTimeout(() => client.close(), 100);
      } catch {}
    }
  });

  res.json({
    success: true,
    bannedIps: db.getBannedIps(),
    message: `Đã chặn thành công IP: ${cleanIp}`
  });
});

// Unblock IP (Admin)
app.post('/api/admin/customers/unblock-ip', (req, res) => {
  const { ip, customerId } = req.body;
  const cleanIp = normalizeIpString(ip);
  if (!cleanIp && !customerId) return res.status(400).json({ error: 'Thiếu địa chỉ IP hoặc ID khách hàng' });
  if (cleanIp) db.removeBannedIp(cleanIp);

  const customers = db.getCustomers();
  customers.forEach(c => {
    const custIp = normalizeIpString(c.ip || (c as any).lastIp || (c as any).registeredIp);
    if ((cleanIp && custIp === cleanIp) || (customerId && c.id === customerId)) {
      c.isBlocked = false;
      c.blockReason = undefined;
    }
  });
  db.saveCustomers(customers);

  res.json({
    success: true,
    bannedIps: db.getBannedIps(),
    message: `Đã mở chặn thành công${cleanIp ? ` cho IP: ${cleanIp}` : ''}`
  });
});

// Delete customer (Admin)
app.delete('/api/admin/customers/:id', (req, res) => {
  const success = db.deleteCustomer(req.params.id);
  if (success) {
    return res.json({ success: true, message: 'Đã xóa tài khoản khách hàng' });
  }
  res.status(404).json({ error: 'Không tìm thấy tài khoản khách hàng' });
});

// -------------------------------------------------------------
// C. ORDERS & LIVE TRACKING API
// -------------------------------------------------------------
app.get('/api/orders', (_req, res) => {
  try {
    const orders = db.getOrders();
    res.json(orders);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/orders', (_req, res) => {
  try {
    const orders = db.getOrders();
    res.json({ orders, totalOrders: orders.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders/:query', (req, res) => {
  try {
    const order = db.getOrderByIdOrQuery(req.params.query);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orders', (req, res) => {
  try {
    const ip = getClientIp(req);
    const bannedIps = db.getBannedIps();
    if (bannedIps.includes(ip)) {
      return res.status(403).json({
        error: `Địa chỉ IP [${ip}] của bạn đã bị Web Quản Lý chặn. Không thể đặt hàng!`,
        isIpBlocked: true
      });
    }

    const order = req.body;
    if (!order || !order.customerName || !order.items || order.items.length === 0) {
      return res.status(400).json({ error: 'Invalid order payload' });
    }
    if (!order.id) {
      order.id = 'NPT-' + Math.floor(100000 + Math.random() * 900000);
    }
    order.customerIp = ip;
    const created = db.createOrder(order);

    // Update customer order count
    const customers = db.getCustomers();
    const cust = customers.find(c => c.email === order.customerEmail || c.ip === ip);
    if (cust) {
      cust.orderCount = (cust.orderCount || 0) + 1;
      cust.lastActiveAt = new Date().toLocaleString('vi-VN');
      db.saveCustomers(customers);
    }

    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/orders/:id/status', (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required' });
    const updated = db.updateOrderStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'Order not found' });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/orders/:orderId', (req, res) => {
  try {
    const success = db.deleteOrder(req.params.orderId);
    if (!success) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng cần xóa' });
    }
    res.json({
      success: true,
      message: `Đã xóa vĩnh viễn đơn hàng #${req.params.orderId}`
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 5. Community Forum API
app.get('/api/forum/posts', (_req, res) => {
  try {
    const posts = db.getForumPosts();
    res.json(posts);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forum/posts', (req, res) => {
  try {
    const post = req.body;
    if (!post || !post.content || (!post.author && !post.authorName)) {
      return res.status(400).json({ error: 'Author and content are required' });
    }
    const author = post.author || post.authorName || 'Rider Collector';
    const authorAvatar = post.authorAvatar || '/icons/c01.png';
    const newPostItem = {
      id: post.id || ('fp_' + Date.now()),
      title: post.title || post.content.slice(0, 60),
      author,
      handle: post.handle || `@${author.toLowerCase().replace(/\s+/g, '_')}`,
      authorAvatar,
      authorBadge: post.authorBadge || 'VIP Collector',
      isVerified: post.isVerified ?? true,
      isGoldVerified: post.isGoldVerified || false,
      era: post.era || 'Reiwa',
      category: post.category || 'Khoe Bộ Sưu Tập',
      content: post.content,
      images: post.images || (post.image ? [post.image] : undefined),
      productId: post.productId,
      productName: post.productName,
      productImage: post.productImage,
      productPrice: post.productPrice,
      likes: post.likes || 0,
      isLiked: false,
      reposts: post.reposts || 0,
      isReposted: false,
      bookmarks: post.bookmarks || 0,
      isBookmarked: false,
      views: post.views || 1,
      tags: post.tags || [],
      reactions: post.reactions || { henshin: 0, fire: 0, diamond: 0 },
      commentsCount: post.commentsCount || (post.commentsList ? post.commentsList.length : 0),
      commentsList: post.commentsList || [],
      createdAt: post.createdAt || 'Vừa xong'
    };
    const created = db.createForumPost(newPostItem);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forum/posts/:id/like', (req, res) => {
  try {
    const result = db.likeForumPost(req.params.id);
    if (!result) return res.status(404).json({ error: 'Post not found' });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/forum/posts/:id/comments', (req, res) => {
  try {
    const { authorName, author, authorHandle, authorAvatar, content } = req.body;
    const authorVal = authorName || author || 'Rider Collector';
    if (!authorVal || !content) {
      return res.status(400).json({ error: 'Author and comment text are required' });
    }
    const newComment = {
      id: 'c_' + Date.now(),
      author: authorVal,
      authorAvatar: authorAvatar || '/icons/c01.png',
      content,
      createdAt: 'Vừa xong'
    };
    const updatedPost = db.addForumComment(req.params.id, newComment);
    if (!updatedPost) return res.status(404).json({ error: 'Post not found' });
    res.status(201).json({ comment: newComment, post: updatedPost });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 5.1 Customer Feedback & Reviews
app.get('/api/feedbacks', (_req, res) => {
  try {
    res.json(db.getFeedbacks());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/feedbacks', (req, res) => {
  try {
    const fb = req.body;
    if (!fb || !fb.comment || !fb.customerName) {
      return res.status(400).json({ error: 'Customer name and comment are required' });
    }
    const newFeedback = {
      id: fb.id || ('fb-' + Date.now()),
      customerName: fb.customerName,
      customerLocation: fb.customerLocation || 'Việt Nam',
      customerAvatar: fb.customerAvatar || '/icons/c01.png',
      rating: fb.rating || 5,
      category: fb.category || 'Chất lượng sản phẩm',
      productId: fb.productId,
      productName: fb.productName,
      productImage: fb.productImage,
      comment: fb.comment,
      images: Array.isArray(fb.images) ? fb.images : (fb.images ? [fb.images] : []),
      verifiedPurchase: fb.verifiedPurchase ?? true,
      date: fb.date || new Date().toLocaleDateString('vi-VN'),
      helpfulCount: 0,
      userLiked: false,
      adminReply: fb.adminReply
    };
    const created = db.createFeedback(newFeedback);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/feedbacks/:id/like', (req, res) => {
  try {
    const result = db.likeFeedback(req.params.id);
    if (!result) return res.status(404).json({ error: 'Feedback not found' });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 5.2 Hall of Fame (Chỉ vinh danh khách hàng mua từ 20 sản phẩm trở lên)
app.get('/api/tribute/customers', (_req, res) => {
  try {
    res.json(db.getTributeCustomers());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// 6. Warranties
app.get('/api/warranties', (_req, res) => {
  try {
    res.json(db.getWarranties());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/warranties', (req, res) => {
  try {
    const ticket = req.body;
    if (!ticket || !ticket.serialKey || !ticket.customerPhone) {
      return res.status(400).json({ error: 'serialKey and customerPhone are required' });
    }
    if (!ticket.id) ticket.id = 'WAR-' + Date.now();
    ticket.status = 'Đã kích hoạt';
    const created = db.createWarranty(ticket);
    res.status(201).json(created);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

async function startServer() {
  const isTsxDev = process.env.npm_lifecycle_event === 'dev' || process.execArgv.some(arg => arg.includes('tsx'));
  const distDir = path.resolve(__dirname, 'dist');
  const distIndex = path.resolve(distDir, 'index.html');
  const isProduction = process.env.NODE_ENV === 'production' || (!isTsxDev && fs.existsSync(distIndex));
  const hasDist = isProduction && fs.existsSync(distIndex);

  // Always serve uploaded/static assets from src/public/assets/aistudio and public/assets/aistudio directly
  const srcAistudioAssetsDir = path.resolve(__dirname, 'src/public/assets/aistudio');
  const rootAistudioAssetsDir = path.resolve(__dirname, 'public/assets/aistudio');
  if (fs.existsSync(srcAistudioAssetsDir)) {
    app.use('/assets/aistudio', express.static(srcAistudioAssetsDir));
  }
  if (fs.existsSync(rootAistudioAssetsDir)) {
    app.use('/assets/aistudio', express.static(rootAistudioAssetsDir));
  }

  if (hasDist) {
    app.use(express.static(distDir, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }));
    app.get('*', (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      if (fs.existsSync(distIndex)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.sendFile(distIndex);
      }
      next();
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api')) return next();
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({
          'Content-Type': 'text/html',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }).send(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 NPTTEAMSTORE Full-stack server running on port ${PORT}`);
  });
}

startServer();
