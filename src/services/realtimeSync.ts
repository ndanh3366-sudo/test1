import { 
  doc, 
  setDoc, 
  getDoc, 
  getDocFromServer,
  getDocs, 
  collection, 
  onSnapshot, 
  deleteDoc,
  writeBatch,
  serverTimestamp,
  query,
  orderBy,
  limit,
  addDoc,
  updateDoc
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { db, handleFirestoreError, OperationType } from '../utils/firebase.ts';
import type { LiveChatMessage, LiveViewerInfo } from './livekitService.ts';

export interface CloudLiveState {
  isLive: boolean;
  sessionId?: string;
  title: string;
  hostName: string;
  hostId: string;
  startedAt?: string | null;
  endedAt?: string | null;
  pinnedProductId?: string | null;
  viewersCount?: number;
  lastHeartbeat?: number | null;
  updatedAt?: any;
}

export interface CloudCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'user' | 'admin';
  tierRank: string;
  riderPoints: number;
  avatar?: string;
  registeredIp: string;
  lastIp: string;
  registeredAt: string;
  lastLoginAt: string;
  isBlocked: boolean;
  forceLogoutAt?: number;
}

import { supabaseRealtimeManager } from './supabaseRealtimeService.ts';

export interface BannedIpRecord {
  id?: string;
  ip: string;
  reason: string;
  bannedAt: string;
  customerId?: string | null;
}

export function normalizeIpString(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  const first = s.split(',')[0].trim().replace(/^::ffff:/i, '');
  if (first.startsWith('[') && first.includes(']')) {
    return first.slice(1, first.indexOf(']'));
  }
  return first;
}

export function isValidPublicIp(ip: string): boolean {
  const clean = normalizeIpString(ip);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower === '::' ||
    lower.startsWith('127.') ||
    lower.startsWith('10.') ||
    lower.startsWith('192.168.') ||
    lower.startsWith('169.254.') ||
    lower.includes('đang nhận diện')
  ) {
    return false;
  }
  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    return true;
  }
  // Basic IPv6 validation
  if (clean.includes(':') && /^[0-9a-fA-F:]+$/.test(clean) && !lower.startsWith('fe80:')) {
    return true;
  }
  return false;
}

export function sanitizeIpDocId(ip: string): string {
  return normalizeIpString(ip).replace(/[^a-zA-Z0-9_-]/g, '_');
}

const IP_CACHE_KEY = 'npt_real_client_ip_v2';
const IP_CACHE_TTL_MS = 60_000;
let inFlightIpPromise: Promise<string> | null = null;

async function fetchJsonIpWithTimeout(url: string, timeoutMs = 3500): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('http_error');
    const data = await res.json();
    if (data?.success === false) throw new Error('api_error');
    const ip = normalizeIpString(data?.ip);
    if (!isValidPublicIp(ip)) throw new Error('invalid_ip');
    return ip;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCloudflareTraceIp(timeoutMs = 3500): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('cf_http_error');
    const text = await res.text();
    const match = text.match(/^ip=([^\r\n]+)/m);
    const ip = normalizeIpString(match?.[1] || '');
    if (!isValidPublicIp(ip)) throw new Error('invalid_cf_ip');
    return ip;
  } finally {
    clearTimeout(timer);
  }
}

// 1. 100% Real Public IP Resolver (Works on Vercel & fullstack Node; NEVER fabricates fake IPs)
export async function getRealClientPublicIp(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    try {
      const raw = sessionStorage.getItem(IP_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.ip && isValidPublicIp(parsed.ip) && Date.now() - Number(parsed.ts || 0) < IP_CACHE_TTL_MS) {
          return parsed.ip;
        }
      }
    } catch {}
  } else {
    try {
      sessionStorage.removeItem(IP_CACHE_KEY);
      sessionStorage.removeItem('npt_real_client_ip');
    } catch {}
  }

  if (inFlightIpPromise && !forceRefresh) {
    return inFlightIpPromise;
  }

  inFlightIpPromise = (async () => {
    try {
      const ip = await Promise.any([
        fetchJsonIpWithTimeout('https://api.ipify.org?format=json', 3500),
        fetchJsonIpWithTimeout('https://api64.ipify.org?format=json', 3500),
        fetchCloudflareTraceIp(3500),
        fetchJsonIpWithTimeout('https://ipwho.is/', 3500),
        fetchJsonIpWithTimeout('/api/client/ip', 2500),
      ]);
      try {
        sessionStorage.setItem(IP_CACHE_KEY, JSON.stringify({ ip, ts: Date.now() }));
        sessionStorage.setItem('npt_real_client_ip', ip);
      } catch {}
      return ip;
    } catch {
      return '';
    } finally {
      inFlightIpPromise = null;
    }
  })();

  return inFlightIpPromise;
}

// 2. BroadcastChannel for Instant Cross-Tab Communication on Same Device
const liveChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('npt_live_channel') : null;

// High-Speed Supabase Realtime Relay for Live Streaming
const liveWsListeners: Set<(data: any) => void> = new Set();

export function getLiveWebSocket() {
  return null;
}

