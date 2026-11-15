import {
  Room,
  RoomEvent,
  VideoPresets,
  AudioPresets,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalVideoTrack,
  LocalAudioTrack,
  createLocalVideoTrack,
  createLocalAudioTrack,
  VideoCodec,
} from 'livekit-client';
import { broadcastLiveData } from './realtimeSync.ts';
import { supabaseRealtimeManager } from './supabaseRealtimeService.ts';

export interface LiveChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  senderBadge?: string;
  isAdmin?: boolean;
  text?: string;
  image?: string;
  file?: {
    name: string;
    size: number;
    url: string;
    type: string;
  };
  timestamp: string;
}

export interface FloatingHeart {
  id: string;
  x: number;
  color: string;
}

export interface OBSConfigInfo {
  serverUrl: string;
  streamKey: string;
  whipUrl: string;
  rtmpUrl: string;
  rtmpServer?: string;
  bearerToken?: string;
  recommendedSettings: {
    rateControl: string;
    bitrate: string;
    keyframeInterval: string;
    cpuPreset: string;
    profile: string;
    tune: string;
    audioBitrate: string;
  };
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
  lastSeen?: number;
  isOnline?: boolean;
  isKicked?: boolean;
}

export class LiveKitStreamManager {
  private room: Room | null = null;
  private ws: WebSocket | null = null;
  private localVideoTrack: LocalVideoTrack | null = null;
  private localAudioTrack: LocalAudioTrack | null = null;
  private screenTrack: LocalVideoTrack | null = null;
  private audioCtx: AudioContext | null = null;
  private userId: string = '';
  private userName: string = '';
  private isHost: boolean = false;
  private userEmail: string = '';
  private isRegisteredCustomer: boolean = false;
  private currentRoomName: string = 'npt-official-room';

  private onRemoteTrackSubscribedCallback?: (track: RemoteTrack) => void;
  private onRemoteTrackUnsubscribedCallback?: (track: RemoteTrack) => void;
  private onDataReceivedCallback?: (payload: any) => void;
  private onParticipantListChangedCallback?: (participants: LiveViewerInfo[]) => void;
  private onConnectionStateChangeCallback?: (state: string) => void;

  private unsubRealtimeListeners: (() => void) | null = null;

  constructor() {}

  public isRoomConnected(): boolean {
    return Boolean(this.room && this.room.state === 'connected');
  }

