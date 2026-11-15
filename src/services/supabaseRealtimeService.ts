import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

// Optional Supabase Configuration (activated only when real env vars are provided)
const ENV_SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL || '';
const ENV_SUPABASE_ANON_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '';
const HAS_REAL_SUPABASE = Boolean(
  ENV_SUPABASE_URL &&
  ENV_SUPABASE_ANON_KEY &&
  !ENV_SUPABASE_URL.includes('pub-realtime-nptstore')
);

export interface SupabaseViewerInfo {
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

// Global BroadcastChannel for same-device cross-tab zero-latency relay
const crossTabChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('npt_supabase_realtime_relay') : null;

// Global fallback WS for local Node server environment reliability
let globalWsFallback: WebSocket | null = null;
let globalWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let globalWsPingTimer: ReturnType<typeof setInterval> | null = null;
let globalWsReconnectAttempt = 0;
let backendWsAvailability: 'unknown' | 'available' | 'unavailable' = 'unknown';

async function checkBackendWsAvailable(): Promise<boolean> {
  if (backendWsAvailability === 'available') return true;
  if (backendWsAvailability === 'unavailable') return false;
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      backendWsAvailability = 'available';
      return true;
    }
  } catch {}
  backendWsAvailability = 'unavailable';
  return false;
}

export class SupabaseRealtimeManager {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private roomName: string = 'npt-official-room';
  private subscribedRoomName: string = '';
  private hasTrackedUser: boolean = false;
  private userId: string = '';
  private userName: string = '';
  private isHost: boolean = false;
  private userEmail: string = '';
  private isRegisteredCustomer: boolean = false;
  private isConnected: boolean = false;

  private dataListeners: Set<(payload: any) => void> = new Set();
  private participantListeners: Set<(participants: SupabaseViewerInfo[]) => void> = new Set();
  private connectionStateListeners: Set<(state: string) => void> = new Set();

  constructor() {
    if (HAS_REAL_SUPABASE) {
      this.client = createClient(ENV_SUPABASE_URL, ENV_SUPABASE_ANON_KEY, {
        realtime: {
          params: {
            eventsPerSecond: 60
          }
        }
      });
    }

    if (crossTabChannel) {
      crossTabChannel.addEventListener('message', (event) => {
        if (event.data) {
          this.emitData(event.data);
        }
      });
    }
  }

  private emitData(payload: any) {
    this.dataListeners.forEach((cb) => {
      try { cb(payload); } catch {}
    });
  }

  private emitParticipants(participants: SupabaseViewerInfo[]) {
    this.participantListeners.forEach((cb) => {
      try { cb(participants); } catch {}
    });
  }

  private emitConnectionState(state: string) {
    this.connectionStateListeners.forEach((cb) => {
      try { cb(state); } catch {}
    });
  }

  public addListeners(callbacks: {
    onDataReceived?: (payload: any) => void;
    onParticipantListChanged?: (participants: SupabaseViewerInfo[]) => void;
    onConnectionStateChange?: (state: string) => void;
  }): () => void {
    if (callbacks.onDataReceived) this.dataListeners.add(callbacks.onDataReceived);
    if (callbacks.onParticipantListChanged) this.participantListeners.add(callbacks.onParticipantListChanged);
    if (callbacks.onConnectionStateChange) this.connectionStateListeners.add(callbacks.onConnectionStateChange);

    return () => {
      if (callbacks.onDataReceived) this.dataListeners.delete(callbacks.onDataReceived);
      if (callbacks.onParticipantListChanged) this.participantListeners.delete(callbacks.onParticipantListChanged);
      if (callbacks.onConnectionStateChange) this.connectionStateListeners.delete(callbacks.onConnectionStateChange);
    };
  }