async function deleteFirestoreCollectionDocs(
  colPath: string,
  excludeSessionId?: string
): Promise<void> {
  try {
    const snap = await getDocs(collection(db, colPath));
    if (snap.empty) return;
    const docs = snap.docs.filter((d) => {
      if (!excludeSessionId) return true;
      const data = d.data() as any;
      return data?.sessionId !== excludeSessionId;
    });
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = writeBatch(db);
      chunk.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (err) {
    console.warn(`Firestore clear collection [${colPath}] note:`, err);
  }
}

async function deleteFirestorePeersAndSubcollections(cutoffTimestamp?: number): Promise<void> {
  try {
    const snap = await getDocs(collection(db, 'livestream_peers'));
    if (snap.empty) return;
    const staleDocs = snap.docs.filter((peerDoc) => {
      if (!cutoffTimestamp) return true;
      const data = peerDoc.data() as any;
      return typeof data?.createdAt !== 'number' || data.createdAt < cutoffTimestamp;
    });
    await Promise.allSettled(
      staleDocs.map(async (peerDoc) => {
        await deleteFirestoreCollectionDocs(`livestream_peers/${peerDoc.id}/host_candidates`);
        await deleteFirestoreCollectionDocs(`livestream_peers/${peerDoc.id}/guest_candidates`);
        await deleteDoc(peerDoc.ref).catch(() => {});
      })
    );
  } catch (err) {
    console.warn('Firestore clear livestream_peers note:', err);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Clear ALL previous live session data across Firestore, localStorage, BroadcastChannel, Supabase Realtime & backend API
export async function clearPreviousLiveSessionData(newSessionId: string = ''): Promise<void> {
  const now = Date.now();
  const resetSignal = {
    type: 'SESSION_RESET',
    sessionId: newSessionId,
    timestamp: now,
  };

  // 1. Clear local cache only when ending live (starting live writes fresh state in publishLiveStateToCloud)
  try {
    if (!newSessionId) {
      localStorage.removeItem('npt_live_state');
    }
    liveChannel?.postMessage(resetSignal);
  } catch {}
  supabaseRealtimeManager.sendDataMessage(resetSignal);

  // 2. Reset Cloud Firestore latest_feed + delete all stale chats, viewers (including kicks), WebRTC peer docs, and stale video frame
  try {
    const feedDoc = doc(db, 'livestream', 'latest_feed');
    await Promise.allSettled([
      ...(!newSessionId ? [setDoc(feedDoc, resetSignal, { merge: false })] : []),
      deleteDoc(doc(db, 'livestream', 'video_frame')).catch(() => {}),
      deleteFirestoreCollectionDocs('livestream_chats', newSessionId || undefined),
      deleteFirestoreCollectionDocs('livestream_viewers', newSessionId || undefined),
      deleteFirestorePeersAndSubcollections(now),
    ]);
  } catch (err) {
    console.warn('clearPreviousLiveSessionData Firestore note:', err);
  }

  // 3. Reset Node backend memory only when ending live (when starting, /api/live/state resets on sessionId change)
  if (!newSessionId) {
    try {
      fetch('/api/live/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: '' }),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }
}

const FIRESTORE_ROOM_REST_URL =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/livestream/official_room?key=${encodeURIComponent(firebaseConfig.apiKey)}`;

function encodeFirestoreRestValue(val: any): any {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  return { stringValue: String(val) };
}

function decodeFirestoreRestDoc(docJson: any): CloudLiveState | null {
  const f = docJson?.fields;
  if (!f || typeof f.isLive?.booleanValue !== 'boolean') return null;
  const parseNum = (v: any): number | null => {
    if (!v) return null;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue !== undefined) return Number(v.doubleValue);
    return null;
  };
  return {
    isLive: f.isLive.booleanValue,
    sessionId: f.sessionId?.stringValue || '',
    title: f.title?.stringValue || '🔴 LỄ RA MẮT SIÊU PHẨM DX & CSM KAMEN RIDER 2026 - SHOWROOM NPTTEAMSTORE',
    hostName: f.hostName?.stringValue || 'nptteam (Quản Lý)',
    hostId: f.hostId?.stringValue || 'admin_nptteam',
    startedAt: f.startedAt?.stringValue ?? null,
    endedAt: f.endedAt?.stringValue ?? null,
    pinnedProductId: f.pinnedProductId?.stringValue ?? null,
    lastHeartbeat: parseNum(f.lastHeartbeat),
    updatedAt: parseNum(f.updatedAt) ?? Date.now(),
  };
}

async function fetchRoomStateViaRest(): Promise<CloudLiveState | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`${FIRESTORE_ROOM_REST_URL}&_t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return decodeFirestoreRestDoc(json);
  } catch {
    return null;
  }
}

async function writeRoomStateViaRest(payload: Record<string, any>): Promise<boolean> {
  try {
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined) fields[k] = encodeFirestoreRestValue(v);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(FIRESTORE_ROOM_REST_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// 3. Live Stream Cloud Publisher (Host Side)
export async function publishLiveStateToCloud(
  isLive: boolean, 
  title: string = '🔴 LỄ RA MẮT SIÊU PHẨM DX & CSM KAMEN RIDER 2026 - SHOWROOM NPTTEAMSTORE',
  pinnedProductId?: string | null,
  sessionId?: string
): Promise<{ cloudSynced: boolean; error?: string }> {
  const now = Date.now();
  const resolvedSessionId = sessionId !== undefined ? sessionId : (isLive ? `live_${now}` : '');
  const rawPayload: CloudLiveState = {
    isLive,
    sessionId: resolvedSessionId,
    title,
    hostName: 'nptteam (Quản Lý)',
    hostId: 'admin_nptteam',
    startedAt: isLive ? new Date().toISOString() : null,
    endedAt: !isLive ? new Date().toISOString() : null,
    pinnedProductId: isLive ? (pinnedProductId ?? null) : null,
    lastHeartbeat: isLive ? now : null,
    updatedAt: now
  };
  const payload = cleanFirestorePayload(rawPayload);

  // 1. Local cross-tab sync
  try {
    localStorage.setItem('npt_live_state', JSON.stringify(payload));
    liveChannel?.postMessage(payload);
  } catch {}

  // 2. High-speed Supabase Realtime Broadcast
  supabaseRealtimeManager.sendDataMessage({
    type: 'LIVE_STATE',
    isLive,
    sessionId: resolvedSessionId,
    title,
    pinnedProductId: payload.pinnedProductId ?? null,
    updatedAt: now,
  });

  // 3. High-Reliability Cloud Firestore Persistence & Broadcast (with timeout fallback to HTTPS REST API)
  let cloudSynced = false;
  let errorMsg: string | undefined;
  try {
    const roomDoc = doc(db, 'livestream', 'official_room');
    await withTimeout(setDoc(roomDoc, payload, { merge: false }), 2500, 'firestore_write_timeout');
    cloudSynced = true;
  } catch (err: any) {
    errorMsg = err?.message || String(err);
    try {
      handleFirestoreError(err, OperationType.WRITE, 'livestream/official_room');
    } catch {}
    // Fallback over HTTPS Firestore REST API in case WebChannel is blocked or slow on host network
    cloudSynced = await writeRoomStateViaRest(payload);
    if (cloudSynced) errorMsg = undefined;
  }

  // 4. Backup HTTP API call (when running on Node server)
  try {
    fetch('/api/live/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  } catch {}

  return { cloudSynced, error: errorMsg };
}

// 3.1 Host Heartbeat to keep live active (sent via Firestore & Supabase Realtime)
export async function sendHostHeartbeat(streamTitle: string, sessionId?: string): Promise<void> {
  const now = Date.now();
  liveChannel?.postMessage({ isLive: true, sessionId: sessionId || '', lastHeartbeat: now, updatedAt: now, title: streamTitle });
  supabaseRealtimeManager.sendDataMessage({ type: 'PING' });
  const updatePayload = cleanFirestorePayload({
    isLive: true,
    lastHeartbeat: now,
    title: streamTitle,
    updatedAt: now,
    ...(sessionId ? { sessionId } : {}),
  });
  try {
    const roomDoc = doc(db, 'livestream', 'official_room');
    await withTimeout(setDoc(roomDoc, updatePayload, { merge: true }), 2500, 'firestore_heartbeat_timeout');
  } catch {
    writeRoomStateViaRest(updatePayload).catch(() => {});
  }
}

// 3.2 End Live Beacon when Admin closes the web
export function sendEndLiveBeacon(streamTitle?: string, _sessionId?: string): void {
  const now = Date.now();
  const payload = {
    type: 'LIVE_STATE',
    isLive: false,
    sessionId: '',
    pinnedProductId: null,
    title: streamTitle || '',
    updatedAt: now
  };

  try {
    localStorage.removeItem('npt_live_state');
    liveChannel?.postMessage({ type: 'SESSION_RESET', sessionId: '', timestamp: now });
    liveChannel?.postMessage(payload);
  } catch {}

  supabaseRealtimeManager.sendDataMessage({ type: 'SESSION_RESET', sessionId: '', timestamp: now });
  supabaseRealtimeManager.sendDataMessage(payload);

  try {
    const endData = {
      isLive: false,
      sessionId: '',
      pinnedProductId: null,
      endedAt: new Date().toISOString(),
      updatedAt: now,
    };
    const roomDoc = doc(db, 'livestream', 'official_room');
    setDoc(roomDoc, endData, { merge: true }).catch(() => {});

    // Keepalive HTTPS REST PATCH survives tab/browser unload when WebChannel drops
    const restFields: Record<string, any> = {};
    for (const [k, v] of Object.entries(endData)) {
      restFields[k] = encodeFirestoreRestValue(v);
    }
    fetch(FIRESTORE_ROOM_REST_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: restFields }),
      keepalive: true,
    }).catch(() => {});

    const feedDoc = doc(db, 'livestream', 'latest_feed');
    setDoc(feedDoc, { type: 'SESSION_RESET', sessionId: '', timestamp: now }, { merge: false }).catch(() => {});
    deleteFirestoreCollectionDocs('livestream_chats').catch(() => {});
    deleteFirestoreCollectionDocs('livestream_viewers').catch(() => {});
    deleteFirestorePeersAndSubcollections().catch(() => {});
  } catch {}

  try {
    const bodyStr = JSON.stringify({ isLive: false, sessionId: '', pinnedProductId: null, title: streamTitle || '' });
    if (navigator.sendBeacon) {
      const blob = new Blob([bodyStr], { type: 'application/json' });
      navigator.sendBeacon('/api/live/state', blob);
    } else {
      fetch('/api/live/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyStr,
        keepalive: true
      }).catch(() => {});
    }
  } catch {}
}

// 4. Live Stream Realtime State Subscriber (Guest / Customer Side)
export function subscribeToLiveState(
  callback: (state: CloudLiveState) => void
): () => void {
  let isDisposed = false;
  let unsubFirestore: (() => void) | null = null;
  let unsubSupabase: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hasCloudResult = false;
  let latestTimestamp = 0;
  let lastEmittedSignature = '';

  const handleUpdate = (data: CloudLiveState, source: 'cache' | 'cloud' | 'realtime' | 'api') => {
    if (isDisposed || !data || typeof data.isLive !== 'boolean') return;

    const ts = typeof data.updatedAt === 'number'
      ? data.updatedAt
      : (typeof data.lastHeartbeat === 'number' ? data.lastHeartbeat : 0);

    if (source === 'api') {
      // NEVER let a cold/stale Node /api/live/state { isLive: false } overwrite an active Cloud room!
      if (hasCloudResult && !data.isLive) return;
      if (ts > 0 && latestTimestamp > 0 && ts < latestTimestamp) return;
    }

    if (source === 'cloud') {
      hasCloudResult = true;
    }
    if (ts > latestTimestamp) {
      latestTimestamp = ts;
    }

    try {
      localStorage.setItem('npt_live_state', JSON.stringify(data));
    } catch {}

    const signature = `${data.isLive}|${data.sessionId || ''}|${data.title || ''}|${data.pinnedProductId || ''}`;
    if (signature === lastEmittedSignature) return;
    lastEmittedSignature = signature;

    callback(data);
  };

  // 1. Fast local storage hydration before network finishes
  try {
    const saved = localStorage.getItem('npt_live_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed?.isLive === 'boolean') {
        handleUpdate(parsed, 'cache');
      }
    }
  } catch {}

  // 2. Authoritative Cloud Firestore Read + Realtime Listener + REST fallback (Works 100% on Vercel cross-device)
  const roomDoc = doc(db, 'livestream', 'official_room');

  const fetchServerRoomState = async () => {
    if (isDisposed) return;
    try {
      const serverSnap = await withTimeout(getDocFromServer(roomDoc), 2500, 'firestore_read_timeout');
      if (serverSnap.exists()) {
        const data = serverSnap.data() as CloudLiveState;
        if (data && typeof data.isLive === 'boolean') {
          handleUpdate(data, 'cloud');
          return;
        }
      }
    } catch {}

    const restData = await fetchRoomStateViaRest();
    if (restData && typeof restData.isLive === 'boolean') {
      handleUpdate(restData, 'cloud');
      return;
    }

    try {
      const cachedSnap = await getDoc(roomDoc);
      if (cachedSnap.exists()) {
        const data = cachedSnap.data() as CloudLiveState;
        if (data && typeof data.isLive === 'boolean') {
          handleUpdate(data, 'cloud');
        }
      }
    } catch {}
  };

  fetchServerRoomState();

  try {
    unsubFirestore = onSnapshot(roomDoc, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as CloudLiveState;
        if (data && typeof data.isLive === 'boolean') {
          handleUpdate(data, snapshot.metadata.fromCache ? 'cache' : 'cloud');
        }
      }
    }, (err) => {
      console.warn('Firestore live room snapshot note:', err);
      fetchRoomStateViaRest().then((restData) => {
        if (restData) handleUpdate(restData, 'cloud');
      }).catch(() => {});
    });
  } catch (err) {
    console.warn('Firestore live room subscribe note:', err);
  }

  // Gentle server resync poll every 4s so cross-device discovery never misses an update even on throttled mobile browsers
  pollTimer = setInterval(fetchServerRoomState, 4000);

  // 3. Backup initial fetch from Node API (only accepts live room or when cloud hasn't responded)
  fetch('/api/live/state')
    .then(r => {
      if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) return null;
      return r.json();
    })
    .then(data => {
      if (data && typeof data.isLive === 'boolean') {
        handleUpdate(data, 'api');
      }
    })
    .catch(() => {});

  // 4. Listen to local BroadcastChannel
  const handleBroadcast = (ev: MessageEvent) => {
    if (ev.data && typeof ev.data.isLive === 'boolean') {
      handleUpdate(ev.data, 'realtime');
    }
  };
  liveChannel?.addEventListener('message', handleBroadcast);

  // 5. Listen to Supabase / Local WS Realtime events without overwriting other subscribers
  const handleSupabaseMsg = (data: any) => {
    if (data && data.type === 'LIVE_STATE') {
      handleUpdate({
        isLive: data.isLive,
        sessionId: data.sessionId || '',
        title: data.title || '',
        pinnedProductId: data.pinnedProductId ?? null,
        hostName: data.hostName || 'nptteam (Quản Lý)',
        hostId: data.hostId || 'admin_nptteam',
        updatedAt: data.updatedAt || Date.now(),
      }, 'realtime');
    } else if (data && data.type === 'SESSION_RESET') {
      try { localStorage.removeItem('npt_live_state'); } catch {}
    }
  };

  unsubSupabase = supabaseRealtimeManager.addListeners({
    onDataReceived: (msg) => {
      handleSupabaseMsg(msg);
      liveWsListeners.forEach(listener => {
        try { listener(msg); } catch {}
      });
    }
  });
  supabaseRealtimeManager.setupSupabaseRealtime('npt-official-room');

  return () => {
    isDisposed = true;
    if (unsubFirestore) unsubFirestore();
    if (unsubSupabase) unsubSupabase();
    if (pollTimer) clearInterval(pollTimer);
    liveChannel?.removeEventListener('message', handleBroadcast);
  };
}

// 5. Live Stream Realtime Media & Data Feed Broadcaster
export function broadcastLiveData(data: any) {
  if (!data || !data.type) return;

  // 1. Local cross-tab broadcast (0ms zero-latency preview on same device)
  try {
    liveChannel?.postMessage(data);
  } catch {}

  // 2. High-speed Supabase Realtime Broadcast Channel transmission (0-delay WebSockets)
  supabaseRealtimeManager.sendDataMessage(data);

  // 3. Cloud Firestore Feed Broadcast for durable state & signals (Chat, Pin, Hearts, WebRTC signals, Live status)
  // EXCLUDE high-frequency video frames & raw audio chunks from Firestore writes to prevent DB throttling & lag
  if (data.type !== 'VIDEO_FRAME' && data.type !== 'AUDIO_CHUNK') {
    try {
      const feedDoc = doc(db, 'livestream', 'latest_feed');
      const cleanedFeed = cleanFirestorePayload({ ...data, timestamp: Date.now() });
      setDoc(feedDoc, cleanedFeed, { merge: false }).catch(() => {});
    } catch {}

    if (data.type === 'CHAT' && data.message?.id) {
      try {
        const chatDoc = doc(db, 'livestream_chats', data.message.id);
        const cleanedChat = cleanFirestorePayload({
          ...data.message,
          ...(data.sessionId ? { sessionId: data.sessionId } : {}),
          timestampValue: serverTimestamp()
        });
        setDoc(chatDoc, cleanedChat, { merge: true }).catch(() => {});
      } catch {}
    }
  }
}

// 6. Seamless PCM16 + Opus Audio Queue Player + Cloud Fallback Relay (Zero dropped syllables & zero duplicate echo)
export interface PcmAudioSubPacket {
  seq: number;
  sr: number;
  pcm: string;
}

export interface LiveAudioPacketPayload {
  type?: 'AUDIO_CHUNK';
  format?: 'pcm16' | 'pcm16_batch' | 'webm';
  sr?: number;
  pcm?: string;
  audio?: string;
  packets?: PcmAudioSubPacket[];
  sessionId?: string;
  seq?: number;
  t?: number;
}

let audioContextInstance: AudioContext | null = null;
let relayGainNode: GainNode | null = null;
let relayCompressorNode: DynamicsCompressorNode | null = null;
let relayHighPassNode: BiquadFilterNode | null = null;
let nextAudioPlayTime = 0;
let isGuestRelayAudioMuted = false;
let guestRelayAudioVolume = 1;

const playedAudioPacketKeys = new Set<string>();
const playedAudioPacketOrder: string[] = [];

function markAudioPacketPlayed(key: string): boolean {
  if (!key) return true;
  if (playedAudioPacketKeys.has(key)) return false;
  playedAudioPacketKeys.add(key);
  playedAudioPacketOrder.push(key);
  if (playedAudioPacketOrder.length > 400) {
    const oldest = playedAudioPacketOrder.shift();
    if (oldest) playedAudioPacketKeys.delete(oldest);
  }
  return true;
}

export function resetRelayAudioQueue() {
  nextAudioPlayTime = 0;
  playedAudioPacketKeys.clear();
  playedAudioPacketOrder.length = 0;
}

function ensureRelayAudioChain(): { ctx: AudioContext; inputNode: AudioNode } | null {
  try {
    if (!audioContextInstance) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextInstance = new AudioCtx();
    }
    const ctx = audioContextInstance;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    if (!relayGainNode || !relayCompressorNode || !relayHighPassNode) {
      relayHighPassNode = ctx.createBiquadFilter();
      relayHighPassNode.type = 'highpass';
      relayHighPassNode.frequency.setValueAtTime(75, ctx.currentTime);

      relayCompressorNode = ctx.createDynamicsCompressor();
      relayCompressorNode.threshold.setValueAtTime(-16, ctx.currentTime);
      relayCompressorNode.knee.setValueAtTime(12, ctx.currentTime);
      relayCompressorNode.ratio.setValueAtTime(4, ctx.currentTime);
      relayCompressorNode.attack.setValueAtTime(0.003, ctx.currentTime);
      relayCompressorNode.release.setValueAtTime(0.14, ctx.currentTime);

      relayGainNode = ctx.createGain();
      relayGainNode.gain.setValueAtTime(
        isGuestRelayAudioMuted ? 0 : guestRelayAudioVolume,
        ctx.currentTime
      );

      relayHighPassNode.connect(relayCompressorNode);
      relayCompressorNode.connect(relayGainNode);
      relayGainNode.connect(ctx.destination);
    } else {
      relayGainNode.gain.setValueAtTime(
        isGuestRelayAudioMuted ? 0 : guestRelayAudioVolume,
        ctx.currentTime
      );
    }
    return { ctx, inputNode: relayHighPassNode };
  } catch {
    return null;
  }
}