  /**
   * Fetch LiveKit authentication token & room config from server
   */
  public async getLiveKitToken(
    roomName: string,
    identity: string,
    name: string,
    isAdmin: boolean,
    email?: string,
    isRegisteredCustomer?: boolean
  ) {
    this.userId = identity;
    this.userName = name;
    this.isHost = isAdmin;
    this.userEmail = email || '';
    this.isRegisteredCustomer = Boolean(isRegisteredCustomer);
    this.currentRoomName = roomName;

    try {
      const res = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName, identity, name, isAdmin }),
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('application/json')) {
        return { token: `fallback_${identity}`, url: '', identity };
      }
      const data = await res.json();
      return data;
    } catch {
      return { token: `fallback_${identity}`, url: '', identity };
    }
  }

  /**
   * Connect to LiveKit Room with Simulcast, H.264 / VP8 hardware codecs & dynacast
   */
  public async connectToRoom(
    livekitWsUrl: string,
    token: string,
    callbacks: {
      onRemoteTrackSubscribed?: (track: RemoteTrack) => void;
      onRemoteTrackUnsubscribed?: (track: RemoteTrack) => void;
      onDataReceived?: (payload: any) => void;
      onParticipantListChanged?: (participants: LiveViewerInfo[]) => void;
      onConnectionStateChange?: (state: string) => void;
    }
  ) {
    this.onRemoteTrackSubscribedCallback = callbacks.onRemoteTrackSubscribed;
    this.onRemoteTrackUnsubscribedCallback = callbacks.onRemoteTrackUnsubscribed;
    this.onDataReceivedCallback = callbacks.onDataReceived;
    this.onParticipantListChangedCallback = callbacks.onParticipantListChanged;
    this.onConnectionStateChangeCallback = callbacks.onConnectionStateChange;

    this.onConnectionStateChangeCallback?.('connecting');

    // Setup fallback WebSocket for immediate data relay (chat, reaction hearts, pin, kick)
    this.setupSignalingWebSocket();

    // If valid token and cloud url available, connect via official LiveKit Room SDK
    if (livekitWsUrl && token && !token.startsWith('fallback_')) {
      try {
        const room = new Room({
          adaptiveStream: true,
          dynacast: true, // Dynacast: only request video layers actually visible to viewer
          videoCaptureDefaults: {
            resolution: VideoPresets.h720.resolution,
          },
          publishDefaults: {
            simulcast: true, // Simulcast 3 layers (720p / 360p / 180p) for zero-lag adaptive playback over remote Wi-Fi/4G
            videoSimulcastLayers: [VideoPresets.h720, VideoPresets.h360, VideoPresets.h180],
            videoEncoding: {
              maxBitrate: 2_200_000,
              maxFramerate: 30,
            },
            videoCodec: 'vp8' as VideoCodec, // VP8 encodes/decodes smoothly across all remote mobile & desktop devices without software H264 stutter
            audioPreset: AudioPresets.speech,
            dtx: false,
            red: true,
          },
        });

        this.room = room;

        room
          .on(RoomEvent.Connected, () => {
            this.onConnectionStateChangeCallback?.('connected');
            this.syncParticipants();
          })
          .on(RoomEvent.Disconnected, () => {
            this.onConnectionStateChangeCallback?.('disconnected');
          })
          .on(RoomEvent.Reconnecting, () => {
            this.onConnectionStateChangeCallback?.('reconnecting');
          })
          .on(RoomEvent.Reconnected, () => {
            this.onConnectionStateChangeCallback?.('connected');
          })
          .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
            // When guest receives video or audio from host (OBS or WebCam)
            this.onRemoteTrackSubscribedCallback?.(track);
          })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
            this.onRemoteTrackUnsubscribedCallback?.(track);
          })
          .on(RoomEvent.DataReceived, (payload: Uint8Array) => {
            try {
              const str = new TextDecoder().decode(payload);
              const data = JSON.parse(str);
              this.onDataReceivedCallback?.(data);
            } catch (e) {}
          })
          .on(RoomEvent.ParticipantConnected, () => {
            this.syncParticipants();
          })
          .on(RoomEvent.ParticipantDisconnected, () => {
            this.syncParticipants();
          });

        await room.connect(livekitWsUrl, token);
        return room;
      } catch (livekitError) {
        console.warn('LiveKit Cloud connection failed (falling back to WebSocket WebRTC signaling):', livekitError);
        this.onConnectionStateChangeCallback?.('connected');
      }
    }
  }

  private reconnectTimer: any = null;

  /**
   * Supabase Realtime signaling connection for real-time video frames, chat, hearts, and viewer presence
   */
  public setupSignalingWebSocket(callbacks?: {
    onRemoteTrackSubscribed?: (track: RemoteTrack) => void;
    onRemoteTrackUnsubscribed?: (track: RemoteTrack) => void;
    onDataReceived?: (payload: any) => void;
    onParticipantListChanged?: (participants: LiveViewerInfo[]) => void;
    onConnectionStateChange?: (state: string) => void;
  }) {
    if (callbacks) {
      if (callbacks.onRemoteTrackSubscribed) this.onRemoteTrackSubscribedCallback = callbacks.onRemoteTrackSubscribed;
      if (callbacks.onRemoteTrackUnsubscribed) this.onRemoteTrackUnsubscribedCallback = callbacks.onRemoteTrackUnsubscribed;
      if (callbacks.onDataReceived) this.onDataReceivedCallback = callbacks.onDataReceived;
      if (callbacks.onParticipantListChanged) this.onParticipantListChangedCallback = callbacks.onParticipantListChanged;
      if (callbacks.onConnectionStateChange) this.onConnectionStateChangeCallback = callbacks.onConnectionStateChange;
    }

    if (this.unsubRealtimeListeners) {
      this.unsubRealtimeListeners();
      this.unsubRealtimeListeners = null;
    }

    this.unsubRealtimeListeners = supabaseRealtimeManager.addListeners({
      onDataReceived: (payload) => {
        this.onDataReceivedCallback?.(payload);
      },
      onParticipantListChanged: (participants) => {
        this.onParticipantListChangedCallback?.(participants);
      },
      onConnectionStateChange: (state) => {
        this.onConnectionStateChangeCallback?.(state);
      }
    });

    supabaseRealtimeManager.setupSupabaseRealtime(
      this.currentRoomName || 'npt-official-room',
      {
        id: this.userId,
        name: this.userName,
        isAdmin: this.isHost,
        email: this.userEmail,
        isRegisteredCustomer: this.isRegisteredCustomer
      }
    );
  }

  /**
   * Publish Camera & Mic to LiveKit with Simulcast (3 layers) and H.264
   * Reuses existing MediaStreamTracks when provided to prevent double hardware capture conflicts.
   */
  public async publishCameraAndMic(
    videoElement?: HTMLVideoElement | null,
    existingStream?: MediaStream | null
  ) {
    if (!this.isHost || !this.room || this.room.state !== 'connected') return;

    try {
      const existingVideoTrack = existingStream?.getVideoTracks().find((t) => t.readyState === 'live') || null;
      const existingAudioTrack = existingStream?.getAudioTracks().find((t) => t.readyState === 'live') || null;

      if (!this.localVideoTrack) {
        this.localVideoTrack = existingVideoTrack
          ? new LocalVideoTrack(existingVideoTrack, undefined, true)
          : await createLocalVideoTrack({
              resolution: VideoPresets.h720.resolution,
              facingMode: 'user',
            });
      }

      if (!this.localAudioTrack) {
        this.localAudioTrack = existingAudioTrack
          ? new LocalAudioTrack(existingAudioTrack, undefined, true)
          : await createLocalAudioTrack({
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            });
      }

      if (videoElement && this.localVideoTrack && !videoElement.srcObject) {
        this.localVideoTrack.attach(videoElement);
      }

      if (this.room && this.room.state === 'connected') {
        const publishedTracks = Array.from(this.room.localParticipant.trackPublications.values()).map((p) => p.track);
        if (this.localVideoTrack && !publishedTracks.includes(this.localVideoTrack)) {
          await this.room.localParticipant.publishTrack(this.localVideoTrack, {
            simulcast: true,
            videoSimulcastLayers: [VideoPresets.h720, VideoPresets.h360, VideoPresets.h180],
            videoEncoding: {
              maxBitrate: 2_200_000,
              maxFramerate: 30,
            },
            videoCodec: 'vp8' as VideoCodec,
          });
        }

        if (this.localAudioTrack && !publishedTracks.includes(this.localAudioTrack)) {
          await this.room.localParticipant.publishTrack(this.localAudioTrack, {
            audioPreset: AudioPresets.speech,
            dtx: false,
            red: true,
          });
        }
      }

      return {
        videoTrack: this.localVideoTrack,
        audioTrack: this.localAudioTrack,
      };
    } catch (err) {
      console.warn('Error publishing camera & mic:', err);
    }
  }

  /**
   * Sync or replace the published LiveKit audio track cleanly
   */
  public async syncAudioTrack(audioTrack: MediaStreamTrack | null, enabled: boolean) {
    if (!this.isHost || !this.room || this.room.state !== 'connected') return;
    try {
      if (audioTrack && audioTrack.readyState === 'live') {
        audioTrack.enabled = enabled;
        if (!this.localAudioTrack || this.localAudioTrack.mediaStreamTrack !== audioTrack) {
          if (this.localAudioTrack) {
            try {
              await this.room.localParticipant.unpublishTrack(this.localAudioTrack);
            } catch {}
          }
          this.localAudioTrack = new LocalAudioTrack(audioTrack, undefined, true);
          await this.room.localParticipant.publishTrack(this.localAudioTrack, {
            dtx: false,
            red: true,
          });
        }
      }
      if (this.localAudioTrack) {
        if (enabled && this.localAudioTrack.isMuted) {
          await this.localAudioTrack.unmute().catch(() => {});
        } else if (!enabled && !this.localAudioTrack.isMuted) {
          await this.localAudioTrack.mute().catch(() => {});
        }
      }
    } catch (err) {
      console.warn('Sync LiveKit audio track note:', err);
    }
  }

  /**
   * Toggle camera on/off
   */
  public async toggleCamera(enable: boolean) {
    if (this.localVideoTrack) {
      if (enable) {
        await this.localVideoTrack.unmute().catch(() => {});
      } else {
        await this.localVideoTrack.mute().catch(() => {});
      }
    }
    this.sendDataMessage({ type: 'CAM_STATE', enabled: enable });
  }

  /**
   * Toggle microphone on/off
   */
  public async toggleMicrophone(enable: boolean) {
    if (this.localAudioTrack) {
      if (enable) {
        await this.localAudioTrack.unmute().catch(() => {});
      } else {
        await this.localAudioTrack.mute().catch(() => {});
      }
    }
    this.sendDataMessage({ type: 'MIC_STATE', enabled: enable });
  }

  /**
   * Screen Share with LiveKit — reuses existing captured screen track to avoid opening a duplicate browser screen picker
   */
  public async toggleScreenShare(enable: boolean, existingScreenVideoTrack?: MediaStreamTrack | null) {
    if (!this.isHost) return null;
    try {
      if (!this.room || this.room.state !== 'connected') return null;

      if (enable) {
        if (existingScreenVideoTrack && existingScreenVideoTrack.readyState === 'live') {
          if (this.screenTrack) {
            try {
              await this.room.localParticipant.unpublishTrack(this.screenTrack);
            } catch {}
            this.screenTrack = null;
          }
          this.screenTrack = new LocalVideoTrack(existingScreenVideoTrack, undefined, true);
          await this.room.localParticipant.publishTrack(this.screenTrack, {
            source: Track.Source.ScreenShare,
            simulcast: true,
            videoEncoding: {
              maxBitrate: 3_000_000,
              maxFramerate: 30,
            },
            videoCodec: 'vp8' as VideoCodec,
          });
        }
      } else {
        if (this.screenTrack) {
          try {
            await this.room.localParticipant.unpublishTrack(this.screenTrack);
          } catch {}
          this.screenTrack = null;
        }
        await this.room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      }
    } catch (e) {
      console.warn('Screen share toggle error:', e);
    }
  }

  /**
   * Apply clean WebAudio Speech Filtering & Dynamics Limiter (preserves vocal warmth without clipping or notch artifacts)
   */
  public applyWebAudioNoiseSuppression(mediaStream: MediaStream): MediaStream {
    try {
      if (!mediaStream || mediaStream.getAudioTracks().length === 0) return mediaStream;

      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      const source = this.audioCtx.createMediaStreamSource(mediaStream);

      // Gentle 75Hz High-Pass Filter cuts sub-bass rumble/AC hum without thinning natural voice fundamentals
      const highPass = this.audioCtx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.setValueAtTime(75, this.audioCtx.currentTime);
      highPass.Q.setValueAtTime(0.707, this.audioCtx.currentTime);

      // Subtle speech presence (+2.5dB @ 2600Hz) for crisp articulation
      const voicePresence = this.audioCtx.createBiquadFilter();
      voicePresence.type = 'peaking';
      voicePresence.frequency.setValueAtTime(2600, this.audioCtx.currentTime);
      voicePresence.Q.setValueAtTime(1.0, this.audioCtx.currentTime);
      voicePresence.gain.setValueAtTime(2.5, this.audioCtx.currentTime);

      // Transparent voice leveler & limiter to prevent clipping/distortion during loud speech
      const compressor = this.audioCtx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-20, this.audioCtx.currentTime);
      compressor.knee.setValueAtTime(14, this.audioCtx.currentTime);
      compressor.ratio.setValueAtTime(4, this.audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      compressor.release.setValueAtTime(0.14, this.audioCtx.currentTime);

      const gainNode = this.audioCtx.createGain();
      gainNode.gain.setValueAtTime(1.15, this.audioCtx.currentTime);

      const destination = this.audioCtx.createMediaStreamDestination();

      source.connect(highPass);
      highPass.connect(voicePresence);
      voicePresence.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(destination);

      const enhancedStream = new MediaStream();
      mediaStream.getVideoTracks().forEach(t => enhancedStream.addTrack(t));
      destination.stream.getAudioTracks().forEach(t => enhancedStream.addTrack(t));

      return enhancedStream;
    } catch (e) {
      return mediaStream;
    }
  }

  /**
   * Send Data Messages (Chat, Reaction hearts, Pin Product, Kick Viewer)
   */
  public sendDataMessage(data: any) {
    // 1. Send via LiveKit reliable data channel if room active
    if (this.room && this.room.state === 'connected') {
      try {
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        const payload = new Uint8Array(encoded.buffer as ArrayBuffer);
        this.room.localParticipant.publishData(payload, { reliable: true });
      } catch (e) {}
    }

    // 2. Broadcast via WebSocket relay + BroadcastChannel
    broadcastLiveData(data);

    this.onDataReceivedCallback?.(data);
  }

  /**
   * Synchronize participants list
   */
  private syncParticipants() {
    const list: LiveViewerInfo[] = [];

    if (this.room && this.room.state === 'connected') {
      // Local participant
      list.push({
        id: this.room.localParticipant.identity,
        name: this.room.localParticipant.name || (this.isHost ? 'nptteam (Quản Lý)' : 'Bạn'),
        isAdmin: this.isHost,
        roleBadge: this.isHost ? '👑 Quản Lý Showroom' : '👤 Người Xem',
        isOnline: true,
      });

      // Remote participants
      this.room.remoteParticipants.forEach((p: RemoteParticipant) => {
        const isAdm = p.identity.includes('admin') || p.identity.includes('nptteam');
        list.push({
          id: p.identity,
          name: p.name || `Khách #${p.identity.slice(-4)}`,
          isAdmin: isAdm,
          roleBadge: isAdm ? '👑 Quản Lý Showroom' : '👤 Người Xem',
          isOnline: true,
        });
      });

      this.onParticipantListChangedCallback?.(list);
    }
  }

  public disconnect() {
    if (this.unsubRealtimeListeners) {
      this.unsubRealtimeListeners();
      this.unsubRealtimeListeners = null;
    }
    if (this.localVideoTrack) {
      this.localVideoTrack.stop();
      this.localVideoTrack = null;
    }
    if (this.localAudioTrack) {
      this.localAudioTrack.stop();
      this.localAudioTrack = null;
    }
    if (this.screenTrack) {
      this.screenTrack.stop();
      this.screenTrack = null;
    }
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {}
      this.audioCtx = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