  /**
   * Connect to Realtime Channel (Supabase if configured, otherwise Cloud Firestore + Cross-Tab + optional Node WS)
   */
  public setupSupabaseRealtime(
    roomName = 'npt-official-room',
    user?: { id: string; name: string; isAdmin: boolean; email?: string; isRegisteredCustomer?: boolean },
    callbacks?: {
      onDataReceived?: (payload: any) => void;
      onParticipantListChanged?: (participants: SupabaseViewerInfo[]) => void;
      onConnectionStateChange?: (state: string) => void;
    }
  ) {
    const resolvedRoomName = roomName || 'npt-official-room';
    const roomChanged = this.subscribedRoomName !== resolvedRoomName;
    const prevUserId = this.userId;
    this.roomName = resolvedRoomName;
    if (user && user.id) {
      this.userId = user.id;
      this.userName = user.name;
      this.isHost = user.isAdmin;
      this.userEmail = user.email || '';
      this.isRegisteredCustomer = Boolean(user.isRegisteredCustomer);
    }

    if (callbacks) {
      if (callbacks.onDataReceived) this.dataListeners.add(callbacks.onDataReceived);
      if (callbacks.onParticipantListChanged) this.participantListeners.add(callbacks.onParticipantListChanged);
      if (callbacks.onConnectionStateChange) this.connectionStateListeners.add(callbacks.onConnectionStateChange);
    }

    // Connect local WebSocket relay ONLY when running with custom Node backend (skips cleanly on Vercel)
    this.setupLocalRelay();

    // If real Supabase credentials are not configured, Firestore + WebRTC + BroadcastChannel act as primary transport
    if (!this.client) {
      this.isConnected = false;
      this.emitConnectionState('connected');
      return;
    }

    if (this.channel && this.isConnected && !roomChanged) {
      if (this.userId && (!this.hasTrackedUser || prevUserId !== this.userId)) {
        this.hasTrackedUser = true;
        this.channel.track({
          id: this.userId,
          name: this.userName,
          isAdmin: this.isHost,
          email: this.userEmail,
          isRegisteredCustomer: this.isRegisteredCustomer,
          joinedAt: new Date().toISOString()
        }).catch(() => {});
      }
      this.emitConnectionState('connected');
      return;
    }

    this.emitConnectionState('connecting');

    if (this.channel) {
      try { this.client.removeChannel(this.channel); } catch {}
      this.channel = null;
    }
    this.isConnected = false;
    this.hasTrackedUser = false;
    this.subscribedRoomName = this.roomName;

    const channel = this.client.channel(this.roomName, {
      config: {
        broadcast: {
          self: false,
          ack: false
        },
        presence: {
          key: this.userId || `user_${Math.floor(Math.random() * 10000)}`
        }
      }
    });

    this.channel = channel;

    channel.on('broadcast', { event: 'live_stream' }, (payload) => {
      if (payload && payload.payload) {
        this.emitData(payload.payload);
      }
    });

    channel.on('presence', { event: 'sync' }, () => {
      const presenceState = channel.presenceState();
      const viewers: SupabaseViewerInfo[] = [];

      Object.values(presenceState).forEach((presences: any) => {
        if (Array.isArray(presences)) {
          presences.forEach((p: any) => {
            if (p && p.id) {
              viewers.push({
                id: p.id,
                name: p.name || 'Khách Hàng',
                isAdmin: Boolean(p.isAdmin),
                isRegisteredCustomer: Boolean(p.isRegisteredCustomer),
                email: p.email || '',
                joinedAt: p.joinedAt || new Date().toISOString(),
                isOnline: true
              });
            }
          });
        }
      });

      this.emitParticipants(viewers);
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        this.isConnected = true;
        this.emitConnectionState('connected');

        if (this.userId) {
          try {
            this.hasTrackedUser = true;
            await channel.track({
              id: this.userId,
              name: this.userName,
              isAdmin: this.isHost,
              email: this.userEmail,
              isRegisteredCustomer: this.isRegisteredCustomer,
              joinedAt: new Date().toISOString()
            });
          } catch {}
        }
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        this.isConnected = false;
        // Keep connected status because Cloud Firestore + WebRTC P2P remain active on Vercel
        this.emitConnectionState('connected');
      }
    });
  }

  /**
   * Check if WS relay buffer is currently backed up (prevents stale video frame queue delay on slow remote connections)
   */
  public isWsRelayCongested(): boolean {
    return Boolean(globalWsFallback && globalWsFallback.readyState === WebSocket.OPEN && globalWsFallback.bufferedAmount > 48 * 1024);
  }

  /**
   * Check whether either Supabase Realtime or Node WebSocket relay is actively connected
   */
  public hasActiveRealtimeTransport(): boolean {
    return Boolean(this.isConnected || (globalWsFallback && globalWsFallback.readyState === WebSocket.OPEN));
  }

  /**
   * High-speed parallel local relay setup when Node backend is present (skipped safely on static Vercel)
   */
  private async setupLocalRelay() {
    try {
      const hasBackend = await checkBackendWsAvailable();
      if (!hasBackend) return;

      if (globalWsFallback && (globalWsFallback.readyState === WebSocket.OPEN || globalWsFallback.readyState === WebSocket.CONNECTING)) {
        if (globalWsFallback.readyState === WebSocket.OPEN && this.userId) {
          try {
            globalWsFallback.send(JSON.stringify({
              type: 'JOIN',
              user: {
                id: this.userId,
                name: this.userName,
                isAdmin: this.isHost,
                email: this.userEmail,
                isRegisteredCustomer: this.isRegisteredCustomer
              }
            }));
          } catch {}
        }
        return;
      }

      if (globalWsReconnectTimer) {
        clearTimeout(globalWsReconnectTimer);
        globalWsReconnectTimer = null;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/live/ws`;
      const ws = new WebSocket(wsUrl);
      globalWsFallback = ws;

      ws.onopen = () => {
        globalWsReconnectAttempt = 0;
        if (globalWsPingTimer) clearInterval(globalWsPingTimer);
        globalWsPingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'PING' })); } catch {}
          }
        }, 20000);

        if (this.userId) {
          try {
            ws.send(JSON.stringify({
              type: 'JOIN',
              user: {
                id: this.userId,
                name: this.userName,
                isAdmin: this.isHost,
                email: this.userEmail,
                isRegisteredCustomer: this.isRegisteredCustomer
              }
            }));
          } catch {}
        }
      };

      ws.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data);
          if (raw?.type === 'PONG') return;
          const data = raw?.type === 'BROADCAST' && raw?.payload ? raw.payload : raw;
          if (data?.type === 'VIEWERS_UPDATE' && Array.isArray(data.viewers)) {
            this.emitParticipants(data.viewers);
          }
          if (data) {
            this.emitData(data);
          }
        } catch {}
      };

      const scheduleReconnect = () => {
        if (globalWsPingTimer) {
          clearInterval(globalWsPingTimer);
          globalWsPingTimer = null;
        }
        if (globalWsFallback === ws) {
          globalWsFallback = null;
        }
        if (!globalWsReconnectTimer) {
          const delay = Math.min(5000, 1000 * Math.pow(1.6, globalWsReconnectAttempt));
          globalWsReconnectAttempt += 1;
          globalWsReconnectTimer = setTimeout(() => {
            globalWsReconnectTimer = null;
            this.setupLocalRelay();
          }, delay);
        }
      };

      ws.onclose = scheduleReconnect;
      ws.onerror = () => {
        try { ws.close(); } catch {}
      };
    } catch {}
  }

  /**
   * Broadcast message over available Realtime Channels
   */
  public sendDataMessage(payload: any) {
    if (this.channel && this.isConnected) {
      try {
        this.channel.send({
          type: 'broadcast',
          event: 'live_stream',
          payload: payload
        });
      } catch (err) {
        console.warn('Supabase Realtime broadcast warning:', err);
      }
    }

    if (crossTabChannel) {
      try { crossTabChannel.postMessage(payload); } catch {}
    }

    if (globalWsFallback && globalWsFallback.readyState === WebSocket.OPEN) {
      try {
        globalWsFallback.send(JSON.stringify(
          payload && typeof payload === 'object' && payload.type
            ? payload
            : { type: 'BROADCAST', payload }
        ));
      } catch {}
    }
  }

  /**
   * Disconnect and clean up Realtime Channel
   */
  public disconnect() {
    if (this.channel && this.client) {
      try {
        this.channel.untrack();
        this.client.removeChannel(this.channel);
      } catch {}
      this.channel = null;
    }
    this.isConnected = false;
    this.subscribedRoomName = '';
    this.hasTrackedUser = false;
  }
}

export const supabaseRealtimeManager = new SupabaseRealtimeManager();