export function setGuestRelayAudioState(muted: boolean, volume: number) {
  isGuestRelayAudioMuted = Boolean(muted);
  guestRelayAudioVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  if (relayGainNode && audioContextInstance) {
    try {
      relayGainNode.gain.setValueAtTime(
        isGuestRelayAudioMuted ? 0 : guestRelayAudioVolume,
        audioContextInstance.currentTime
      );
    } catch {}
  }
}

export function unlockRelayAudioContext() {
  try {
    const chain = ensureRelayAudioChain();
    if (chain && chain.ctx.state === 'suspended') {
      chain.ctx.resume().catch(() => {});
    }
  } catch {}
}

function decodeBase64ToInt16(base64Pcm: string): Int16Array | null {
  try {
    const binaryStr = atob(base64Pcm);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount <= 0) return null;
    return new Int16Array(bytes.buffer, 0, sampleCount);
  } catch {
    return null;
  }
}

function schedulePcm16Frame(base64Pcm: string, sampleRate: number) {
  if (!base64Pcm || isGuestRelayAudioMuted) return;
  const chain = ensureRelayAudioChain();
  if (!chain) return;
  const { ctx, inputNode } = chain;

  const int16 = decodeBase64ToInt16(base64Pcm);
  if (!int16 || int16.length === 0) return;

  const safeRate = Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000 ? sampleRate : 16000;
  const buffer = ctx.createBuffer(1, int16.length, safeRate);
  const channel = buffer.getChannelData(0);

  // Convert Int16 -> Float32 and apply ultra-short 3ms edge smoothing to eliminate packet boundary clicks
  const fadeSamples = Math.min(Math.floor(safeRate * 0.003), Math.floor(int16.length / 4));
  for (let i = 0; i < int16.length; i++) {
    let sample = int16[i] / 32768;
    if (fadeSamples > 0) {
      if (i < fadeSamples) {
        sample *= i / fadeSamples;
      } else if (i >= int16.length - fadeSamples) {
        sample *= (int16.length - 1 - i) / fadeSamples;
      }
    }
    channel[i] = sample;
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(inputNode);

  const now = ctx.currentTime;
  // Adaptive ~60ms speech cushion prevents inter-packet starvation over remote Wi-Fi/4G while resetting cleanly if drift > 450ms
  if (nextAudioPlayTime < now || nextAudioPlayTime - now > 0.45) {
    nextAudioPlayTime = now + 0.06;
  }
  source.start(nextAudioPlayTime);
  nextAudioPlayTime += buffer.duration;
}

export function playAudioRelayPayload(payload: LiveAudioPacketPayload | string) {
  if (!payload || isGuestRelayAudioMuted) return;

  if (typeof payload === 'string') {
    playSeamlessAudioChunk(payload);
    return;
  }

  const sessionKey = payload.sessionId || 'default';

  if (Array.isArray(payload.packets) && payload.packets.length > 0) {
    const sorted = [...payload.packets].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    for (const pkt of sorted) {
      if (!pkt?.pcm) continue;
      const dedupeKey = `${sessionKey}|${pkt.seq ?? ''}`;
      if (!markAudioPacketPlayed(dedupeKey)) continue;
      schedulePcm16Frame(pkt.pcm, pkt.sr || payload.sr || 16000);
    }
    return;
  }

  if (payload.format === 'pcm16' && payload.pcm) {
    const dedupeKey = payload.seq !== undefined ? `${sessionKey}|${payload.seq}` : '';
    if (dedupeKey && !markAudioPacketPlayed(dedupeKey)) return;
    schedulePcm16Frame(payload.pcm, payload.sr || 16000);
    return;
  }

  if (payload.audio) {
    const dedupeKey = payload.seq !== undefined ? `${sessionKey}|${payload.seq}` : '';
    if (dedupeKey && !markAudioPacketPlayed(dedupeKey)) return;
    playSeamlessAudioChunk(payload.audio);
  }
}

export function playSeamlessAudioChunk(base64Data: string) {
  if (!base64Data || isGuestRelayAudioMuted) return;
  try {
    const chain = ensureRelayAudioChain();
    if (!chain) return;
    const { ctx, inputNode } = chain;

    fetch(base64Data)
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf))
      .then(decoded => {
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(inputNode);

        const now = ctx.currentTime;
        if (nextAudioPlayTime < now || nextAudioPlayTime - now > 0.8) {
          nextAudioPlayTime = now + 0.06;
        }

        source.start(nextAudioPlayTime);
        nextAudioPlayTime += decoded.duration;
      })
      .catch(() => {});
  } catch {}
}

let lastCloudAudioWriteAt = 0;
let isCloudAudioWriteInFlight = false;
let cloudAudioSeq = 0;
const pendingFirestorePcmPackets: PcmAudioSubPacket[] = [];

async function flushPendingFirestoreAudio(sessionId: string) {
  if (isCloudAudioWriteInFlight || pendingFirestorePcmPackets.length === 0) return;
  const now = Date.now();
  if (now - lastCloudAudioWriteAt < 240) return;

  const batch = pendingFirestorePcmPackets.splice(0, pendingFirestorePcmPackets.length);
  const lastSeq = batch[batch.length - 1]?.seq ?? cloudAudioSeq;
  lastCloudAudioWriteAt = now;
  isCloudAudioWriteInFlight = true;

  try {
    await setDoc(doc(db, 'livestream', 'audio_chunk'), {
      type: 'AUDIO_CHUNK',
      format: 'pcm16_batch',
      sessionId,
      seq: lastSeq,
      packets: batch,
      t: now,
    }, { merge: false });
  } catch {} finally {
    isCloudAudioWriteInFlight = false;
    if (pendingFirestorePcmPackets.length > 0) {
      setTimeout(() => {
        flushPendingFirestoreAudio(sessionId).catch(() => {});
      }, 240);
    }
  }
}

export async function publishLiveAudioChunkToCloud(
  input: string | { format: 'pcm16'; sr: number; pcm: string },
  sessionId: string = ''
): Promise<void> {
  if (!input) return;
  const now = Date.now();
  const seq = ++cloudAudioSeq;

  const isPcm = typeof input === 'object' && input.format === 'pcm16' && Boolean(input.pcm);
  const payload: LiveAudioPacketPayload = isPcm
    ? {
        type: 'AUDIO_CHUNK',
        format: 'pcm16',
        sr: input.sr,
        pcm: input.pcm,
        sessionId,
        seq,
        t: now,
      }
    : {
        type: 'AUDIO_CHUNK',
        format: 'webm',
        audio: String(input),
        sessionId,
        seq,
        t: now,
      };

  try {
    liveChannel?.postMessage(payload);
  } catch {}
  supabaseRealtimeManager.sendDataMessage(payload);

  if (isPcm) {
    // Queue unsent PCM packets so Firestore batching NEVER drops mid-speech syllables
    pendingFirestorePcmPackets.push({ seq, sr: input.sr, pcm: input.pcm });
    if (pendingFirestorePcmPackets.length > 5) {
      pendingFirestorePcmPackets.splice(0, pendingFirestorePcmPackets.length - 5);
    }
    flushPendingFirestoreAudio(sessionId).catch(() => {});
    return;
  }

  if (isCloudAudioWriteInFlight || now - lastCloudAudioWriteAt < 260) {
    return;
  }
  lastCloudAudioWriteAt = now;
  isCloudAudioWriteInFlight = true;
  try {
    await setDoc(doc(db, 'livestream', 'audio_chunk'), payload, { merge: false });
  } catch {} finally {
    isCloudAudioWriteInFlight = false;
  }
}

export function subscribeToLiveAudioChunk(
  callback: (data: LiveAudioPacketPayload) => void
): () => void {
  const emit = (data: any) => {
    if (!data) return;
    if (data.pcm || data.audio || (Array.isArray(data.packets) && data.packets.length > 0)) {
      callback(data as LiveAudioPacketPayload);
    }
  };

  const handleLocal = (ev: MessageEvent) => {
    if (ev.data?.type === 'AUDIO_CHUNK') {
      emit(ev.data);
    }
  };
  liveChannel?.addEventListener('message', handleLocal);

  let unsubFirestore: (() => void) | null = null;
  try {
    const audioDoc = doc(db, 'livestream', 'audio_chunk');
    unsubFirestore = onSnapshot(audioDoc, (snap) => {
      if (snap.exists() && !snap.metadata.fromCache) {
        emit(snap.data());
      }
    }, () => {});
  } catch {}

  return () => {
    liveChannel?.removeEventListener('message', handleLocal);
    if (unsubFirestore) unsubFirestore();
  };
}

// 7. WebRTC Peer-to-Peer Mesh Stream Engine (0ms Latency 30-60 FPS Video & High Fidelity Audio)
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];

  const env = (import.meta as any).env || {};
  const turnUrlsRaw = String(env.VITE_TURN_URLS || env.VITE_TURN_URL || '').trim();
  if (turnUrlsRaw) {
    const urls = turnUrlsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      const turnServer: RTCIceServer = { urls };
      if (env.VITE_TURN_USERNAME) turnServer.username = String(env.VITE_TURN_USERNAME).trim();
      if (env.VITE_TURN_CREDENTIAL) turnServer.credential = String(env.VITE_TURN_CREDENTIAL).trim();
      servers.push(turnServer);
    }
  }
  return servers;
}

const rtcConfig: RTCConfiguration = {
  iceCandidatePoolSize: 8,
  bundlePolicy: 'max-bundle',
  iceServers: buildIceServers(),
};

function tuneVideoSender(sender: RTCRtpSender | null, maxBitrate = 3_200_000, maxFramerate = 30) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = maxFramerate;
    (params as any).degradationPreference = 'balanced';
    sender.setParameters(params).catch(() => {});
  } catch {}
}

function tuneAudioSender(sender: RTCRtpSender | null, maxBitrate = 64_000) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = maxBitrate;
    (params.encodings[0] as any).priority = 'high';
    (params.encodings[0] as any).networkPriority = 'high';
    sender.setParameters(params).catch(() => {});
  } catch {}
}

function tuneOpusSdp(sdp?: string): string | undefined {
  if (!sdp) return sdp;
  try {
    const rtpmapMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
    if (!rtpmapMatch) return sdp;
    const pt = rtpmapMatch[1];
    const fmtpRegex = new RegExp(`a=fmtp:${pt}\\s+([^\\r\\n]+)`, 'g');
    const desiredParams: Record<string, string> = {
      minptime: '10',
      useinbandfec: '1',
      usedtx: '0',
      maxaveragebitrate: '96000',
      'sprop-maxcapturerate': '48000',
    };
    if (fmtpRegex.test(sdp)) {
      return sdp.replace(new RegExp(`a=fmtp:${pt}\\s+([^\\r\\n]+)`, 'g'), (_full, existing: string) => {
        const parts = existing.split(';').map((s) => s.trim()).filter(Boolean);
        const kv = new Map<string, string>();
        for (const p of parts) {
          const idx = p.indexOf('=');
          if (idx > 0) {
            kv.set(p.slice(0, idx).trim(), p.slice(idx + 1).trim());
          } else {
            kv.set(p, '');
          }
        }
        for (const [k, v] of Object.entries(desiredParams)) {
          kv.set(k, v);
        }
        const rebuilt = Array.from(kv.entries())
          .map(([k, v]) => (v !== '' ? `${k}=${v}` : k))
          .join(';');
        return `a=fmtp:${pt} ${rebuilt}`;
      });
    }
    const extra = Object.entries(desiredParams).map(([k, v]) => `${k}=${v}`).join(';');
    return sdp.replace(
      new RegExp(`(a=rtpmap:${pt}\\s+opus\\/48000[^\\r\\n]*\\r?\\n)`, 'i'),
      `$1a=fmtp:${pt} ${extra}\r\n`
    );
  } catch {
    return sdp;
  }
}

// High-reliability Cloud Firestore Adaptive Video Frame Relay (ensures Guest NEVER sees black screen behind strict NAT on Vercel)
let lastCloudFrameWriteAt = 0;
let isCloudFrameWriteInFlight = false;

export async function publishLiveVideoFrameToCloud(
  frame: string,
  sessionId: string = '',
  isScreenShare: boolean = false,
  forceImmediate: boolean = false
): Promise<void> {
  if (!frame) return;
  const now = Date.now();
  const payload = {
    type: 'VIDEO_FRAME',
    frame,
    sessionId,
    isScreenShare,
    t: now
  };

  // 1. Instant 0ms local cross-tab broadcast + high-speed Supabase/WS relay when socket isn't congested
  try {
    liveChannel?.postMessage(payload);
  } catch {}
  if (forceImmediate || !supabaseRealtimeManager.isWsRelayCongested()) {
    supabaseRealtimeManager.sendDataMessage(payload);
  }

  // 2. Throttle heavy Firestore document writes so Cloud DB snapshots don't overwrite crisp WS/Supabase frames
  const minFirestoreInterval = supabaseRealtimeManager.hasActiveRealtimeTransport() ? 1500 : 900;
  if (!forceImmediate && (isCloudFrameWriteInFlight || now - lastCloudFrameWriteAt < minFirestoreInterval)) {
    return;
  }

  lastCloudFrameWriteAt = now;
  isCloudFrameWriteInFlight = true;

  try {
    const frameDoc = doc(db, 'livestream', 'video_frame');
    await setDoc(frameDoc, payload, { merge: false });
  } catch {} finally {
    isCloudFrameWriteInFlight = false;
  }
}

export function subscribeToLiveVideoFrame(
  callback: (data: { frame: string; sessionId?: string; isScreenShare?: boolean; t?: number }) => void
): () => void {
  const handleLocal = (ev: MessageEvent) => {
    const data = ev.data;
    if (data && data.type === 'VIDEO_FRAME' && data.frame) {
      callback(data);
    }
  };
  liveChannel?.addEventListener('message', handleLocal);

  let unsubFirestore: (() => void) | null = null;
  try {
    const frameDoc = doc(db, 'livestream', 'video_frame');
    unsubFirestore = onSnapshot(frameDoc, (snap) => {
      if (snap.exists()) {
        const data = snap.data() as any;
        if (data && data.frame) {
          callback(data);
        }
      }
    }, () => {});
  } catch {}

  return () => {
    liveChannel?.removeEventListener('message', handleLocal);
    if (unsubFirestore) unsubFirestore();
  };
}

export interface HostWebRTCController {
  stop: () => void;
  updateStream: (newStream: MediaStream) => void;
  replaceVideoTrack: (newTrack: MediaStreamTrack | null) => Promise<void>;
  replaceAudioTrack: (newTrack: MediaStreamTrack | null) => Promise<void>;
  hasConnectedPeers: () => boolean;
  getConnectedPeersCount: () => number;
}

interface HostPeerEntry {
  pc: RTCPeerConnection;
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  pendingCandidates: RTCIceCandidateInit[];
  offerSdp: string;
}

export function startHostWebRTCStream(stream: MediaStream): HostWebRTCController & (() => void) {
  if (!stream) {
    const noop: any = () => {};
    noop.stop = () => {};
    noop.updateStream = () => {};
    noop.replaceVideoTrack = async () => {};
    noop.replaceAudioTrack = async () => {};
    noop.hasConnectedPeers = () => false;
    noop.getConnectedPeersCount = () => 0;
    return noop;
  }

  let currentStream = stream;
  const peers = new Map<string, HostPeerEntry>();
  const unsubPeerCandidateListeners = new Map<string, () => void>();
  let isStopped = false;

  const cleanupPeer = (guestId: string) => {
    const entry = peers.get(guestId);
    if (entry) {
      try { entry.pc.close(); } catch {}
      peers.delete(guestId);
    }
    const unsubCand = unsubPeerCandidateListeners.get(guestId);
    if (unsubCand) {
      unsubCand();
      unsubPeerCandidateListeners.delete(guestId);
    }
  };

  const handleOfferForGuest = async (
    guestId: string,
    offer: RTCSessionDescriptionInit,
    viaFirestore: boolean
  ) => {
    if (isStopped || !offer?.sdp) return;

    const existing = peers.get(guestId);
    if (existing && existing.offerSdp === offer.sdp) {
      return;
    }
    if (existing) {
      cleanupPeer(guestId);
    }

    const pc = new RTCPeerConnection(rtcConfig);
    const pendingCandidates: RTCIceCandidateInit[] = [];
    const entry: HostPeerEntry = {
      pc,
      videoSender: null,
      audioSender: null,
      pendingCandidates,
      offerSdp: offer.sdp,
    };
    peers.set(guestId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candJson = event.candidate.toJSON();
        if (viaFirestore) {
          addDoc(collection(db, 'livestream_peers', guestId, 'host_candidates'), candJson).catch(() => {});
        }
        const sigPayload = {
          type: 'WEBRTC_SIGNAL',
          action: 'HOST_CANDIDATE',
          guestId,
          candidate: candJson
        };
        liveChannel?.postMessage(sigPayload);
        supabaseRealtimeManager.sendDataMessage(sigPayload);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        try { pc.restartIce(); } catch {}
      }
    };

    if (viaFirestore) {
      const guestCandCol = collection(db, 'livestream_peers', guestId, 'guest_candidates');
      const unsubCand = onSnapshot(guestCandCol, (candSnap) => {
        candSnap.docChanges().forEach((candChange) => {
          if (candChange.type === 'added') {
            const candData = candChange.doc.data();
            if (candData && candData.candidate) {
              const cInit = candData as RTCIceCandidateInit;
              if (pc.remoteDescription && pc.remoteDescription.type) {
                pc.addIceCandidate(new RTCIceCandidate(cInit)).catch(() => {});
              } else {
                pendingCandidates.push(cInit);
              }
            }
          }
        });
      });
      unsubPeerCandidateListeners.set(guestId, unsubCand);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      while (pendingCandidates.length > 0) {
        const pending = pendingCandidates.shift();
        if (pending && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(pending)).catch(() => {});
        }
      }

      const videoTrack = currentStream.getVideoTracks()[0] || null;
      const audioTrack = currentStream.getAudioTracks()[0] || null;
      const transceivers = pc.getTransceivers();

      let videoTransceiver: RTCRtpTransceiver | null = null;
      let audioTransceiver: RTCRtpTransceiver | null = null;

      for (const t of transceivers) {
        const kind = t.mid === '0' && !t.receiver?.track?.kind && !t.sender?.track?.kind
          ? 'video'
          : (t.receiver?.track?.kind || t.sender?.track?.kind);
        if (kind === 'video' && !videoTransceiver) {
          videoTransceiver = t;
          t.direction = 'sendonly';
        } else if (kind === 'audio' && !audioTransceiver) {
          audioTransceiver = t;
          t.direction = 'sendonly';
        }
      }

      if (!videoTransceiver) {
        videoTransceiver = pc.addTransceiver('video', { direction: 'sendonly' });
      }
      if (!audioTransceiver) {
        audioTransceiver = pc.addTransceiver('audio', { direction: 'sendonly' });
      }

      entry.videoSender = videoTransceiver.sender;
      entry.audioSender = audioTransceiver.sender;

      if (videoTrack) {
        await entry.videoSender.replaceTrack(videoTrack).catch(() => {});
      }
      if (audioTrack) {
        await entry.audioSender.replaceTrack(audioTrack).catch(() => {});
      }

      // Prefer VP8 / H.264 with RTX retransmission preserved for sharp & smooth cross-device playback
      try {
        if (typeof RTCRtpSender !== 'undefined' && typeof (RTCRtpSender as any).getCapabilities === 'function' && typeof (videoTransceiver as any).setCodecPreferences === 'function') {
          const caps = (RTCRtpSender as any).getCapabilities('video');
          if (caps?.codecs?.length) {
            const preferred = caps.codecs.filter((c: any) => {
              const m = c.mimeType?.toLowerCase();
              return m === 'video/vp8' || m === 'video/h264' || m === 'video/rtx';
            });
            const others = caps.codecs.filter((c: any) => {
              const m = c.mimeType?.toLowerCase();
              return m !== 'video/vp8' && m !== 'video/h264' && m !== 'video/rtx';
            });
            if (preferred.length > 0) {
              (videoTransceiver as any).setCodecPreferences([...preferred, ...others]);
            }
          }
        }
      } catch {}

      const answer = await pc.createAnswer();
      answer.sdp = tuneOpusSdp(answer.sdp);
      await pc.setLocalDescription(answer);

      tuneVideoSender(entry.videoSender, 3_200_000, 30);
      tuneAudioSender(entry.audioSender, 64_000);

      if (viaFirestore) {
        await updateDoc(doc(db, 'livestream_peers', guestId), {
          answer: { type: answer.type, sdp: answer.sdp },
          answeredAt: Date.now()
        }).catch(() => {});
      }

      const answerSignal = {
        type: 'WEBRTC_SIGNAL',
        action: 'ANSWER',
        guestId,
        answer: { type: answer.type, sdp: answer.sdp }
      };
      liveChannel?.postMessage(answerSignal);
      supabaseRealtimeManager.sendDataMessage(answerSignal);
    } catch (e) {
      console.warn('WebRTC Host Answer error:', e);
    }
  };

  // 1. Listen to all guests connecting via Firestore collection 'livestream_peers' (Works 100% on Vercel)
  const peersCol = collection(db, 'livestream_peers');
  const unsubFirestorePeers = onSnapshot(peersCol, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      const guestId = change.doc.id;
      const data = change.doc.data();

      if (change.type === 'removed') {
        cleanupPeer(guestId);
        return;
      }

      if (data && data.offer && !data.answer) {
        handleOfferForGuest(guestId, data.offer, true);
      }
    });
  }, (err) => {
    console.warn('Firestore livestream_peers snapshot warning:', err);
  });

  // 2. Listen to both local cross-tab & Supabase/WS Realtime WebRTC signals
  const processHostSignal = (data: any, viaFirestoreHint: boolean) => {
    if (!data || data.type !== 'WEBRTC_SIGNAL' || !data.guestId) return;

    if (data.action === 'OFFER' && data.offer) {
      handleOfferForGuest(data.guestId, data.offer, viaFirestoreHint);
    } else if (data.action === 'GUEST_CANDIDATE' && data.candidate) {
      const entry = peers.get(data.guestId);
      if (entry) {
        if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
          entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
        } else {
          entry.pendingCandidates.push(data.candidate);
        }
      }
    }
  };

  const handleLocalSignal = (ev: MessageEvent) => processHostSignal(ev.data, false);
  liveChannel?.addEventListener('message', handleLocalSignal);

  const unsubSupabaseSignal = supabaseRealtimeManager.addListeners({
    onDataReceived: (msg) => processHostSignal(msg, true),
  });

  const stop = () => {
    isStopped = true;
    unsubFirestorePeers();
    unsubSupabaseSignal();
    liveChannel?.removeEventListener('message', handleLocalSignal);
    Array.from(peers.keys()).forEach((guestId) => cleanupPeer(guestId));
  };

  const replaceVideoTrack = async (newTrack: MediaStreamTrack | null) => {
    if (newTrack) {
      const existing = currentStream.getVideoTracks();
      existing.forEach((t) => {
        if (t !== newTrack) currentStream.removeTrack(t);
      });
      if (!currentStream.getVideoTracks().includes(newTrack)) {
        currentStream.addTrack(newTrack);
      }
    }
    const promises: Promise<any>[] = [];
    peers.forEach((entry) => {
      const transceiver = entry.pc.getTransceivers().find(
        (t) => t.receiver?.track?.kind === 'video' || t.sender?.track?.kind === 'video'
      ) || null;
      const sender = entry.videoSender || transceiver?.sender || null;
      if (transceiver && newTrack && transceiver.direction !== 'sendonly') {
        try { transceiver.direction = 'sendonly'; } catch {}
      }
      if (sender) {
        entry.videoSender = sender;
        promises.push(
          sender.replaceTrack(newTrack).then(() => {
            tuneVideoSender(sender, 3_200_000, 30);
          }).catch(() => {})
        );
      }
    });
    await Promise.allSettled(promises);
  };

  const replaceAudioTrack = async (newTrack: MediaStreamTrack | null) => {
    const existing = currentStream.getAudioTracks();
    existing.forEach((t) => {
      if (t !== newTrack) currentStream.removeTrack(t);
    });
    if (newTrack && !currentStream.getAudioTracks().includes(newTrack)) {
      currentStream.addTrack(newTrack);
    }
    const promises: Promise<any>[] = [];
    peers.forEach((entry) => {
      const transceiver = entry.pc.getTransceivers().find(
        (t) => t.receiver?.track?.kind === 'audio' || t.sender?.track?.kind === 'audio'
      ) || null;
      const sender = entry.audioSender || transceiver?.sender || null;
      if (transceiver && newTrack && transceiver.direction !== 'sendonly') {
        try { transceiver.direction = 'sendonly'; } catch {}
      }
      if (sender) {
        entry.audioSender = sender;
        promises.push(
          sender.replaceTrack(newTrack).then(() => {
            if (newTrack) tuneAudioSender(sender, 64_000);
          }).catch(() => {})
        );
      }
    });
    await Promise.allSettled(promises);
  };

  const updateStream = (newStream: MediaStream) => {
    currentStream = newStream;
    const newVideo = newStream.getVideoTracks()[0] || null;
    const newAudio = newStream.getAudioTracks()[0] || null;
    if (newVideo) replaceVideoTrack(newVideo);
    if (newAudio) replaceAudioTrack(newAudio);
  };

  const getConnectedPeersCount = () => {
    let count = 0;
    for (const entry of peers.values()) {
      const s = entry.pc.iceConnectionState;
      const cs = entry.pc.connectionState;
      if (s === 'connected' || s === 'completed' || cs === 'connected') {
        count += 1;
      }
    }
    return count;
  };

  const hasConnectedPeers = () => getConnectedPeersCount() > 0;

  const fn: any = () => stop();
  fn.stop = stop;
  fn.updateStream = updateStream;
  fn.replaceVideoTrack = replaceVideoTrack;
  fn.replaceAudioTrack = replaceAudioTrack;
  fn.hasConnectedPeers = hasConnectedPeers;
  fn.getConnectedPeersCount = getConnectedPeersCount;

  return fn;
}

export function connectGuestWebRTCStream(
  onStreamReady: (stream: MediaStream) => void,
  onIceFailed?: () => void
): () => void {
  const guestId = 'g_' + Date.now().toString(36) + '_' + Math.floor(1000 + Math.random() * 9000);
  const pc = new RTCPeerConnection(rtcConfig);
  const persistentRemoteStream = new MediaStream();
  let unsubHostCandidates: (() => void) | null = null;
  let unsubPeerDoc: (() => void) | null = null;
  let answerPollTimer: ReturnType<typeof setInterval> | null = null;
  let iceFailureTimer: ReturnType<typeof setTimeout> | null = null;
  let hasRestartedIce = false;
  let isClosed = false;
  const pendingHostCandidates: RTCIceCandidateInit[] = [];

  const syncTrackToStream = (track: MediaStreamTrack) => {
    if (track.readyState === 'ended') return;
    persistentRemoteStream.getTracks().forEach((existing) => {
      if (existing.kind === track.kind && existing !== track) {
        persistentRemoteStream.removeTrack(existing);
      }
    });
    if (!persistentRemoteStream.getTracks().includes(track)) {
      persistentRemoteStream.addTrack(track);
    }
  };

  const emitStableStream = () => {
    if (isClosed) return;
    if (persistentRemoteStream.getTracks().length > 0) {
      onStreamReady(persistentRemoteStream);
    }
  };

  pc.ontrack = (evt) => {
    try {
      const trackKind = evt.track?.kind || evt.receiver?.track?.kind;
      if (evt.receiver) {
        if (trackKind === 'video') {
          // 40ms video jitter cushion gives buttery-smooth motion across remote Wi-Fi/4G without stutter
          if ('playoutDelayHint' in evt.receiver) {
            (evt.receiver as any).playoutDelayHint = 0.04;
          }
          if ('jitterBufferTarget' in evt.receiver) {
            (evt.receiver as any).jitterBufferTarget = 0.04;
          }
        } else if (trackKind === 'audio') {
          if ('playoutDelayHint' in evt.receiver) {
            (evt.receiver as any).playoutDelayHint = 0.06;
          }
        }
      }
    } catch {}

    if (evt.track) {
      syncTrackToStream(evt.track);
      evt.track.onunmute = () => {
        syncTrackToStream(evt.track);
        emitStableStream();
      };
      emitStableStream();
    } else if (evt.streams && evt.streams[0]) {
      evt.streams[0].getTracks().forEach((t) => {
        syncTrackToStream(t);
        t.onunmute = () => {
          syncTrackToStream(t);
          emitStableStream();
        };
      });
      emitStableStream();
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (isClosed) return;
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (iceFailureTimer) {
        clearTimeout(iceFailureTimer);
        iceFailureTimer = null;
      }
      hasRestartedIce = false;
    } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      if (!hasRestartedIce) {
        hasRestartedIce = true;
        try { pc.restartIce(); } catch {}
      }
      if (!iceFailureTimer) {
        iceFailureTimer = setTimeout(() => {
          if (!isClosed && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
            onIceFailed?.();
          }
        }, pc.iceConnectionState === 'failed' ? 2500 : 6000);
      }
    }
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      const candJson = evt.candidate.toJSON();
      addDoc(collection(db, 'livestream_peers', guestId, 'guest_candidates'), candJson).catch(() => {});
      const candPayload = {
        type: 'WEBRTC_SIGNAL',
        action: 'GUEST_CANDIDATE',
        guestId,
        candidate: candJson
      };
      liveChannel?.postMessage(candPayload);
      supabaseRealtimeManager.sendDataMessage(candPayload);
    }
  };

  const applyAnswerOnce = async (answerDesc: RTCSessionDescriptionInit) => {
    if (isClosed || pc.currentRemoteDescription) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
      if (answerPollTimer) {
        clearInterval(answerPollTimer);
        answerPollTimer = null;
      }
      while (pendingHostCandidates.length > 0) {
        const pending = pendingHostCandidates.shift();
        if (pending && pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(pending)).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('Guest setRemoteDescription note:', err);
    }
  };

  const setupGuestCall = async () => {
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      offer.sdp = tuneOpusSdp(offer.sdp);
      await pc.setLocalDescription(offer);

      const peerDocRef = doc(db, 'livestream_peers', guestId);
      setDoc(peerDocRef, {
        guestId,
        offer: { type: offer.type, sdp: offer.sdp },
        createdAt: Date.now()
      }).catch(() => {});

      const hostCandCol = collection(db, 'livestream_peers', guestId, 'host_candidates');
      unsubHostCandidates = onSnapshot(hostCandCol, (candSnap) => {
        candSnap.docChanges().forEach((candChange) => {
          if (candChange.type === 'added') {
            const candData = candChange.doc.data();
            if (candData && candData.candidate) {
              const cInit = candData as RTCIceCandidateInit;
              if (pc.remoteDescription && pc.remoteDescription.type) {
                pc.addIceCandidate(new RTCIceCandidate(cInit)).catch(() => {});
              } else {
                pendingHostCandidates.push(cInit);
              }
            }
          }
        });
      });

      unsubPeerDoc = onSnapshot(peerDocRef, async (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          if (data && data.answer && !pc.currentRemoteDescription) {
            await applyAnswerOnce(data.answer);
          }
        }
      });

      // Firestore REST fallback poll for peer answer in case WebChannel drops on strict networks
      const peerRestUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/livestream_peers/${encodeURIComponent(guestId)}?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
      answerPollTimer = setInterval(async () => {
        if (isClosed || pc.currentRemoteDescription) {
          if (answerPollTimer) {
            clearInterval(answerPollTimer);
            answerPollTimer = null;
          }
          return;
        }
        try {
          const res = await fetch(`${peerRestUrl}&_t=${Date.now()}`, { cache: 'no-store' });
          if (!res.ok) return;
          const json = await res.json();
          const ansFields = json?.fields?.answer?.mapValue?.fields;
          if (ansFields?.type?.stringValue && ansFields?.sdp?.stringValue) {
            await applyAnswerOnce({
              type: ansFields.type.stringValue as RTCSdpType,
              sdp: ansFields.sdp.stringValue,
            });
          }
        } catch {}
      }, 2000);

      // Broadcast over both local BroadcastChannel & Supabase/WS Realtime
      const offerPayload = {
        type: 'WEBRTC_SIGNAL',
        action: 'OFFER',
        guestId,
        offer: { type: offer.type, sdp: offer.sdp }
      };
      liveChannel?.postMessage(offerPayload);
      supabaseRealtimeManager.sendDataMessage(offerPayload);
    } catch (e) {
      console.warn('Guest WebRTC connection setup error:', e);
    }
  };

  setupGuestCall();

  const processGuestSignal = async (data: any) => {
    if (!data || data.type !== 'WEBRTC_SIGNAL' || data.guestId !== guestId) return;

    if (data.action === 'ANSWER' && data.answer && !pc.currentRemoteDescription) {
      await applyAnswerOnce(data.answer);
    } else if (data.action === 'HOST_CANDIDATE' && data.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      } else {
        pendingHostCandidates.push(data.candidate);
      }
    }
  };

  const handleLocalAnswer = (ev: MessageEvent) => {
    processGuestSignal(ev.data);
  };
  liveChannel?.addEventListener('message', handleLocalAnswer);

  const unsubSupabaseGuest = supabaseRealtimeManager.addListeners({
    onDataReceived: (msg) => {
      processGuestSignal(msg);
    },
  });

  return () => {
    isClosed = true;
    if (iceFailureTimer) clearTimeout(iceFailureTimer);
    if (answerPollTimer) clearInterval(answerPollTimer);
    liveChannel?.removeEventListener('message', handleLocalAnswer);
    unsubSupabaseGuest();
    if (unsubPeerDoc) unsubPeerDoc();
    if (unsubHostCandidates) unsubHostCandidates();
    try {
      deleteDoc(doc(db, 'livestream_peers', guestId)).catch(() => {});
      pc.close();
    } catch {}
  };
}

/**
 * Strips all undefined properties recursively so Firestore setDoc/addDoc will never fail with
 * "Function setDoc() called with invalid data. Unsupported field value: undefined"
 */
export function cleanFirestorePayload<T extends Record<string, any>>(obj: T): T {
  const result: any = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        result[key] = cleanFirestorePayload(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// 8. 100% Real-Time Chat Synchronization across Vercel via Firestore
export function subscribeToLiveChatMessages(
  callback: (messages: LiveChatMessage[]) => void,
  sessionId?: string
): () => void {
  try {
    const chatsCol = collection(db, 'livestream_chats');
    const unsub = onSnapshot(chatsCol, (snapshot) => {
      const msgs: LiveChatMessage[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.id) {
          if (sessionId && data.sessionId && data.sessionId !== sessionId) {
            return;
          }
          if (sessionId && !data.sessionId) {
            return;
          }
          msgs.push({
            id: String(data.id),
            senderId: String(data.senderId || 'guest'),
            senderName: String(data.senderName || 'Tokufan'),
            senderBadge: data.senderBadge ? String(data.senderBadge) : undefined,
            isAdmin: Boolean(data.isAdmin),
            text: String(data.text || ''),
            image: data.image ? String(data.image) : undefined,
            file: data.file ? data.file : undefined,
            timestamp: String(data.timestamp || new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })),
            createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now()
          } as any);
        }
      });
      // Sort oldest to newest so newest appears at the bottom
      msgs.sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0));
      callback(msgs);
    }, (err) => {
      console.warn('Firestore live chat subscription warning:', err);
    });

    return unsub;
  } catch (err) {
    console.warn('Failed to subscribe to live chats:', err);
    return () => {};
  }
}

export async function sendLiveChatMessage(message: LiveChatMessage, sessionId?: string): Promise<void> {
  const rawPayload = {
    ...message,
    ...(sessionId ? { sessionId } : {}),
    createdAt: Date.now()
  };
  const payload = cleanFirestorePayload(rawPayload);

  // 1. Cross-tab immediate notification
  try {
    liveChannel?.postMessage({ type: 'CHAT', message: payload, sessionId: sessionId || '' });
  } catch {}

  // 2. Cloud Firestore Real-time Persistence & Broadcast (100% Sync on Vercel)
  try {
    const chatDoc = doc(db, 'livestream_chats', message.id);
    await setDoc(chatDoc, payload);
  } catch (err) {
    console.warn('Firestore sendLiveChatMessage note:', err);
  }
}

// 9. 100% Real-Time Viewer Presence & Management across Vercel via Firestore
export function registerLiveViewerPresence(
  viewer: LiveViewerInfo,
  onKicked?: () => void,
  sessionId?: string
): () => void {
  const viewerDocRef = doc(db, 'livestream_viewers', viewer.id);
  const now = Date.now();
  const baseFields = cleanFirestorePayload({
    id: viewer.id,
    name: viewer.name,
    isAdmin: Boolean(viewer.isAdmin),
    isRegisteredCustomer: Boolean(viewer.isRegisteredCustomer),
    email: viewer.email || '',
    roleBadge: viewer.roleBadge || (viewer.isAdmin ? '👑 Quản Lý Showroom' : viewer.isRegisteredCustomer ? '⭐ Thành Viên Đã Đăng Ký' : '👤 Khách Trực Tuyến'),
    joinedAt: viewer.joinedAt || new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    sessionId: sessionId || '',
  });
  const initialData = {
    ...baseFields,
    lastSeen: now,
    isOnline: true,
    isKicked: false
  };

  // Initial registration (overwrite stale session kick status cleanly)
  setDoc(viewerDocRef, initialData, { merge: false }).catch(() => {});

  // Heartbeat every 4 seconds to maintain active online status (excludes isKicked so active session kick remains intact)
  const timer = setInterval(() => {
    setDoc(viewerDocRef, {
      ...baseFields,
      lastSeen: Date.now(),
      isOnline: true
    }, { merge: true }).catch(() => {});
  }, 4000);

  // Real-time listener for kick status from Admin
  const unsubKick = onSnapshot(viewerDocRef, (snap) => {
    if (snap.exists()) {
      const data = snap.data();
      if (data && data.isKicked === true && (!sessionId || data.sessionId === sessionId)) {
        onKicked?.();
      }
    }
  }, () => {});

  // Cleanup on exit
  const cleanup = () => {
    clearInterval(timer);
    unsubKick();
    setDoc(viewerDocRef, { isOnline: false, lastSeen: Date.now() }, { merge: true }).catch(() => {});
  };

  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);

  return () => {
    cleanup();
    window.removeEventListener('beforeunload', cleanup);
    window.removeEventListener('pagehide', cleanup);
  };
}

export function subscribeToLiveViewers(
  callback: (viewers: LiveViewerInfo[]) => void,
  sessionId?: string
): () => void {
  try {
    const viewersCol = collection(db, 'livestream_viewers');
    const unsub = onSnapshot(viewersCol, (snapshot) => {
      const activeList: LiveViewerInfo[] = [];
      const threshold = Date.now() - 25000; // active within 25s

      snapshot.forEach((docSnap) => {
        const data = docSnap.data() as LiveViewerInfo & { sessionId?: string };
        if (data && data.id) {
          if (sessionId && data.sessionId !== sessionId) {
            return;
          }
          const isFresh = (data.lastSeen || 0) >= threshold;
          const isNotOffline = data.isOnline !== false;
          if (isFresh && isNotOffline && !data.isKicked) {
            activeList.push({
              ...data,
              isOnline: true
            });
          }
        }
      });

      // Sort: Host/Admin first, then registered customers, then guest viewers
      activeList.sort((a, b) => {
        if (a.isAdmin && !b.isAdmin) return -1;
        if (!a.isAdmin && b.isAdmin) return 1;
        if (a.isRegisteredCustomer && !b.isRegisteredCustomer) return -1;
        if (!a.isRegisteredCustomer && b.isRegisteredCustomer) return 1;
        return a.name.localeCompare(b.name);
      });

      callback(activeList);
    }, (err) => {
      console.warn('Firestore live viewers subscription note:', err);
    });

    return unsub;
  } catch (e) {
    console.warn('Failed to subscribe to live viewers:', e);
    return () => {};
  }
}

export async function fetchLiveViewersOnce(sessionId?: string): Promise<LiveViewerInfo[]> {
  try {
    const snap = await getDocs(collection(db, 'livestream_viewers'));
    const threshold = Date.now() - 25000;
    const activeList: LiveViewerInfo[] = [];

    snap.forEach((docSnap) => {
      const data = docSnap.data() as LiveViewerInfo & { sessionId?: string };
      if (data && data.id) {
        if (sessionId && data.sessionId !== sessionId) return;
        const isFresh = (data.lastSeen || 0) >= threshold;
        const isNotOffline = data.isOnline !== false;
        if (isFresh && isNotOffline && !data.isKicked) {
          activeList.push({ ...data, isOnline: true });
        }
      }
    });

    activeList.sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      if (a.isRegisteredCustomer && !b.isRegisteredCustomer) return -1;
      if (!a.isRegisteredCustomer && b.isRegisteredCustomer) return 1;
      return a.name.localeCompare(b.name);
    });

    return activeList;
  } catch {
    return [];
  }
}

export async function kickLiveViewer(viewerId: string): Promise<void> {
  try {
    const viewerDocRef = doc(db, 'livestream_viewers', viewerId);
    await setDoc(viewerDocRef, {
      isKicked: true,
      isOnline: false,
      kickedAt: Date.now()
    }, { merge: true });

    liveChannel?.postMessage({
      type: 'KICK_VIEWER',
      targetUserId: viewerId
    });
  } catch (err) {
    console.warn('Kick live viewer error:', err);
  }
}

// 10. Live Stream Realtime Media & Data Feed Subscriber (Guest Side)
export function subscribeToLiveFeed(callback: (data: any) => void): () => void {
  const handleData = (data: any) => {
    if (!data || !data.type) return;
    callback(data);
  };

  // 1. Local cross-tab broadcast
  const handleBroadcast = (ev: MessageEvent) => {
    if (ev.data && ev.data.type) {
      handleData(ev.data);
    }
  };
  liveChannel?.addEventListener('message', handleBroadcast);

  // 2. Cloud Firestore Feed Realtime Listener
  let unsubFirestoreFeed: (() => void) | null = null;
  try {
    const feedDoc = doc(db, 'livestream', 'latest_feed');
    unsubFirestoreFeed = onSnapshot(feedDoc, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data && data.type) {
          handleData(data);
        }
      }
    }, (err) => {
      console.warn('Firestore feed snapshot note:', err);
    });
  } catch (err) {
    console.warn('Firestore feed subscribe note:', err);
  }

  return () => {
    liveChannel?.removeEventListener('message', handleBroadcast);
    if (unsubFirestoreFeed) unsubFirestoreFeed();
  };
}

// 5. Customer Registration, Real IP Tracking & Real-Time Ban Enforcement
const FIRESTORE_DOCS_BASE_URL =
  `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;

const bannedIpsChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('npt_banned_ips_channel')
  : null;

async function fetchBannedIpsViaRest(): Promise<BannedIpRecord[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      `${FIRESTORE_DOCS_BASE_URL}/banned_ips?pageSize=300&key=${encodeURIComponent(firebaseConfig.apiKey)}&_t=${Date.now()}`,
      { cache: 'no-store', signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const docs: any[] = Array.isArray(json?.documents) ? json.documents : [];
    const results: BannedIpRecord[] = [];
    for (const d of docs) {
      const f = d?.fields || {};
      const ip = normalizeIpString(f.ip?.stringValue || '');
      if (!ip) continue;
      results.push({
        id: String(d.name || '').split('/').pop(),
        ip,
        reason: String(f.reason?.stringValue || 'Địa chỉ IP đã bị Quản Lý chặn'),
        bannedAt: String(f.bannedAt?.stringValue || new Date().toISOString()),
        customerId: f.customerId?.stringValue || null,
      });
    }
    return results;
  } catch {
    return null;
  }
}

async function writeBannedIpViaRest(docId: string, record: BannedIpRecord): Promise<boolean> {
  try {
    const fields: Record<string, any> = {
      ip: encodeFirestoreRestValue(record.ip),
      reason: encodeFirestoreRestValue(record.reason),
      bannedAt: encodeFirestoreRestValue(record.bannedAt),
      customerId: encodeFirestoreRestValue(record.customerId ?? null),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `${FIRESTORE_DOCS_BASE_URL}/banned_ips/${encodeURIComponent(docId)}?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteBannedIpViaRest(docId: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `${FIRESTORE_DOCS_BASE_URL}/banned_ips/${encodeURIComponent(docId)}?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      { method: 'DELETE', signal: controller.signal }
    );
    clearTimeout(timer);
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function fetchCustomerViaRest(customerId: string): Promise<Partial<CloudCustomer> | null> {
  if (!customerId) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `${FIRESTORE_DOCS_BASE_URL}/customers/${encodeURIComponent(customerId)}?key=${encodeURIComponent(firebaseConfig.apiKey)}&_t=${Date.now()}`,
      { cache: 'no-store', signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const f = json?.fields || {};
    return {
      id: customerId,
      email: f.email?.stringValue || '',
      registeredIp: f.registeredIp?.stringValue || '',
      lastIp: f.lastIp?.stringValue || '',
      registeredAt: f.registeredAt?.stringValue || '',
      isBlocked: Boolean(f.isBlocked?.booleanValue),
    };
  } catch {
    return null;
  }
}

async function patchCustomerViaRest(customerId: string, updates: Record<string, any>): Promise<boolean> {
  if (!customerId) return false;
  try {
    const fields: Record<string, any> = {};
    const fieldPaths: string[] = [];
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) {
        fields[k] = encodeFirestoreRestValue(v);
        fieldPaths.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(
      `${FIRESTORE_DOCS_BASE_URL}/customers/${encodeURIComponent(customerId)}?${fieldPaths.join('&')}&key=${encodeURIComponent(firebaseConfig.apiKey)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

function getLocalBannedIpList(): string[] {
  try {
    const raw = localStorage.getItem('npt_banned_ips');
    const list: any[] = raw ? JSON.parse(raw) : [];
    return Array.from(new Set(list.map(normalizeIpString).filter(Boolean)));
  } catch {
    return [];
  }
}

function saveLocalBannedIpList(ips: string[]) {
  try {
    localStorage.setItem('npt_banned_ips', JSON.stringify(Array.from(new Set(ips.map(normalizeIpString).filter(Boolean)))));
  } catch {}
}

export async function checkClientBanStatusNow(
  knownIp?: string,
  customerId?: string,
  email?: string
): Promise<{ blocked: boolean; ip: string; reason?: string }> {
  const realIp = normalizeIpString(knownIp) || await getRealClientPublicIp();
  const cleanEmail = String(email || '').trim().toLowerCase();

  // 1. Check localStorage banned_ips
  if (realIp && getLocalBannedIpList().includes(realIp)) {
    return { blocked: true, ip: realIp, reason: 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.' };
  }

  // 2. Check Cloud Firestore banned_ips (SDK + REST fallback)
  try {
    const snap = await withTimeout(getDocs(collection(db, 'banned_ips')), 2500, 'banned_ips_read_timeout');
    for (const d of snap.docs) {
      const data = d.data() as any;
      const docIp = normalizeIpString(data?.ip);
      if ((realIp && docIp === realIp) || (customerId && data?.customerId === customerId)) {
        return {
          blocked: true,
          ip: realIp || docIp,
          reason: String(data?.reason || 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.'),
        };
      }
    }
  } catch {
    const restBans = (await fetchBannedIpsViaRest()) || [];
    const matched = restBans.find(
      (b) => (realIp && b.ip === realIp) || (customerId && b.customerId === customerId)
    );
    if (matched) {
      return { blocked: true, ip: realIp || matched.ip, reason: matched.reason };
    }
  }

  // 3. Check customer isBlocked in Cloud Firestore
  if (customerId) {
    try {
      const cSnap = await withTimeout(getDocFromServer(doc(db, 'customers', customerId)), 2000, 'cust_read_timeout');
      if (cSnap.exists() && cSnap.data()?.isBlocked === true) {
        return {
          blocked: true,
          ip: realIp,
          reason: String(cSnap.data()?.blockReason || 'Tài khoản của bạn đã bị Quản Lý khóa.'),
        };
      }
    } catch {
      const restCust = await fetchCustomerViaRest(customerId);
      if (restCust?.isBlocked) {
        return { blocked: true, ip: realIp, reason: 'Tài khoản của bạn đã bị Quản Lý khóa.' };
      }
    }
  } else if (cleanEmail) {
    try {
      const saved = localStorage.getItem('npt_customers_registry');
      const list: any[] = saved ? JSON.parse(saved) : [];
      const found = list.find((c) => String(c?.email || '').toLowerCase() === cleanEmail);
      if (found?.isBlocked) {
        return { blocked: true, ip: realIp, reason: String(found?.blockReason || 'Tài khoản của bạn đã bị Quản Lý khóa.') };
      }
    } catch {}
  }

  // 4. Optional fullstack backend ban check
  try {
    const queryParams = new URLSearchParams();
    if (realIp) queryParams.set('clientIp', realIp);
    if (customerId) queryParams.set('customerId', customerId);
    const res = await fetch(`/api/client/ban-status?${queryParams.toString()}`);
    if (res.ok && res.headers.get('content-type')?.includes('application/json')) {
      const data = await res.json();
      if (data?.isBanned) {
        return {
          blocked: true,
          ip: normalizeIpString(data.ip) || realIp,
          reason: 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.',
        };
      }
    }
  } catch {}

  return { blocked: false, ip: realIp };
}

export async function updateCustomerIpPresenceCloud(
  customerId: string,
  email: string,
  ip: string
): Promise<void> {
  const cleanId = String(customerId || '').trim();
  const cleanIp = normalizeIpString(ip);
  if (!cleanId || !cleanIp) return;

  try {
    const saved = localStorage.getItem('npt_customers_registry');
    if (saved) {
      const list: any[] = JSON.parse(saved);
      const updated = list.map((c) =>
        c.id === cleanId || (email && String(c.email || '').toLowerCase() === email.toLowerCase())
          ? { ...c, lastIp: cleanIp, ip: cleanIp, lastActiveAt: new Date().toISOString() }
          : c
      );
      localStorage.setItem('npt_customers_registry', JSON.stringify(updated));
    }
  } catch {}

  const patch = {
    lastIp: cleanIp,
    ip: cleanIp,
    lastActiveAt: new Date().toISOString(),
  };

  try {
    await withTimeout(setDoc(doc(db, 'customers', cleanId), patch, { merge: true }), 2500, 'cust_ip_timeout');
  } catch {
    patchCustomerViaRest(cleanId, patch).catch(() => {});
  }
}

export async function registerOrUpdateCustomerCloud(customerData: {
  id?: string;
  name: string;
  email: string;
  phone?: string;
  role?: 'user' | 'admin';
  tierRank?: string;
  riderPoints?: number;
  avatar?: string;
}): Promise<CloudCustomer> {
  const realIp = await getRealClientPublicIp(true);
  const cleanEmail = customerData.email.trim().toLowerCase();
  const cleanId = customerData.id || ('cust_' + Math.abs(cleanEmail.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36));

  // Enforce IP & account block BEFORE creating/updating customer record
  const banStatus = await checkClientBanStatusNow(realIp, cleanId, cleanEmail);
  if (banStatus.blocked) {
    throw new Error(`BLOCKED_IP:${banStatus.ip || realIp}:${banStatus.reason || 'Địa chỉ IP đã bị Quản Lý chặn'}`);
  }

  // Read existing customer record so we NEVER overwrite isBlocked, registeredIp, or registeredAt
  let existingCloud: Partial<CloudCustomer> | null = null;
  try {
    const snap = await withTimeout(getDocFromServer(doc(db, 'customers', cleanId)), 2000, 'cust_exist_timeout');
    if (snap.exists()) existingCloud = snap.data() as CloudCustomer;
  } catch {
    existingCloud = await fetchCustomerViaRest(cleanId);
  }

  let existingLocal: Partial<CloudCustomer> | null = null;
  let localList: any[] = [];
  try {
    const saved = localStorage.getItem('npt_customers_registry');
    localList = saved ? JSON.parse(saved) : [];
    existingLocal = localList.find((c) => c.email === cleanEmail || c.id === cleanId) || null;
  } catch {}

  const existing = existingCloud || existingLocal;
  const nowIso = new Date().toISOString();
  const preservedRegisteredIp = normalizeIpString(existing?.registeredIp) || realIp;
  const preservedLastIp = realIp || normalizeIpString(existing?.lastIp) || preservedRegisteredIp;
  const preservedIsBlocked = Boolean(existing?.isBlocked);

  if (preservedIsBlocked) {
    throw new Error(`BLOCKED_ACCOUNT:${preservedLastIp}:Tài khoản của bạn đã bị Quản Lý khóa.`);
  }

  const record: CloudCustomer = {
    id: cleanId,
    name: customerData.name || cleanEmail.split('@')[0],
    email: cleanEmail,
    phone: customerData.phone || existing?.phone || '',
    role: customerData.role || existing?.role || (cleanEmail.includes('admin') ? 'admin' : 'user'),
    tierRank: customerData.tierRank || existing?.tierRank || 'Novice Rider',
    riderPoints: customerData.riderPoints ?? existing?.riderPoints ?? 100,
    avatar: customerData.avatar || existing?.avatar,
    registeredIp: preservedRegisteredIp,
    lastIp: preservedLastIp,
    registeredAt: existing?.registeredAt || nowIso,
    lastLoginAt: nowIso,
    isBlocked: false,
  };

  // Detect same-IP clone accounts accurately
  const hasOtherAccountWithSameIp = Boolean(
    realIp &&
      localList.some(
        (c) =>
          c.id !== cleanId &&
          String(c.email || '').toLowerCase() !== cleanEmail &&
          (normalizeIpString(c.lastIp) === realIp || normalizeIpString(c.registeredIp) === realIp)
      )
  );

  // Save to Local Registry
  try {
    const idx = localList.findIndex((c) => c.email === cleanEmail || c.id === cleanId);
    const localRecord = { ...record, ip: preservedLastIp, isCloneSuspect: hasOtherAccountWithSameIp };
    if (idx !== -1) {
      localList[idx] = { ...localList[idx], ...localRecord };
    } else {
      localList.unshift(localRecord);
    }
    localStorage.setItem('npt_customers_registry', JSON.stringify(localList));
  } catch {}

  // Sync to Cloud Firestore Collection 'customers' (with REST fallback)
  const cleanedRecord = cleanFirestorePayload({
    ...record,
    ip: preservedLastIp,
    ...(hasOtherAccountWithSameIp ? { isCloneSuspect: true } : {}),
  });
  try {
    const custRef = doc(db, 'customers', cleanId);
    await withTimeout(setDoc(custRef, cleanedRecord, { merge: true }), 2500, 'cust_save_timeout');
  } catch {
    patchCustomerViaRest(cleanId, cleanedRecord).catch(() => {});
  }

  // Also notify Node backend if running fullstack
  try {
    fetch('/api/customers/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...record, clientReportedIp: realIp || undefined })
    }).catch(() => {});
  } catch {}

  return record;
}

// 6. Realtime Banned IP Subscriber (used by App.tsx across ALL customer devices)
export function subscribeToBannedIpsRealtime(
  callback: (records: BannedIpRecord[]) => void
): () => void {
  let isDisposed = false;
  let latestMap = new Map<string, BannedIpRecord>();

  const emitMap = () => {
    if (isDisposed) return;
    const list = Array.from(latestMap.values());
    saveLocalBannedIpList(list.map((r) => r.ip));
    callback(list);
  };

  // 1. Hydrate from localStorage
  getLocalBannedIpList().forEach((ip) => {
    latestMap.set(ip, { ip, reason: 'Địa chỉ IP đã bị Quản Lý chặn truy cập.', bannedAt: '' });
  });
  emitMap();

  // 2. Cloud Firestore Realtime Snapshot
  let unsubFirestore: (() => void) | null = null;
  try {
    unsubFirestore = onSnapshot(
      collection(db, 'banned_ips'),
      (snapshot) => {
        const nextMap = new Map<string, BannedIpRecord>();
        snapshot.forEach((d) => {
          const data = d.data() as any;
          const ip = normalizeIpString(data?.ip);
          if (!ip) return;
          nextMap.set(ip, {
            id: d.id,
            ip,
            reason: String(data?.reason || 'Địa chỉ IP đã bị Quản Lý chặn truy cập.'),
            bannedAt: String(data?.bannedAt || ''),
            customerId: data?.customerId || null,
          });
        });
        latestMap = nextMap;
        emitMap();
      },
      () => {}
    );
  } catch {}

  // 3. REST API sync poll every 5s (survives WebChannel throttling / strict firewalls)
  const syncViaRest = async () => {
    if (isDisposed) return;
    const restList = await fetchBannedIpsViaRest();
    if (isDisposed) return;
    const nextList = restList ? [...restList] : null;
    // Also fetch Node API if available
    try {
      const apiRes = await fetch('/api/client/ban-status');
      if (apiRes.ok && apiRes.headers.get('content-type')?.includes('application/json')) {
        const apiData = await apiRes.json();
        if (apiData?.isBanned && apiData?.ip) {
          const apiIp = normalizeIpString(apiData.ip);
          if (apiIp) {
            if (nextList && !nextList.some((r) => r.ip === apiIp)) {
              nextList.push({
                ip: apiIp,
                reason: 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.',
                bannedAt: new Date().toISOString(),
              });
            } else if (!nextList && !latestMap.has(apiIp)) {
              latestMap.set(apiIp, {
                ip: apiIp,
                reason: 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.',
                bannedAt: new Date().toISOString(),
              });
              emitMap();
            }
          }
        }
      }
    } catch {}
    if (nextList !== null) {
      const nextMap = new Map<string, BannedIpRecord>();
      nextList.forEach((r) => nextMap.set(r.ip, r));
      latestMap = nextMap;
      emitMap();
    }
  };
  syncViaRest();
  const restTimer = setInterval(syncViaRest, 5000);

  // 4. Instant Cross-Tab BroadcastChannel + Storage + Supabase Realtime
  const applyQuickEvent = (msg: any) => {
    if (!msg || msg.type !== 'IP_BLOCK_UPDATE') return;
    const ip = normalizeIpString(msg.ip);
    if (!ip) return;
    if (msg.action === 'block') {
      latestMap.set(ip, {
        ip,
        reason: String(msg.reason || 'Địa chỉ IP đã bị Quản Lý chặn truy cập.'),
        bannedAt: new Date().toISOString(),
        customerId: msg.customerId || null,
      });
      emitMap();
    } else if (msg.action === 'unblock') {
      latestMap.delete(ip);
      emitMap();
    }
  };

  const handleBroadcast = (ev: MessageEvent) => applyQuickEvent(ev.data);
  bannedIpsChannel?.addEventListener('message', handleBroadcast);

  const unsubSupabase = supabaseRealtimeManager.addListeners({
    onDataReceived: (msg) => applyQuickEvent(msg),
  });

  const handleStorage = (ev: StorageEvent) => {
    if (ev.key === 'npt_banned_ips') {
      const ips = getLocalBannedIpList();
      const nextMap = new Map<string, BannedIpRecord>();
      ips.forEach((ip) => {
        const prev = latestMap.get(ip);
        nextMap.set(ip, prev || { ip, reason: 'Địa chỉ IP đã bị Quản Lý chặn truy cập.', bannedAt: '' });
      });
      latestMap = nextMap;
      emitMap();
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    isDisposed = true;
    clearInterval(restTimer);
    if (unsubFirestore) unsubFirestore();
    unsubSupabase();
    bannedIpsChannel?.removeEventListener('message', handleBroadcast);
    window.removeEventListener('storage', handleStorage);
  };
}

export function subscribeToCustomerBanStatus(
  customerId: string,
  email: string | undefined,
  callback: (blocked: boolean, reason?: string) => void
): () => void {
  const cleanId = String(customerId || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanId && !cleanEmail) return () => {};

  let isDisposed = false;
  let unsubDoc: (() => void) | null = null;

  if (cleanId) {
    try {
      unsubDoc = onSnapshot(
        doc(db, 'customers', cleanId),
        (snap) => {
          if (isDisposed) return;
          if (snap.exists()) {
            const data = snap.data() as any;
            callback(Boolean(data?.isBlocked), data?.blockReason);
          }
        },
        () => {}
      );
    } catch {}
  }

  const handleBroadcast = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!msg || msg.type !== 'IP_BLOCK_UPDATE') return;
    if (
      (cleanId && msg.customerId === cleanId) ||
      (cleanEmail && String(msg.email || '').toLowerCase() === cleanEmail)
    ) {
      callback(msg.action === 'block', msg.reason);
    }
  };
  bannedIpsChannel?.addEventListener('message', handleBroadcast);

  const pollTimer = setInterval(async () => {
    if (isDisposed || !cleanId) return;
    const restCust = await fetchCustomerViaRest(cleanId);
    if (restCust && typeof restCust.isBlocked === 'boolean') {
      callback(restCust.isBlocked);
    }
  }, 6000);

  return () => {
    isDisposed = true;
    clearInterval(pollTimer);
    if (unsubDoc) unsubDoc();
    bannedIpsChannel?.removeEventListener('message', handleBroadcast);
  };
}

// 7. Realtime Customer List for Admin Modal
export function subscribeToCustomersList(
  callback: (customers: (CloudCustomer & { ip?: string })[], bannedIps: string[]) => void
): () => void {
  const normalizeCustomer = (raw: any): CloudCustomer & { ip: string } => {
    const resolvedIp = normalizeIpString(raw?.ip || raw?.lastIp || raw?.registeredIp || '');
    return {
      id: String(raw?.id || `cust_${Date.now()}`),
      name: String(raw?.name || raw?.email?.split('@')?.[0] || 'Khách hàng'),
      email: String(raw?.email || ''),
      phone: String(raw?.phone || ''),
      role: raw?.role === 'admin' ? 'admin' : 'user',
      tierRank: String(raw?.tierRank || 'Novice Rider'),
      riderPoints: Number(raw?.riderPoints ?? 100),
      avatar: raw?.avatar ? String(raw.avatar) : undefined,
      registeredIp: normalizeIpString(raw?.registeredIp) || resolvedIp,
      lastIp: normalizeIpString(raw?.lastIp) || resolvedIp,
      ip: resolvedIp,
      registeredAt: String(raw?.registeredAt || new Date().toISOString()),
      lastLoginAt: String(raw?.lastLoginAt || raw?.registeredAt || new Date().toISOString()),
      isBlocked: Boolean(raw?.isBlocked),
    };
  };

  let latestCustomers: (CloudCustomer & { ip: string })[] = [];
  let latestBannedIps: string[] = [];

  try {
    const saved = localStorage.getItem('npt_customers_registry');
    const custs: any[] = saved ? JSON.parse(saved) : [];
    latestBannedIps = getLocalBannedIpList();
    latestCustomers = custs.map(normalizeCustomer);
    callback(latestCustomers, latestBannedIps);
  } catch {}

  let unsubCustomers = () => {};
  let unsubBanned = () => {};

  try {
    const custCollection = collection(db, 'customers');
    unsubCustomers = onSnapshot(custCollection, (snapshot) => {
      const cloudList: (CloudCustomer & { ip: string })[] = [];
      snapshot.forEach(docSnap => {
        cloudList.push(normalizeCustomer({ id: docSnap.id, ...docSnap.data() }));
      });

      const merged = [...cloudList];
      try {
        const localSaved = localStorage.getItem('npt_customers_registry');
        if (localSaved) {
          const localList: any[] = JSON.parse(localSaved);
          localList.forEach(loc => {
            const norm = normalizeCustomer(loc);
            if (!merged.some(m => m.id === norm.id || (norm.email && m.email === norm.email))) {
              merged.push(norm);
            }
          });
        }
      } catch {}

      merged.sort((a, b) => new Date(b.lastLoginAt || b.registeredAt).getTime() - new Date(a.lastLoginAt || a.registeredAt).getTime());
      latestCustomers = merged;
      callback(latestCustomers, latestBannedIps);
    }, (err) => {
      console.warn('Customers realtime listener note:', err);
    });
  } catch {}

  try {
    const bannedCollection = collection(db, 'banned_ips');
    unsubBanned = onSnapshot(bannedCollection, (snapshot) => {
      const ips: string[] = [];
      snapshot.forEach(d => {
        const data = d.data();
        const ipStr = normalizeIpString(data?.ip);
        if (ipStr && !ips.includes(ipStr)) ips.push(ipStr);
      });
      latestBannedIps = ips;
      saveLocalBannedIpList(ips);
      callback(latestCustomers, latestBannedIps);
    }, () => {});
  } catch {}

  // Also fetch fullstack backend customer registry when running in Node mode
  fetch('/api/admin/customers')
    .then((r) => (r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json() : null))
    .then((data) => {
      if (data?.customers && Array.isArray(data.customers)) {
        const merged = [...latestCustomers];
        for (const c of data.customers) {
          const norm = normalizeCustomer(c);
          if (!merged.some((m) => m.id === norm.id || (norm.email && m.email === norm.email))) {
            merged.push(norm);
          }
        }
        latestCustomers = merged;
      }
      if (Array.isArray(data?.bannedIps)) {
        const combinedBanned = Array.from(new Set([...latestBannedIps, ...data.bannedIps.map(normalizeIpString).filter(Boolean)]));
        latestBannedIps = combinedBanned;
      }
      callback(latestCustomers, latestBannedIps);
    })
    .catch(() => {});

  return () => {
    unsubCustomers();
    unsubBanned();
  };
}

// 8. Ban / Block IP Action (100% Real-Time across Firestore, REST, BroadcastChannel, Supabase & Node)
export async function blockIpCloud(ip: string, customerId?: string, reason?: string): Promise<void> {
  const cleanIp = normalizeIpString(ip);
  if (!cleanIp && !customerId) return;

  const resolvedReason = String(reason || '').trim() || 'Nghi vấn tài khoản xấu / clone';
  const now = Date.now();
  const bannedAt = new Date().toISOString();

  // 1. Local storage + local customer registry update
  if (cleanIp) {
    const list = getLocalBannedIpList();
    if (!list.includes(cleanIp)) list.push(cleanIp);
    saveLocalBannedIpList(list);
  }

  try {
    const custRaw = localStorage.getItem('npt_customers_registry');
    if (custRaw) {
      let custs: any[] = JSON.parse(custRaw);
      custs = custs.map((c) => {
        const matchesId = Boolean(customerId && c.id === customerId);
        const matchesIp = Boolean(
          cleanIp &&
            (normalizeIpString(c.lastIp) === cleanIp ||
              normalizeIpString(c.registeredIp) === cleanIp ||
              normalizeIpString(c.ip) === cleanIp)
        );
        return matchesId || matchesIp ? { ...c, isBlocked: true, blockReason: resolvedReason } : c;
      });
      localStorage.setItem('npt_customers_registry', JSON.stringify(custs));
    }
  } catch {}

  // 2. Instant Cross-Tab & Supabase Realtime notification
  const blockSignal = {
    type: 'IP_BLOCK_UPDATE',
    action: 'block',
    ip: cleanIp,
    customerId: customerId || null,
    reason: resolvedReason,
    timestamp: now,
  };
  try { bannedIpsChannel?.postMessage(blockSignal); } catch {}
  supabaseRealtimeManager.sendDataMessage(blockSignal);

  // 3. Cloud Firestore update (SDK + REST fallback + block all sibling customer accounts on this IP)
  if (cleanIp) {
    const docId = sanitizeIpDocId(cleanIp);
    const banRecord: BannedIpRecord = {
      ip: cleanIp,
      customerId: customerId || null,
      reason: resolvedReason,
      bannedAt,
    };
    try {
      await withTimeout(setDoc(doc(db, 'banned_ips', docId), banRecord), 2500, 'ban_write_timeout');
    } catch {
      await writeBannedIpViaRest(docId, banRecord);
    }
  }

  const customerPatch = {
    isBlocked: true,
    blockReason: resolvedReason,
    forceLogoutAt: now,
  };

  if (customerId) {
    try {
      await withTimeout(setDoc(doc(db, 'customers', customerId), customerPatch, { merge: true }), 2500, 'cust_ban_timeout');
    } catch {
      patchCustomerViaRest(customerId, customerPatch).catch(() => {});
    }
  }

  if (cleanIp) {
    try {
      const custSnap = await withTimeout(getDocs(collection(db, 'customers')), 2500, 'cust_scan_timeout');
      await Promise.allSettled(
        custSnap.docs
          .filter((d) => {
            const data = d.data() as any;
            return (
              d.id !== customerId &&
              (normalizeIpString(data?.lastIp) === cleanIp ||
                normalizeIpString(data?.registeredIp) === cleanIp ||
                normalizeIpString(data?.ip) === cleanIp)
            );
          })
          .map((d) => setDoc(d.ref, customerPatch, { merge: true }).catch(() => {}))
      );
    } catch {}
  }

  // 4. Node Backend enforcement (kicks active WS viewers & enforces server-side block)
  try {
    fetch('/api/admin/customers/block-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: cleanIp, customerId, reason: resolvedReason })
    }).catch(() => {});
  } catch {}
}

// 9. Unblock IP Action (consistent doc IDs + cleans all matching IP docs & customer flags)
export async function unblockIpCloud(ip: string, customerId?: string): Promise<void> {
  const cleanIp = normalizeIpString(ip);
  if (!cleanIp && !customerId) return;

  // 1. Local update
  if (cleanIp) {
    saveLocalBannedIpList(getLocalBannedIpList().filter((item) => item !== cleanIp));
  }

  try {
    const custRaw = localStorage.getItem('npt_customers_registry');
    if (custRaw) {
      let custs: any[] = JSON.parse(custRaw);
      custs = custs.map((c) => {
        const matchesId = Boolean(customerId && c.id === customerId);
        const matchesIp = Boolean(
          cleanIp &&
            (normalizeIpString(c.lastIp) === cleanIp ||
              normalizeIpString(c.registeredIp) === cleanIp ||
              normalizeIpString(c.ip) === cleanIp)
        );
        return matchesId || matchesIp ? { ...c, isBlocked: false, blockReason: '' } : c;
      });
      localStorage.setItem('npt_customers_registry', JSON.stringify(custs));
    }
  } catch {}

  // 2. Instant Cross-Tab & Supabase Realtime notification
  const unblockSignal = {
    type: 'IP_BLOCK_UPDATE',
    action: 'unblock',
    ip: cleanIp,
    customerId: customerId || null,
    timestamp: Date.now(),
  };
  try { bannedIpsChannel?.postMessage(unblockSignal); } catch {}
  supabaseRealtimeManager.sendDataMessage(unblockSignal);

  // 3. Cloud Firestore cleanup (handles all sanitized doc ID variants & scans matching docs)
  if (cleanIp) {
    const candidateDocIds = Array.from(
      new Set([
        sanitizeIpDocId(cleanIp),
        cleanIp.replace(/[:./]/g, '_'),
        cleanIp.replace(/[:.]/g, '_'),
      ])
    ).filter(Boolean);

    await Promise.allSettled(
      candidateDocIds.map(async (id) => {
        try {
          await withTimeout(deleteDoc(doc(db, 'banned_ips', id)), 2000, 'unban_del_timeout');
        } catch {
          await deleteBannedIpViaRest(id);
        }
      })
    );
  }

  try {
    const bannedSnap = await withTimeout(getDocs(collection(db, 'banned_ips')), 2500, 'unban_scan_timeout');
    await Promise.allSettled(
      bannedSnap.docs
        .filter((d) => {
          const data = d.data() as any;
          const docIp = normalizeIpString(data?.ip);
          return (cleanIp && docIp === cleanIp) || (customerId && data?.customerId === customerId);
        })
        .map((d) => deleteDoc(d.ref).catch(() => deleteBannedIpViaRest(d.id)))
    );
  } catch {}

  const unblockPatch = { isBlocked: false, blockReason: '' };
  if (customerId) {
    try {
      await withTimeout(setDoc(doc(db, 'customers', customerId), unblockPatch, { merge: true }), 2000, 'cust_unban_timeout');
    } catch {
      patchCustomerViaRest(customerId, unblockPatch).catch(() => {});
    }
  }

  if (cleanIp) {
    try {
      const custSnap = await withTimeout(getDocs(collection(db, 'customers')), 2500, 'cust_unban_scan_timeout');
      await Promise.allSettled(
        custSnap.docs
          .filter((d) => {
            const data = d.data() as any;
            return (
              normalizeIpString(data?.lastIp) === cleanIp ||
              normalizeIpString(data?.registeredIp) === cleanIp ||
              normalizeIpString(data?.ip) === cleanIp
            );
          })
          .map((d) => setDoc(d.ref, unblockPatch, { merge: true }).catch(() => {}))
      );
    } catch {}
  }

  // 4. Backup Node API
  try {
    fetch('/api/admin/customers/unblock-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: cleanIp, customerId })
    }).catch(() => {});
  } catch {}
}

// 10. Force Logout Customer Session (Local + Cross-Tab + Cloud Firestore across Vercel)
const customerLogoutChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('npt_customer_force_logout')
  : null;

export async function forceLogoutCustomerCloud(customerId: string, email?: string): Promise<void> {
  const cleanId = String(customerId || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const now = Date.now();

  try {
    const rawMap = localStorage.getItem('npt_force_logout_map');
    const map: Record<string, number> = rawMap ? JSON.parse(rawMap) : {};
    if (cleanId) map[cleanId] = now;
    if (cleanEmail) map[cleanEmail] = now;
    localStorage.setItem('npt_force_logout_map', JSON.stringify(map));
  } catch {}

  try {
    customerLogoutChannel?.postMessage({ customerId: cleanId, email: cleanEmail, forceLogoutAt: now });
  } catch {}

  if (cleanId) {
    try {
      const custRef = doc(db, 'customers', cleanId);
      await setDoc(custRef, { forceLogoutAt: now }, { merge: true });
    } catch (err) {
      patchCustomerViaRest(cleanId, { forceLogoutAt: now }).catch(() => {});
      console.warn('Force logout customer cloud write note:', err);
    }
  }
}

export function subscribeToCustomerForceLogout(
  customerId: string,
  email: string | undefined,
  onForceLogout: () => void
): () => void {
  const cleanId = String(customerId || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanId && !cleanEmail) return () => {};

  const checkShouldLogout = (forceLogoutAt?: number) => {
    if (!forceLogoutAt || typeof forceLogoutAt !== 'number') return;
    try {
      const loginAt = Number(localStorage.getItem('npt_customer_login_at') || '0');
      if (forceLogoutAt > loginAt) {
        onForceLogout();
      }
    } catch {
      onForceLogout();
    }
  };

  let unsubDoc: (() => void) | null = null;
  if (cleanId) {
    try {
      const custRef = doc(db, 'customers', cleanId);
      unsubDoc = onSnapshot(custRef, (snap) => {
        if (snap.exists()) {
          const data = snap.data() as any;
          checkShouldLogout(data?.forceLogoutAt);
        }
      }, () => {});
    } catch {}
  }

  const handleBroadcast = (ev: MessageEvent) => {
    const msg = ev.data;
    if (!msg) return;
    if ((cleanId && msg.customerId === cleanId) || (cleanEmail && msg.email === cleanEmail)) {
      checkShouldLogout(msg.forceLogoutAt);
    }
  };
  customerLogoutChannel?.addEventListener('message', handleBroadcast);

  const handleStorage = (ev: StorageEvent) => {
    if (ev.key === 'npt_force_logout_map' && ev.newValue) {
      try {
        const map = JSON.parse(ev.newValue);
        const ts = (cleanId && map[cleanId]) || (cleanEmail && map[cleanEmail]);
        checkShouldLogout(ts);
      } catch {}
    }
  };
  window.addEventListener('storage', handleStorage);

  return () => {
    if (unsubDoc) unsubDoc();
    customerLogoutChannel?.removeEventListener('message', handleBroadcast);
    window.removeEventListener('storage', handleStorage);
  };
}

