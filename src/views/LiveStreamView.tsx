import React, { useState, useEffect, useRef } from 'react';
import { Product, User } from '../types.ts';
import { LiveKitStreamManager, LiveChatMessage, FloatingHeart, OBSConfigInfo, LiveViewerInfo } from '../services/livekitService.ts';
import { supabaseRealtimeManager } from '../services/supabaseRealtimeService.ts';
import { showToast } from '../utils/sound.ts';
import { 
  publishLiveStateToCloud, 
  subscribeToLiveState, 
  subscribeToLiveFeed,
  startHostWebRTCStream,
  connectGuestWebRTCStream,
  playAudioRelayPayload,
  resetRelayAudioQueue,
  publishLiveAudioChunkToCloud,
  subscribeToLiveAudioChunk,
  setGuestRelayAudioState,
  unlockRelayAudioContext,
  getRealClientPublicIp,
  sendHostHeartbeat,
  sendEndLiveBeacon,
  subscribeToLiveChatMessages,
  sendLiveChatMessage,
  registerLiveViewerPresence,
  subscribeToLiveViewers,
  kickLiveViewer,
  clearPreviousLiveSessionData,
  publishLiveVideoFrameToCloud,
  subscribeToLiveVideoFrame,
  fetchLiveViewersOnce,
  HostWebRTCController
} from '../services/realtimeSync.ts';

interface LiveStreamViewProps {
  currentUser: User | null;
  isAdminAuthenticated: boolean;
  products: Product[];
  onSelectProduct: (p: Product) => void;
  onAddToCart: (p: Product) => void;
  onBuyNow: (p: Product) => void;
  onCloseLive?: () => void;
  onOpenAuth?: () => void;
}

export const LiveStreamView: React.FC<LiveStreamViewProps> = ({
  currentUser,
  isAdminAuthenticated,
  products,
  onSelectProduct,
  onAddToCart,
  onBuyNow,
  onCloseLive,
  onOpenAuth,
}) => {
  const isAdmin = (currentUser?.role === 'admin' || isAdminAuthenticated) ?? false;
  
  // Persistent visitor ID for unauthenticated guests
  const [visitorId] = useState<string>(() => {
    try {
      let saved = sessionStorage.getItem('npt_visitor_id') || localStorage.getItem('npt_visitor_id');
      if (!saved) {
        saved = 'visitor_' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('npt_visitor_id', saved);
      }
      return saved;
    } catch {
      return 'visitor_' + Math.floor(1000 + Math.random() * 9000);
    }
  });

  const currentUserId = isAdmin ? 'admin_nptteam' : (currentUser ? currentUser.id : visitorId);
  const currentUserName = isAdmin
    ? 'nptteam (Quản Lý)'
    : (currentUser ? currentUser.name : `Khách ghé thăm #${visitorId.slice(-4)}`);

  // Live Stream State
  const [isLive, setIsLive] = useState<boolean>(false);
  const [liveSessionId, setLiveSessionId] = useState<string>('');
  const liveSessionIdRef = useRef<string>('');
  const prevIsLiveRef = useRef<boolean>(false);
  const [isBroadcastingHost, setIsBroadcastingHost] = useState<boolean>(false);
  const isBroadcastingHostRef = useRef<boolean>(false);
  isBroadcastingHostRef.current = isBroadcastingHost;
  const isActiveHost = isAdmin && isBroadcastingHost;
  const isActiveHostRef = useRef<boolean>(false);
  isActiveHostRef.current = isActiveHost;
  const [streamTitle, setStreamTitle] = useState<string>(
    '🔴 LỄ RA MẮT SIÊU PHẨM DX & CSM KAMEN RIDER 2026 - SHOWROOM NPTTEAMSTORE'
  );
  const [viewersCount, setViewersCount] = useState<number>(1);
  const [pinnedProduct, setPinnedProduct] = useState<Product | null>(null);
  const [isPinnedProductCollapsed, setIsPinnedProductCollapsed] = useState<boolean>(false);

  const createDefaultWelcomeMessage = (): LiveChatMessage => ({
    id: 'm-welcome',
    senderId: 'admin_nptteam',
    senderName: 'nptteam',
    senderBadge: '👑 HOST / QUẢN LÝ',
    isAdmin: true,
    text: 'Chào mừng tất cả anh em Tokufan đến với buổi Live Stream chính hãng NPTTEAMSTORE! Anh em cần test âm thanh đai nào hãy bình luận bên dưới nhé!',
    timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
  });

  // Reset all client-side live session data (chat, viewers, hearts, pinned product, attachments, video frames, kick state)
  const resetLocalLiveSessionState = (nextSessionId: string = '') => {
    liveSessionIdRef.current = nextSessionId;
    setLiveSessionId(nextSessionId);
    setMessages([createDefaultWelcomeMessage()]);
    setInputMessage('');
    setAttachedImage(null);
    setAttachedFile(null);
    setSelectedImageLightbox(null);
    setFloatingHearts([]);
    setPinnedProduct(null);
    setIsPinnedProductCollapsed(false);
    setHasReceivedLiveVideo(false);
    hasReceivedLiveAudioRef.current = false;
    setHasReceivedLiveAudio(false);
    setHasWebRTCVideoPixels(false);
    hasWebRTCVideoPixelsRef.current = false;
    webrtcAudioLiveRef.current = false;
    liveKitAudioLiveRef.current = false;
    currentGuestAudioTrackIdRef.current = '';
    lastPublishedAudioTrackIdRef.current = '';
    activeRelayAudioTrackRef.current = null;
    resetRelayAudioQueue();
    lastRenderedVideoTsRef.current = 0;
    setHasCanvasFrame(false);
    setHostCamEnabled(true);
    guestExplicitMutedRef.current = false;
    isGuestAudioMutedRef.current = false;
    setIsGuestAudioMuted(false);
    setScreenShareEnabled(false);
    setIsKicked(false);
    setParticipants([
      {
        id: currentUserId,
        name: currentUserName,
        isAdmin,
        isRegisteredCustomer: Boolean(currentUser && !isAdmin),
        email: currentUser?.email,
        roleBadge: isAdmin ? '👑 Quản Lý Showroom' : (currentUser ? '⭐ Thành Viên Đã Đăng Ký' : '👤 Khách Trực Tuyến'),
        joinedAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
        isOnline: true,
      }
    ]);
    if (guestCanvasRef.current) {
      const ctx = guestCanvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, guestCanvasRef.current.width, guestCanvasRef.current.height);
    }
    if (guestVideoRef.current) {
      guestVideoRef.current.srcObject = null;
    }
    if (guestAudioRef.current) {
      guestAudioRef.current.srcObject = null;
    }
  };

  const productsRef = useRef<Product[]>(products);
  productsRef.current = products;

  // Realtime Cloud Live State Synchronization (across all Vercel clients worldwide)
  useEffect(() => {
    const unsubscribe = subscribeToLiveState((cloudState) => {
      const nextSessionId = cloudState.sessionId || '';
      const sessionChanged = Boolean(nextSessionId && nextSessionId !== liveSessionIdRef.current);
      const justEnded = prevIsLiveRef.current && cloudState.isLive === false;

      if (justEnded || sessionChanged) {
        resetLocalLiveSessionState(cloudState.isLive ? nextSessionId : '');
      }

      if (typeof cloudState.isLive === 'boolean') {
        prevIsLiveRef.current = cloudState.isLive;
        setIsLive(cloudState.isLive);
        if (!cloudState.isLive) {
          setIsBroadcastingHost(false);
          try { sessionStorage.removeItem('npt_host_broadcasting_session'); } catch {}
        } else if (isAdmin && cloudState.sessionId) {
          try {
            if (sessionStorage.getItem('npt_host_broadcasting_session') === cloudState.sessionId) {
              setIsBroadcastingHost(true);
            }
          } catch {}
        }
      }
      if (cloudState.title) {
        setStreamTitle(cloudState.title);
      }
      if (cloudState.isLive && cloudState.pinnedProductId) {
        const foundProd = productsRef.current.find(p => p.id === cloudState.pinnedProductId);
        if (foundProd) setPinnedProduct(foundProd);
      } else if (cloudState.pinnedProductId === null || cloudState.isLive === false) {
        setPinnedProduct(null);
      }
    });

    return () => unsubscribe();
  }, [isAdmin]);

  // Host Media Controls (Admin Only)
  const [cameraEnabled, setCameraEnabled] = useState<boolean>(true);
  const [micEnabled, setMicEnabled] = useState<boolean>(true);
  const micEnabledRef = useRef<boolean>(true);
  micEnabledRef.current = micEnabled;
  const [screenShareEnabled, setScreenShareEnabled] = useState<boolean>(false);
  const [noiseFilterActive, setNoiseFilterActive] = useState<boolean>(true);
  const noiseFilterActiveRef = useRef<boolean>(true);
  noiseFilterActiveRef.current = noiseFilterActive;
  const [hostMicLevel, setHostMicLevel] = useState<number>(0);

  // Host Screen-Share PiP Layout State
  const [hostPipLayout, setHostPipLayout] = useState<{
    xPct: number;
    yPct: number;
    widthPct: number;
    zoom: number;
    visible: boolean;
  }>({
    xPct: 72,
    yPct: 5,
    widthPct: 25,
    zoom: 1,
    visible: true,
  });

  // Broadcast Mode for Admin: WebRTC Camera or OBS Studio (WHIP / RTMP)
  const [streamSourceMode, setStreamSourceMode] = useState<'camera' | 'obs'>('camera');
  const [isOBSModalOpen, setIsOBSModalOpen] = useState<boolean>(false);
  const [obsConfig, setOBSConfig] = useState<OBSConfigInfo | null>(null);
  const [activeQualityLayer, setActiveQualityLayer] = useState<'Tự động' | '1080p' | '720p' | '360p'>('Tự động');
  const [availableVideoDevices, setAvailableVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  // Receiver Video & Audio State for Guest
  const [hasReceivedLiveVideo, setHasReceivedLiveVideo] = useState<boolean>(false);
  const [hasReceivedLiveAudio, setHasReceivedLiveAudio] = useState<boolean>(false);
  const hasReceivedLiveAudioRef = useRef<boolean>(false);
  const [hasWebRTCVideoPixels, setHasWebRTCVideoPixels] = useState<boolean>(false);
  const hasWebRTCVideoPixelsRef = useRef<boolean>(false);
  const webrtcAudioLiveRef = useRef<boolean>(false);
  const liveKitAudioLiveRef = useRef<boolean>(false);
  const hasLiveDirectAudio = () => Boolean(webrtcAudioLiveRef.current || liveKitAudioLiveRef.current);
  const currentGuestAudioTrackIdRef = useRef<string>('');
  const [hasCanvasFrame, setHasCanvasFrame] = useState<boolean>(false);
  const [rtcReconnectNonce, setRtcReconnectNonce] = useState<number>(0);
  const [hostCamEnabled, setHostCamEnabled] = useState<boolean>(true);

  // Connection & Participant State (100% Real connected viewers only)
  const [connectionState, setConnectionState] = useState<string>('connected');
  const [participants, setParticipants] = useState<LiveViewerInfo[]>([
    {
      id: currentUserId,
      name: currentUserName,
      isAdmin,
      isRegisteredCustomer: Boolean(currentUser && !isAdmin),
      email: currentUser?.email,
      roleBadge: isAdmin ? '👑 Quản Lý Showroom' : (currentUser ? '⭐ Thành Viên Đã Đăng Ký' : '👤 Khách Trực Tuyến'),
      joinedAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      isOnline: true,
    }
  ]);
  const participantsRef = useRef<LiveViewerInfo[]>(participants);
  participantsRef.current = participants;
  const [isKicked, setIsKicked] = useState<boolean>(false);

  const hasAllViewersDirectTransport = (): boolean => {
    if (liveKitManagerRef.current?.isRoomConnected()) return true;
    const connectedPeers = hostBroadcasterRef.current?.getConnectedPeersCount() ?? 0;
    if (connectedPeers <= 0) return false;
    const remoteViewersCount = participantsRef.current.filter((p) => !p.isAdmin).length;
    return remoteViewersCount > 0 && connectedPeers >= remoteViewersCount;
  };

  // Keep viewers count strictly in sync with real participants list
  useEffect(() => {
    setViewersCount(participants.length > 0 ? participants.length : 1);
  }, [participants]);

  // 100% Real-Time Live Chat Synchronization via Firestore (Works on Vercel, scoped to active session)
  useEffect(() => {
    if (!isLive) {
      setMessages([createDefaultWelcomeMessage()]);
      return;
    }

    const unsubChats = subscribeToLiveChatMessages((cloudMessages) => {
      const welcome = createDefaultWelcomeMessage();
      if (cloudMessages && cloudMessages.length > 0) {
        const hasWelcome = cloudMessages.some((m) => m.id === 'm-welcome');
        setMessages(hasWelcome ? cloudMessages : [welcome, ...cloudMessages]);
      } else {
        setMessages([welcome]);
      }
      requestAnimationFrame(() => {
        if (chatContainerRef.current) {
          chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
      });
    }, liveSessionId);
    return () => unsubChats();
  }, [isLive, liveSessionId]);

  // 100% Real-Time Viewers Presence & Kick Management via Firestore (Works on Vercel, scoped to active session)
  useEffect(() => {
    if (!isLive) return;

    let isDisposed = false;
    let cleanupPresence: (() => void) | null = null;

    const baseViewerData: LiveViewerInfo = {
      id: currentUserId,
      name: currentUserName,
      isAdmin,
      isRegisteredCustomer: Boolean(currentUser && !isAdmin),
      email: currentUser?.email || '',
      roleBadge: isAdmin ? '👑 Quản Lý Showroom' : (currentUser ? '⭐ Thành Viên Đã Đăng Ký' : '👤 Khách Trực Tuyến'),
      joinedAt: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      isOnline: true
    };

    getRealClientPublicIp().then((realIp) => {
      if (isDisposed) return;
      const viewerWithIp: LiveViewerInfo = {
        ...baseViewerData,
        ...(realIp ? { ip: realIp } : {}),
      };
      cleanupPresence = registerLiveViewerPresence(viewerWithIp, () => {
        setIsKicked(true);
        showToast('🚫 BẠN ĐÃ BỊ MỜI RA KHỎI PHIÊN LIVE STREAM!', 'error');
      }, liveSessionId);
    });

    const unsubViewers = subscribeToLiveViewers((activeViewers) => {
      if (activeViewers && activeViewers.length > 0) {
        setParticipants(activeViewers);
        setViewersCount(activeViewers.length);
      } else {
        setParticipants([baseViewerData]);
        setViewersCount(1);
      }
    }, liveSessionId);

    return () => {
      isDisposed = true;
      if (cleanupPresence) cleanupPresence();
      unsubViewers();
    };
  }, [isLive, liveSessionId, currentUserId, currentUserName, isAdmin, currentUser]);

  // Media & Broadcaster Refs
  const stageContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hostCamSourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestVideoRef = useRef<HTMLVideoElement | null>(null);
  const guestAudioRef = useRef<HTMLAudioElement | null>(null);
  const guestCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenShareVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const compositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositeStreamRef = useRef<MediaStream | null>(null);
  const liveKitManagerRef = useRef<LiveKitStreamManager | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const cameraEnabledRef = useRef<boolean>(cameraEnabled);
  cameraEnabledRef.current = cameraEnabled;
  const screenShareEnabledRef = useRef<boolean>(screenShareEnabled);
  screenShareEnabledRef.current = screenShareEnabled;
  const hostPipLayoutRef = useRef(hostPipLayout);
  hostPipLayoutRef.current = hostPipLayout;

  // WebRTC Broadcaster & Audio Mixer Refs (Zero Latency 60 FPS & HD Sound)
  const hostBroadcasterRef = useRef<HostWebRTCController | null>(null);
  const audioMixerContextRef = useRef<AudioContext | null>(null);
  const micAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const screenAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micSourceStreamRef = useRef<MediaStream | null>(null);
  const screenAudioSourceStreamRef = useRef<MediaStream | null>(null);
  const audioKeepaliveGainRef = useRef<GainNode | null>(null);
  const audioMixerCompressorRef = useRef<DynamicsCompressorNode | null>(null);
  const audioMixerDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const activeRelayAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const lastPublishedAudioTrackIdRef = useRef<string>('');
  const activeBroadcastStreamRef = useRef<MediaStream | null>(null);
  const remoteLiveKitAudioRef = useRef<HTMLAudioElement | null>(null);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const lastRenderedVideoTsRef = useRef<number>(0);
  const relayOffscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isEncodingCloudFrameRef = useRef<boolean>(false);

  const renderGuestRelayFrame = (frameUrl: string, frameTs?: number) => {
    if (!frameUrl || hasWebRTCVideoPixelsRef.current) return;
    if (typeof frameTs === 'number' && frameTs > 0) {
      if (frameTs <= lastRenderedVideoTsRef.current) return;
      lastRenderedVideoTsRef.current = frameTs;
    }
    setHostCamEnabled(true);
    setHasReceivedLiveVideo(true);
    setHasCanvasFrame(true);

    const canvas = guestCanvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const targetCanvas = guestCanvasRef.current;
      if (!targetCanvas || hasWebRTCVideoPixelsRef.current) return;
      if (typeof frameTs === 'number' && frameTs > 0 && frameTs < lastRenderedVideoTsRef.current) {
        return;
      }
      const nextW = Math.min(1280, img.naturalWidth || 1024);
      const nextH = Math.min(720, img.naturalHeight || 576);
      if (nextW > 0 && nextH > 0 && (targetCanvas.width !== nextW || targetCanvas.height !== nextH)) {
        targetCanvas.width = nextW;
        targetCanvas.height = nextH;
      }
      const ctx = targetCanvas.getContext('2d', { alpha: false }) || targetCanvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetCanvas.width, targetCanvas.height);
      }
    };
    img.src = frameUrl;
  };

  // Guest Audio Volume & Unmute State
  const [isGuestAudioMuted, setIsGuestAudioMuted] = useState<boolean>(false);
  const isGuestAudioMutedRef = useRef<boolean>(false);
  isGuestAudioMutedRef.current = isGuestAudioMuted;
  const guestExplicitMutedRef = useRef<boolean>(false);
  const [guestVolume, setGuestVolume] = useState<number>(1);
  const guestVolumeRef = useRef<number>(1);
  useEffect(() => {
    guestVolumeRef.current = guestVolume;
    setGuestRelayAudioState(isGuestAudioMuted, guestVolume);
  }, [guestVolume, isGuestAudioMuted]);

  // Chat & Attachments State - Only official Host welcome announcement initially
  const [messages, setMessages] = useState<LiveChatMessage[]>([
    {
      id: 'm-welcome',
      senderId: 'admin_nptteam',
      senderName: 'nptteam',
      senderBadge: '👑 HOST / QUẢN LÝ',
      isAdmin: true,
      text: 'Chào mừng tất cả anh em Tokufan đến với buổi Live Stream chính hãng NPTTEAMSTORE! Anh em cần test âm thanh đai nào hãy bình luận bên dưới nhé!',
      timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);

  const [inputMessage, setInputMessage] = useState<string>('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [attachedFile, setAttachedFile] = useState<{ name: string; size: number; url: string; type: string } | null>(null);
  
  // UI Tabs & Modals
  const [chatTab, setChatTab] = useState<'chat' | 'viewers' | 'products'>('chat');
  const [isPinModalOpen, setIsPinModalOpen] = useState<boolean>(false);
  const [selectedImageLightbox, setSelectedImageLightbox] = useState<string | null>(null);
  const [floatingHearts, setFloatingHearts] = useState<FloatingHeart[]>([]);

  // Fetch OBS Studio configurations
  useEffect(() => {
    if (isAdmin) {
      fetch('/api/live/obs-config')
        .then(res => {
          if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
            return null;
          }
          return res.json();
        })
        .then(data => {
          if (data) setOBSConfig(data);
        })
        .catch(() => {});
    }
  }, [isAdmin]);

  // Auto-scroll chat to bottom inside chat container ONLY (STRICTLY prevents window scrolling down to footer)
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = (force = false) => {
    const el = chatContainerRef.current;
    if (el) {
       const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 160;
       if (isAtBottom || force) {
         const currentWindowY = window.scrollY;
         el.scrollTop = el.scrollHeight;
         // Enforce window scroll position remains fixed (never jump to footer)
         if (window.scrollY !== currentWindowY) {
           window.scrollTo({ top: currentWindowY, behavior: 'instant' as ScrollBehavior });
         }
       }
    }
  };
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Sync user changes to LiveKit Manager & WebSocket
  useEffect(() => {
    if (liveKitManagerRef.current) {
      liveKitManagerRef.current.sendDataMessage({
        type: 'JOIN',
        user: {
          id: currentUserId,
          name: currentUserName,
          isAdmin,
          isRegisteredCustomer: Boolean(currentUser && !isAdmin),
          email: currentUser?.email || '',
        }
      });
    }
  }, [currentUser, isAdmin, currentUserId, currentUserName]);

  // Initialize LiveKit & WebSocket Connection
  useEffect(() => {
    const manager = new LiveKitStreamManager();
    liveKitManagerRef.current = manager;

    const processLiveDataMessage = (data: any) => {
      if (!data) return;
      if (data.type === 'SESSION_RESET') {
        const nextId = data.sessionId || '';
        if (!nextId || nextId !== liveSessionIdRef.current) {
          resetLocalLiveSessionState(nextId);
        }
      } else if (data.type === 'CHAT') {
        if (data.sessionId && liveSessionIdRef.current && data.sessionId !== liveSessionIdRef.current) {
          return;
        }
        if (data.message) {
          setMessages(prev => {
            if (prev.some(m => m.id === data.message.id)) return prev;
            return [...prev, data.message];
          });
        }
      } else if (data.type === 'VIEWERS_UPDATE' && Array.isArray(data.viewers)) {
        setParticipants(data.viewers);
        setViewersCount(data.viewers.length > 0 ? data.viewers.length : 1);
      } else if (data.type === 'HEART') {
        triggerHeartAnimation(data.x || Math.random() * 80 + 10);
      } else if (data.type === 'PIN_PRODUCT') {
        if (data.product) {
          setPinnedProduct(data.product);
          setIsPinnedProductCollapsed(false);
          showToast(`📌 Quản lý đã ghim sản phẩm: ${data.product.name}`, 'info');
        } else {
          setPinnedProduct(null);
        }
      } else if (data.type === 'KICK_VIEWER') {
        if (data.targetUserId === currentUserId) {
          setIsKicked(true);
          showToast('🚫 BẠN ĐÃ BỊ MỜI RA KHỎI PHIÊN LIVE STREAM!', 'error');
        } else {
          setParticipants(prev => prev.filter(p => p.id !== data.targetUserId));
        }
      } else if (data.type === 'LIVE_STATE') {
        // Ignore cold WS handshake { isLive: false } unless Host actually ended the active live session
        if (data.isLive === false && !prevIsLiveRef.current && !data.reason) {
          return;
        }
        if (data.sessionId && data.sessionId !== liveSessionIdRef.current) {
          resetLocalLiveSessionState(data.sessionId);
        } else if (data.isLive === false) {
          resetLocalLiveSessionState('');
        }
        prevIsLiveRef.current = Boolean(data.isLive);
        setIsLive(data.isLive);
        if (data.title) setStreamTitle(data.title);
      } else if (data.type === 'CAM_STATE') {
        setHostCamEnabled(data.enabled);
      } else if (data.type === 'VIDEO_FRAME' && !isActiveHostRef.current && data.frame) {
        if (data.sessionId && liveSessionIdRef.current && data.sessionId !== liveSessionIdRef.current) {
          return;
        }
        // Skip heavy canvas redraw & React state updates once 60 FPS WebRTC P2P video is already decoding
        if (hasWebRTCVideoPixelsRef.current) {
          return;
        }
        renderGuestRelayFrame(data.frame, typeof data.t === 'number' ? data.t : undefined);
      } else if (data.type === 'AUDIO_CHUNK' && !isActiveHostRef.current && (data.audio || data.pcm || (Array.isArray(data.packets) && data.packets.length > 0))) {
        if (data.sessionId && liveSessionIdRef.current && data.sessionId !== liveSessionIdRef.current) {
          return;
        }
        if (!hasReceivedLiveAudioRef.current) {
          hasReceivedLiveAudioRef.current = true;
          setHasReceivedLiveAudio(true);
        }
        if (!hasLiveDirectAudio()) {
          playAudioRelayPayload(data);
        }
      }
    };

    // Initialize WebSocket Signaling Connection immediately
    manager.setupSignalingWebSocket({
      onDataReceived: (data) => processLiveDataMessage(data),
      onParticipantListChanged: (list) => {
        if (list && list.length > 0) {
          setParticipants(list);
          setViewersCount(list.length);
        }
      },
      onConnectionStateChange: (state) => {
        setConnectionState(state);
      },
    });

    // Subscribe to Cloud Firestore + BroadcastChannel + WebSocket Live Feed
    const unsubscribeFeed = subscribeToLiveFeed((data) => {
      processLiveDataMessage(data);
    });

    const setupLiveStream = async () => {
      try {
        const tokenRes = await manager.getLiveKitToken(
          'npt-official-room',
          currentUserId,
          currentUserName,
          isAdmin,
          currentUser?.email,
          Boolean(currentUser && !isAdmin)
        );

        await manager.connectToRoom(tokenRes.url, tokenRes.token, {
          onRemoteTrackSubscribed: (track) => {
            // LiveKit WebRTC Track received from OBS or Host Browser
            setHostCamEnabled(true);
            if (guestVideoRef.current && track.kind === 'video') {
              track.attach(guestVideoRef.current);
              guestVideoRef.current.play().catch(() => {});
            } else if (track.kind === 'audio') {
              if (!remoteLiveKitAudioRef.current) {
                const audioEl = document.createElement('audio');
                audioEl.autoplay = true;
                remoteLiveKitAudioRef.current = audioEl;
              }
              track.attach(remoteLiveKitAudioRef.current);
              const mst = (track as any).mediaStreamTrack as MediaStreamTrack | undefined;
              liveKitAudioLiveRef.current = mst ? (mst.readyState === 'live' && !mst.muted) : true;
              if (!hasReceivedLiveAudioRef.current) {
                hasReceivedLiveAudioRef.current = true;
                setHasReceivedLiveAudio(true);
              }
              if (mst) {
                mst.onunmute = () => {
                  liveKitAudioLiveRef.current = true;
                };
                mst.onmute = () => {
                  liveKitAudioLiveRef.current = false;
                };
                mst.onended = () => {
                  liveKitAudioLiveRef.current = false;
                };
              }
              const shouldMute = guestExplicitMutedRef.current;
              remoteLiveKitAudioRef.current.muted = shouldMute;
              remoteLiveKitAudioRef.current.volume = guestVolumeRef.current;
              if (!shouldMute) {
                remoteLiveKitAudioRef.current.play().catch(() => {
                  if (remoteLiveKitAudioRef.current) remoteLiveKitAudioRef.current.muted = true;
                  isGuestAudioMutedRef.current = true;
                  setIsGuestAudioMuted(true);
                });
              }
            }
          },
          onRemoteTrackUnsubscribed: (track) => {
            if (guestVideoRef.current && track.kind === 'video') {
              track.detach(guestVideoRef.current);
            } else if (remoteLiveKitAudioRef.current && track.kind === 'audio') {
              liveKitAudioLiveRef.current = false;
              track.detach(remoteLiveKitAudioRef.current);
            }
          },
          onDataReceived: (data) => {
            processLiveDataMessage(data);
          },
          onParticipantListChanged: (list) => {
            if (list && list.length > 0) {
              setParticipants(list);
              setViewersCount(list.length);
            }
          },
          onConnectionStateChange: (state) => {
            setConnectionState(state);
            if (state === 'connected' && isAdmin && isBroadcastingHostRef.current && manager.isRoomConnected()) {
              if (localStreamRef.current) {
                manager.publishCameraAndMic(videoRef.current, localStreamRef.current).then(() => {
                  updateHostAudioMix({ forceSync: true });
                }).catch(() => {});
              }
              if (screenShareEnabledRef.current) {
                const scrTrack = compositeStreamRef.current?.getVideoTracks()[0] || screenStreamRef.current?.getVideoTracks()[0] || null;
                if (scrTrack) {
                  manager.toggleScreenShare(true, scrTrack).catch(() => {});
                }
              }
            }
          },
        });
      } catch (err) {
        console.warn('LiveKit setup fallback:', err);
      }
    };

    setupLiveStream();

    return () => {
      unsubscribeFeed();
      manager.disconnect();
    };
  }, [isAdmin, currentUserId, currentUserName, currentUser]);

  // Helper to get or create host audio mixer ONLY when mixing mic + screen system audio
  const getAudioMixer = () => {
    if (!audioMixerContextRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioMixerContextRef.current = new AudioCtx();
    }
    const ctx = audioMixerContextRef.current;
    if (ctx.state === 'suspended') {
      ctx.resume()
        .then(() => {
          if (ctx.state === 'running' && isBroadcastingHostRef.current) {
            updateHostAudioMix({ forceSync: true });
          }
        })
        .catch(() => {});
    }
    if (!audioMixerDestinationRef.current) {
      audioMixerDestinationRef.current = ctx.createMediaStreamDestination();
    }
    if (!audioKeepaliveGainRef.current) {
      const keepalive = ctx.createGain();
      keepalive.gain.setValueAtTime(0, ctx.currentTime);
      keepalive.connect(ctx.destination);
      audioKeepaliveGainRef.current = keepalive;
    }
    if (!audioMixerCompressorRef.current) {
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-18, ctx.currentTime);
      limiter.knee.setValueAtTime(14, ctx.currentTime);
      limiter.ratio.setValueAtTime(5, ctx.currentTime);
      limiter.attack.setValueAtTime(0.003, ctx.currentTime);
      limiter.release.setValueAtTime(0.14, ctx.currentTime);
      limiter.connect(audioMixerDestinationRef.current);
      limiter.connect(audioKeepaliveGainRef.current);
      audioMixerCompressorRef.current = limiter;
    }
    return {
      ctx,
      destination: audioMixerDestinationRef.current,
      keepalive: audioKeepaliveGainRef.current,
      mixerBus: audioMixerCompressorRef.current,
    };
  };

  const updateHostAudioMix = (overrides?: {
    micEnabled?: boolean;
    noiseFilterActive?: boolean;
    screenShareEnabled?: boolean;
    forceSync?: boolean;
  }): MediaStreamTrack | null => {
    try {
      const effectiveMic = overrides?.micEnabled ?? micEnabledRef.current;
      const effectiveNoiseFilter = overrides?.noiseFilterActive ?? noiseFilterActiveRef.current;
      const effectiveScreenShare = overrides?.screenShareEnabled ?? screenShareEnabledRef.current;

      const rawMicTrack = localStreamRef.current?.getAudioTracks().find((t) => t.readyState === 'live') || null;
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = effectiveMic;
        });
      }

      const rawScreenAudioTrack = screenStreamRef.current?.getAudioTracks().find((t) => t.readyState === 'live') || null;
      const hasActiveMic = Boolean(effectiveMic && rawMicTrack && rawMicTrack.readyState === 'live');
      const hasActiveScreenAudio = Boolean(
        effectiveScreenShare &&
        rawScreenAudioTrack &&
        rawScreenAudioTrack.readyState === 'live' &&
        rawScreenAudioTrack.enabled
      );

      // Disconnect previous mixer nodes cleanly
      if (micAudioSourceRef.current) {
        try { micAudioSourceRef.current.disconnect(); } catch {}
        micAudioSourceRef.current = null;
      }
      if (screenAudioSourceRef.current) {
        try { screenAudioSourceRef.current.disconnect(); } catch {}
        screenAudioSourceRef.current = null;
      }
      micSourceStreamRef.current = null;
      screenAudioSourceStreamRef.current = null;

      let selectedAudioTrack: MediaStreamTrack | null = null;

      // Boost distant Host mic voice through WebAudio DynamicsCompressor whenever mixer AudioContext is running,
      // and fall back cleanly to rawMicTrack if AudioContext is still suspended.
      if (hasActiveScreenAudio || hasActiveMic) {
        const { ctx, destination, mixerBus } = getAudioMixer();
        if (ctx.state === 'running') {
          if (hasActiveMic && rawMicTrack) {
            const micStream = new MediaStream([rawMicTrack]);
            micSourceStreamRef.current = micStream;
            const micSource = ctx.createMediaStreamSource(micStream);
            micAudioSourceRef.current = micSource;

            const micBoost = ctx.createGain();
            micBoost.gain.setValueAtTime(1.55, ctx.currentTime);

            if (effectiveNoiseFilter) {
              const highPass = ctx.createBiquadFilter();
              highPass.type = 'highpass';
              highPass.frequency.setValueAtTime(75, ctx.currentTime);
              const presence = ctx.createBiquadFilter();
              presence.type = 'peaking';
              presence.frequency.setValueAtTime(2600, ctx.currentTime);
              presence.Q.setValueAtTime(1.0, ctx.currentTime);
              presence.gain.setValueAtTime(2.8, ctx.currentTime);

              micSource.connect(highPass);
              highPass.connect(presence);
              presence.connect(micBoost);
              micBoost.connect(mixerBus);
            } else {
              micSource.connect(micBoost);
              micBoost.connect(mixerBus);
            }
          }

          if (hasActiveScreenAudio && rawScreenAudioTrack) {
            const screenAudioStream = new MediaStream([rawScreenAudioTrack]);
            screenAudioSourceStreamRef.current = screenAudioStream;
            const screenSource = ctx.createMediaStreamSource(screenAudioStream);
            screenAudioSourceRef.current = screenSource;

            const screenGain = ctx.createGain();
            screenGain.gain.setValueAtTime(0.85, ctx.currentTime);
            screenSource.connect(screenGain);
            screenGain.connect(mixerBus);
          }

          selectedAudioTrack = destination.stream.getAudioTracks()[0] || rawMicTrack || rawScreenAudioTrack;
        } else {
          selectedAudioTrack = (hasActiveMic ? rawMicTrack : null) || rawScreenAudioTrack || rawMicTrack;
        }
      } else if (rawMicTrack && rawMicTrack.readyState === 'live') {
        selectedAudioTrack = rawMicTrack;
      } else {
        selectedAudioTrack = null;
      }

      activeRelayAudioTrackRef.current = selectedAudioTrack;

      const nextTrackId = selectedAudioTrack ? `${selectedAudioTrack.id}:${effectiveMic || hasActiveScreenAudio ? '1' : '0'}` : '';
      const trackChanged = overrides?.forceSync || nextTrackId !== lastPublishedAudioTrackIdRef.current;

      if (trackChanged) {
        lastPublishedAudioTrackIdRef.current = nextTrackId;
        if (hostBroadcasterRef.current) {
          hostBroadcasterRef.current.replaceAudioTrack(selectedAudioTrack);
        }
        if (liveKitManagerRef.current?.isRoomConnected()) {
          liveKitManagerRef.current.syncAudioTrack(selectedAudioTrack, Boolean(effectiveMic || hasActiveScreenAudio));
        }
      }
      return selectedAudioTrack;
    } catch (e) {
      console.warn('Audio mixer update note:', e);
      return localStreamRef.current?.getAudioTracks()[0] || null;
    }
  };

  // Unlock AudioContext on any Host interaction if browser suspended it
  useEffect(() => {
    if (!isAdmin || !isLive || !isBroadcastingHost) return;
    const unlockMixer = () => {
      const ctx = audioMixerContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume()
          .then(() => {
            if (ctx.state === 'running') {
              updateHostAudioMix({ forceSync: true });
            }
          })
          .catch(() => {});
      }
    };
    window.addEventListener('pointerdown', unlockMixer, { passive: true });
    window.addEventListener('touchstart', unlockMixer, { passive: true });
    window.addEventListener('keydown', unlockMixer, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockMixer);
      window.removeEventListener('touchstart', unlockMixer);
      window.removeEventListener('keydown', unlockMixer);
    };
  }, [isAdmin, isLive, isBroadcastingHost]);

  // WebRTC Host Stream Signaling (0ms Latency 30-60 FPS P2P Broadcast)
  useEffect(() => {
    if (isAdmin && isLive && isBroadcastingHost) {
      const initialAudioTrack = updateHostAudioMix();
      const audioTrack =
        initialAudioTrack ||
        localStreamRef.current?.getAudioTracks()[0] ||
        null;
      const videoTrack = screenShareEnabledRef.current
        ? (compositeStreamRef.current?.getVideoTracks()[0] || screenStreamRef.current?.getVideoTracks()[0])
        : localStreamRef.current?.getVideoTracks()[0];

      const broadcastStream = new MediaStream();
      if (videoTrack) broadcastStream.addTrack(videoTrack);
      if (audioTrack) broadcastStream.addTrack(audioTrack);
      activeBroadcastStreamRef.current = broadcastStream;

      const broadcaster = startHostWebRTCStream(broadcastStream);
      hostBroadcasterRef.current = broadcaster;

      return () => {
        broadcaster.stop();
        hostBroadcasterRef.current = null;
      };
    }
  }, [isAdmin, isLive, isBroadcastingHost, liveSessionId]);

  // Continuous Host Mic Watchdog & Live Hardware Auto-Recovery + Passive VU Voice Level Meter
  useEffect(() => {
    if (!isAdmin || !isLive || !isBroadcastingHost || !micEnabled) {
      setHostMicLevel(0);
      return;
    }

    let isCancelled = false;
    let isRecovering = false;
    let meterCtx: AudioContext | null = null;
    let meterSource: MediaStreamAudioSourceNode | null = null;
    let meterAnalyser: AnalyserNode | null = null;
    let meterTrackId = '';
    let mutedStreak = 0;

    const ensureMicHealthy = async () => {
      if (isCancelled || isRecovering || !micEnabledRef.current) return;
      const liveMicTrack = localStreamRef.current?.getAudioTracks().find((t) => t.readyState === 'live') || null;
      if (liveMicTrack) {
        liveMicTrack.enabled = true;
        mutedStreak = liveMicTrack.muted ? mutedStreak + 1 : 0;
        if (!liveMicTrack.onended) {
          liveMicTrack.onended = () => {
            if (!isCancelled && micEnabledRef.current) {
              ensureMicHealthy();
            }
          };
        }
        // Attach passive analyser tap for Host VU bar without touching transmitted audio track
        if (meterTrackId !== liveMicTrack.id) {
          try {
            if (meterSource) {
              try { meterSource.disconnect(); } catch {}
              meterSource = null;
            }
            if (!meterCtx) {
              const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
              meterCtx = new AudioCtx();
            }
            if (meterCtx.state === 'suspended') {
              meterCtx.resume().catch(() => {});
            }
            meterAnalyser = meterCtx.createAnalyser();
            meterAnalyser.fftSize = 256;
            meterSource = meterCtx.createMediaStreamSource(new MediaStream([liveMicTrack]));
            meterSource.connect(meterAnalyser);
            meterTrackId = liveMicTrack.id;
          } catch {}
        }
        if (mutedStreak < 3) {
          return;
        }
        mutedStreak = 0;
      }

      isRecovering = true;
      try {
        const micTrack = await acquireFallbackMicTrack();
        if (micTrack && !isCancelled) {
          micTrack.enabled = micEnabledRef.current;
          micTrack.onended = () => {
            if (!isCancelled && micEnabledRef.current) {
              ensureMicHealthy();
            }
          };
          if (!localStreamRef.current) {
            localStreamRef.current = new MediaStream([micTrack]);
          } else {
            localStreamRef.current.getAudioTracks().forEach((old) => {
              if (old.readyState !== 'live') {
                localStreamRef.current?.removeTrack(old);
              }
            });
            localStreamRef.current.addTrack(micTrack);
          }
          updateHostAudioMix({ micEnabled: micEnabledRef.current, forceSync: true });
        }
      } finally {
        isRecovering = false;
      }
    };

    const initialTimer = setTimeout(ensureMicHealthy, 350);
    const watchdogInterval = setInterval(ensureMicHealthy, 2200);
    const meterData = new Uint8Array(128);
    const vuInterval = setInterval(() => {
      if (isCancelled || !meterAnalyser || !micEnabledRef.current) {
        setHostMicLevel(0);
        return;
      }
      if (meterCtx && meterCtx.state === 'suspended') {
        meterCtx.resume().catch(() => {});
      }
      try {
        meterAnalyser.getByteTimeDomainData(meterData);
        let sumSq = 0;
        for (let i = 0; i < meterData.length; i++) {
          const v = (meterData[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / meterData.length);
        const level = Math.min(100, Math.round(rms * 380));
        setHostMicLevel(level);
      } catch {
        setHostMicLevel(0);
      }
    }, 100);

    return () => {
      isCancelled = true;
      clearTimeout(initialTimer);
      clearInterval(watchdogInterval);
      clearInterval(vuInterval);
      if (meterSource) {
        try { meterSource.disconnect(); } catch {}
      }
      if (meterCtx) {
        try { meterCtx.close(); } catch {}
      }
      setHostMicLevel(0);
    };
  }, [isAdmin, isLive, isBroadcastingHost, micEnabled, liveSessionId]);

  // Strict-NAT Fallback PCM16 Audio Relay (Self-contained 16kHz Int16 frames -> ZERO MediaRecorder headerless chunk drops!)
  useEffect(() => {
    if (!isAdmin || !isLive || !isBroadcastingHost || (!micEnabled && !screenShareEnabled)) return;

    let isDisposed = false;
    let ownedCaptureCtx: AudioContext | null = null;
    let activeCaptureCtx: AudioContext | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let processorNode: ScriptProcessorNode | null = null;
    let silentGainNode: GainNode | null = null;
    let activeTrackId = '';
    let pcmAccum: number[] = [];

    const TARGET_SR = 16000;
    const SAMPLES_PER_PACKET = 1600; // 100ms low-latency packet (~3.2 KB binary)

    const encodeAndSendPcmPacket = (int16Arr: Int16Array) => {
      const bytes = new Uint8Array(int16Arr.buffer);
      let binary = '';
      const chunkLen = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkLen) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkLen));
      }
      const b64 = btoa(binary);
      publishLiveAudioChunkToCloud(
        { format: 'pcm16', sr: TARGET_SR, pcm: b64 },
        liveSessionIdRef.current
      );
    };

    const stopCapture = () => {
      if (processorNode) {
        processorNode.onaudioprocess = null;
        try { processorNode.disconnect(); } catch {}
        processorNode = null;
      }
      if (sourceNode) {
        try { sourceNode.disconnect(); } catch {}
        sourceNode = null;
      }
      if (silentGainNode) {
        try { silentGainNode.disconnect(); } catch {}
        silentGainNode = null;
      }
      if (ownedCaptureCtx) {
        try { ownedCaptureCtx.close(); } catch {}
        ownedCaptureCtx = null;
      }
      activeCaptureCtx = null;
      activeTrackId = '';
      pcmAccum = [];
    };

    const ensurePcmRelay = () => {
      if (isDisposed) {
        stopCapture();
        return;
      }
      if (hasAllViewersDirectTransport()) {
        stopCapture();
        return;
      }

      const candidateTrack =
        activeRelayAudioTrackRef.current?.readyState === 'live'
          ? activeRelayAudioTrackRef.current
          : localStreamRef.current?.getAudioTracks().find((t) => t.readyState === 'live' && t.enabled) || null;

      if (!candidateTrack || (!micEnabledRef.current && !screenShareEnabledRef.current)) {
        stopCapture();
        return;
      }

      if (processorNode && activeTrackId === candidateTrack.id) {
        if (activeCaptureCtx && activeCaptureCtx.state === 'suspended') {
          activeCaptureCtx.resume().catch(() => {});
        }
        return;
      }

      stopCapture();
      try {
        // Reuse the user-gesture-unlocked shared AudioContext whenever possible so mobile/Chrome never silently suspends PCM capture
        let ctx: AudioContext | null = null;
        try {
          ctx = getAudioMixer().ctx;
        } catch {}
        if (!ctx || ctx.state === 'closed') {
          const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
          ctx = new AudioCtx();
          ownedCaptureCtx = ctx;
        }
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const inputRate = ctx.sampleRate || 48000;
        const ratio = inputRate / TARGET_SR;

        const src = ctx.createMediaStreamSource(new MediaStream([candidateTrack]));
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const zeroGain = ctx.createGain();
        zeroGain.gain.setValueAtTime(0, ctx.currentTime);

        proc.onaudioprocess = (ev) => {
          if (isDisposed) return;
          if (hasAllViewersDirectTransport()) {
            return;
          }
          if (!micEnabledRef.current && !screenShareEnabledRef.current) return;

          const inputData = ev.inputBuffer.getChannelData(0);
          // Linear resampling from inputRate (typically 48kHz) -> 16kHz with gentle voice boost & soft limiter for distant speakers
          const outCount = Math.floor(inputData.length / ratio);
          for (let i = 0; i < outCount; i++) {
            const pos = i * ratio;
            const idx = Math.floor(pos);
            const frac = pos - idx;
            const s0 = inputData[idx] ?? 0;
            const s1 = inputData[Math.min(idx + 1, inputData.length - 1)] ?? s0;
            const boosted = Math.tanh((s0 + (s1 - s0) * frac) * 1.65);
            const clamped = Math.max(-1, Math.min(1, boosted));
            pcmAccum.push(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767));
          }

          while (pcmAccum.length >= SAMPLES_PER_PACKET) {
            const slice = pcmAccum.splice(0, SAMPLES_PER_PACKET);
            encodeAndSendPcmPacket(new Int16Array(slice));
          }
        };

        src.connect(proc);
        proc.connect(zeroGain);
        zeroGain.connect(ctx.destination);

        activeCaptureCtx = ctx;
        sourceNode = src;
        processorNode = proc;
        silentGainNode = zeroGain;
        activeTrackId = candidateTrack.id;
      } catch {}
    };

    const resumeRelayCtx = () => {
      if (activeCaptureCtx && activeCaptureCtx.state === 'suspended') {
        activeCaptureCtx.resume().catch(() => {});
      }
      ensurePcmRelay();
    };
    window.addEventListener('pointerdown', resumeRelayCtx, { passive: true });
    window.addEventListener('touchstart', resumeRelayCtx, { passive: true });
    window.addEventListener('keydown', resumeRelayCtx, { passive: true });

    const startTimeout = setTimeout(ensurePcmRelay, 300);
    const checkTimer = setInterval(ensurePcmRelay, 1500);

    return () => {
      isDisposed = true;
      clearTimeout(startTimeout);
      clearInterval(checkTimer);
      window.removeEventListener('pointerdown', resumeRelayCtx);
      window.removeEventListener('touchstart', resumeRelayCtx);
      window.removeEventListener('keydown', resumeRelayCtx);
      stopCapture();
    };
  }, [isAdmin, isLive, isBroadcastingHost, micEnabled, screenShareEnabled, liveSessionId]);

  // WebRTC Guest Direct Video + Independent Audio Track Receiver (0ms Latency 60 FPS + Non-Glitch Audio)
  useEffect(() => {
    if (!isActiveHost && isLive) {
      webrtcAudioLiveRef.current = false;
      currentGuestAudioTrackIdRef.current = '';
      const stopGuestP2P = connectGuestWebRTCStream(
        (remoteStream) => {
          const videoTracks = remoteStream.getVideoTracks().filter((t) => t.readyState === 'live');
          const audioTracks = remoteStream.getAudioTracks().filter((t) => t.readyState === 'live');

          if (videoTracks.length > 0) {
            setHostCamEnabled(true);
            if (guestVideoRef.current) {
              const currentVidId = (guestVideoRef.current.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id || '';
              if (currentVidId !== videoTracks[0].id) {
                const videoOnlyStream = new MediaStream(videoTracks);
                guestVideoRef.current.srcObject = videoOnlyStream;
              }
              guestVideoRef.current.muted = true; // Keep <video> muted so Chrome NEVER blocks 60 FPS video autoplay
              guestVideoRef.current.play().catch(() => {});
            }
          }

          if (audioTracks.length > 0) {
            const primaryAudioTrack = audioTracks[0];
            webrtcAudioLiveRef.current = primaryAudioTrack.readyState === 'live' && !primaryAudioTrack.muted;
            if (!hasReceivedLiveAudioRef.current) {
              hasReceivedLiveAudioRef.current = true;
              setHasReceivedLiveAudio(true);
            }

            primaryAudioTrack.onunmute = () => {
              webrtcAudioLiveRef.current = true;
            };
            primaryAudioTrack.onmute = () => {
              webrtcAudioLiveRef.current = false;
            };
            primaryAudioTrack.onended = () => {
              webrtcAudioLiveRef.current = false;
              currentGuestAudioTrackIdRef.current = '';
            };

            if (guestAudioRef.current) {
              const trackChanged = currentGuestAudioTrackIdRef.current !== primaryAudioTrack.id || !guestAudioRef.current.srcObject;
              if (trackChanged) {
                currentGuestAudioTrackIdRef.current = primaryAudioTrack.id;
                guestAudioRef.current.srcObject = new MediaStream(audioTracks);
              }
              const shouldMute = guestExplicitMutedRef.current;
              guestAudioRef.current.muted = shouldMute;
              guestAudioRef.current.volume = guestVolumeRef.current;
              if (!shouldMute) {
                guestAudioRef.current.play().catch(() => {
                  if (guestAudioRef.current) {
                    guestAudioRef.current.muted = true;
                  }
                  isGuestAudioMutedRef.current = true;
                  setIsGuestAudioMuted(true);
                });
              }
            }
          }
        },
        () => {
          webrtcAudioLiveRef.current = false;
          currentGuestAudioTrackIdRef.current = '';
          setRtcReconnectNonce((n) => (n < 8 ? n + 1 : n));
        }
      );
      return () => {
        webrtcAudioLiveRef.current = false;
        currentGuestAudioTrackIdRef.current = '';
        stopGuestP2P();
      };
    }
  }, [isActiveHost, isLive, liveSessionId, rtcReconnectNonce]);

  // Subscribe to Cloud Audio Chunk Relay for strict NATs when direct WebRTC/LiveKit audio isn't active
  useEffect(() => {
    if (isActiveHost || !isLive) return;
    const unsubAudioChunk = subscribeToLiveAudioChunk((data) => {
      if (!data) return;
      if (data.sessionId && liveSessionIdRef.current && data.sessionId !== liveSessionIdRef.current) {
        return;
      }
      if (!hasReceivedLiveAudioRef.current) {
        hasReceivedLiveAudioRef.current = true;
        setHasReceivedLiveAudio(true);
      }
      if (!hasLiveDirectAudio()) {
        playAudioRelayPayload(data);
      }
    });
    return () => unsubAudioChunk();
  }, [isActiveHost, isLive, liveSessionId]);

  // Unlock Guest audio automatically on first user gesture if browser blocked autoplay
  useEffect(() => {
    if (isActiveHost || !isLive) return;
    const onFirstUserUnlock = () => {
      if (guestExplicitMutedRef.current) return;
      unlockRelayAudioContext();
      if (isGuestAudioMutedRef.current) {
        const targetVol = guestVolumeRef.current || 1;
        setGuestRelayAudioState(false, targetVol);
        isGuestAudioMutedRef.current = false;
        setIsGuestAudioMuted(false);
        if (guestAudioRef.current) {
          guestAudioRef.current.muted = false;
          guestAudioRef.current.volume = targetVol;
          guestAudioRef.current.play().catch(() => {});
        }
        if (remoteLiveKitAudioRef.current) {
          remoteLiveKitAudioRef.current.muted = false;
          remoteLiveKitAudioRef.current.volume = targetVol;
          remoteLiveKitAudioRef.current.play().catch(() => {});
        }
      }
    };
    window.addEventListener('pointerdown', onFirstUserUnlock, { passive: true });
    window.addEventListener('keydown', onFirstUserUnlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onFirstUserUnlock);
      window.removeEventListener('keydown', onFirstUserUnlock);
    };
  }, [isActiveHost, isLive]);

  // Verify actual decoded WebRTC video pixels (never show opaque black <video> over <canvas> before frames decode)
  useEffect(() => {
    if (isActiveHost || !isLive) {
      hasWebRTCVideoPixelsRef.current = false;
      setHasWebRTCVideoPixels(false);
      return;
    }

    const checkInterval = setInterval(() => {
      const el = guestVideoRef.current;
      const hasPixels = Boolean(
        el &&
        el.srcObject &&
        el.videoWidth > 0 &&
        el.videoHeight > 0 &&
        !el.ended &&
        el.readyState >= 2
      );
      if (hasPixels !== hasWebRTCVideoPixelsRef.current) {
        hasWebRTCVideoPixelsRef.current = hasPixels;
        setHasWebRTCVideoPixels(hasPixels);
        if (hasPixels) {
          setHasReceivedLiveVideo(true);
        }
      }
    }, 450);

    return () => clearInterval(checkInterval);
  }, [isActiveHost, isLive, liveSessionId]);

  // Auto-retry WebRTC handshake gently if Guest hasn't received live P2P pixels yet (e.g. host opened cam/screen after guest joined)
  useEffect(() => {
    if (isActiveHost || !isLive || hasWebRTCVideoPixels) return;
    if (rtcReconnectNonce >= 18) return;
    const retryTimer = setTimeout(() => {
      if (!hasWebRTCVideoPixelsRef.current) {
        setRtcReconnectNonce((n) => n + 1);
      }
    }, rtcReconnectNonce < 3 ? 6000 : 15000);
    return () => clearTimeout(retryTimer);
  }, [isActiveHost, isLive, hasWebRTCVideoPixels, rtcReconnectNonce]);

  // Subscribe to Cloud Firestore + BroadcastChannel adaptive video frames (works 100% through strict firewalls/NATs on Vercel)
  useEffect(() => {
    if (isActiveHost || !isLive) return;
    const unsubCloudFrames = subscribeToLiveVideoFrame((data) => {
      if (!data || !data.frame) return;
      if (data.sessionId && liveSessionIdRef.current && data.sessionId !== liveSessionIdRef.current) {
        return;
      }
      if (hasWebRTCVideoPixelsRef.current) {
        return;
      }
      renderGuestRelayFrame(data.frame, typeof data.t === 'number' ? data.t : undefined);
    });

    return () => unsubCloudFrames();
  }, [isActiveHost, isLive, liveSessionId]);

  const handleUnmuteGuest = () => {
    const targetVol = guestVolume || 1;
    guestExplicitMutedRef.current = false;
    isGuestAudioMutedRef.current = false;
    unlockRelayAudioContext();
    setGuestRelayAudioState(false, targetVol);
    setIsGuestAudioMuted(false);
    if (guestAudioRef.current) {
      guestAudioRef.current.muted = false;
      guestAudioRef.current.volume = targetVol;
      guestAudioRef.current.play().catch(() => {});
    }
    if (remoteLiveKitAudioRef.current) {
      remoteLiveKitAudioRef.current.muted = false;
      remoteLiveKitAudioRef.current.volume = targetVol;
      remoteLiveKitAudioRef.current.play().catch(() => {});
    }
    showToast('🔊 Đã bật âm thanh Live Stream chuẩn HD!', 'success');
  };

  const handleToggleGuestMute = () => {
    const nextMuted = !isGuestAudioMuted;
    guestExplicitMutedRef.current = nextMuted;
    isGuestAudioMutedRef.current = nextMuted;
    if (!nextMuted) {
      unlockRelayAudioContext();
    }
    setGuestRelayAudioState(nextMuted, guestVolume || 1);
    setIsGuestAudioMuted(nextMuted);
    if (guestAudioRef.current) {
      guestAudioRef.current.muted = nextMuted;
      if (!nextMuted) {
        guestAudioRef.current.volume = guestVolume || 1;
        guestAudioRef.current.play().catch(() => {});
      }
    }
    if (remoteLiveKitAudioRef.current) {
      remoteLiveKitAudioRef.current.muted = nextMuted;
      if (!nextMuted) {
        remoteLiveKitAudioRef.current.volume = guestVolume || 1;
        remoteLiveKitAudioRef.current.play().catch(() => {});
      }
    }
  };

  const handleGuestVolumeChange = (newVol: number) => {
    setGuestVolume(newVol);
    const shouldUnmute = newVol > 0 && isGuestAudioMuted;
    if (shouldUnmute) {
      guestExplicitMutedRef.current = false;
      isGuestAudioMutedRef.current = false;
      unlockRelayAudioContext();
      setIsGuestAudioMuted(false);
    }
    setGuestRelayAudioState(shouldUnmute ? false : isGuestAudioMuted, newVol);
    if (guestAudioRef.current) {
      guestAudioRef.current.volume = newVol;
      if (shouldUnmute) {
        guestAudioRef.current.muted = false;
        guestAudioRef.current.play().catch(() => {});
      }
    }
    if (remoteLiveKitAudioRef.current) {
      remoteLiveKitAudioRef.current.volume = newVol;
      if (shouldUnmute) {
        remoteLiveKitAudioRef.current.muted = false;
        remoteLiveKitAudioRef.current.play().catch(() => {});
      }
    }
  };

  // Enumerate video devices for Admin
  useEffect(() => {
    if (!isAdmin) return;
    navigator.mediaDevices.enumerateDevices()
      .then(devices => {
        const videoInputs = devices.filter(d => d.kind === 'videoinput');
        setAvailableVideoDevices(videoInputs);
        const obsDevice = videoInputs.find(d => d.label.toLowerCase().includes('obs') || d.label.toLowerCase().includes('virtual'));
        if (obsDevice && !selectedDeviceId) {
          setSelectedDeviceId(obsDevice.deviceId);
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  // WebRTC Studio Audio Constraints for Acoustic Echo Cancellation (AEC), Dereverberation & HD Voice Pickup
  const AUDIO_VOICE_CONSTRAINTS: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: { ideal: 48000 },
    channelCount: { ideal: 1 },
  };

  const acquireFallbackMicTrack = async (): Promise<MediaStreamTrack | null> => {
    const audioAttempts: MediaStreamConstraints[] = [
      { video: false, audio: AUDIO_VOICE_CONSTRAINTS },
      { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
      { video: false, audio: true },
    ];
    for (const c of audioAttempts) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia(c);
        const track = audioStream.getAudioTracks()[0] || null;
        if (track) return track;
      } catch {}
    }
    return null;
  };

  // --- ADMIN CAMERA & MIC STREAM INITIALIZATION WITH SIMULCAST ---
  useEffect(() => {
    if (!isAdmin || !isLive || !isBroadcastingHost || streamSourceMode !== 'camera') return;
    let isCancelled = false;

    const tryGetUserMedia = async () => {
      const attempts: MediaStreamConstraints[] = [
        // Attempt 1: Specific device if selected
        ...(selectedDeviceId ? [{ video: { deviceId: { exact: selectedDeviceId } }, audio: AUDIO_VOICE_CONSTRAINTS }] : []),
        // Attempt 2: Standard webcam/virtual camera with HD audio
        { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: AUDIO_VOICE_CONSTRAINTS },
        // Attempt 3: Any video input with audio constraints
        { video: true, audio: AUDIO_VOICE_CONSTRAINTS },
        // Attempt 4: Basic video/audio
        { video: true, audio: true },
        // Attempt 5: Video only (will separately acquire mic below)
        { video: true, audio: false }
      ];

      for (const constraint of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraint);
          if (isCancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return null;
          }

          // If video-only succeeded or selected virtual cam omitted mic, acquire mic independently
          if (stream.getAudioTracks().length === 0) {
            const micTrack = await acquireFallbackMicTrack();
            if (micTrack) {
              if (isCancelled) {
                micTrack.stop();
                stream.getTracks().forEach((t) => t.stop());
                return null;
              }
              stream.addTrack(micTrack);
            }
          }

          stream.getAudioTracks().forEach((t) => {
            t.enabled = micEnabledRef.current;
          });
          stream.getVideoTracks().forEach((t) => {
            if ('contentHint' in t) t.contentHint = 'motion';
          });

          localStreamRef.current = stream;
          if (hostCamSourceVideoRef.current) {
            hostCamSourceVideoRef.current.srcObject = stream;
            hostCamSourceVideoRef.current.play().catch(() => {});
          }
          if (screenShareVideoRef.current) {
            screenShareVideoRef.current.srcObject = stream;
            screenShareVideoRef.current.play().catch(() => {});
          }
          if (videoRef.current && !screenShareEnabledRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
          const mixedAudio = updateHostAudioMix();
          if (hostBroadcasterRef.current) {
            if (!screenShareEnabledRef.current) {
              const camTrack = stream.getVideoTracks()[0];
              if (camTrack) hostBroadcasterRef.current.replaceVideoTrack(camTrack);
            }
            if (mixedAudio) {
              hostBroadcasterRef.current.replaceAudioTrack(mixedAudio);
            }
          }
          if (liveKitManagerRef.current?.isRoomConnected()) {
            liveKitManagerRef.current.publishCameraAndMic(videoRef.current, stream);
          }
          setTimeout(() => captureAndPublishHostFrame(true), 120);
          return stream;
        } catch (err) {
          console.warn('Attempting next camera constraint...', err);
        }
      }
      return null;
    };

    tryGetUserMedia().then(async (stream) => {
      if (isCancelled) return;
      if (!stream) {
        // If no physical webcam exists, still acquire Microphone audio so Host voice + Screen Share work seamlessly
        const micTrack = await acquireFallbackMicTrack();
        if (micTrack && !isCancelled) {
          micTrack.enabled = micEnabledRef.current;
          const micOnlyStream = new MediaStream([micTrack]);
          localStreamRef.current = micOnlyStream;
          setCameraEnabled(false);
          const mixed = updateHostAudioMix();
          if (hostBroadcasterRef.current && mixed) {
            hostBroadcasterRef.current.replaceAudioTrack(mixed);
          }
          if (liveKitManagerRef.current?.isRoomConnected()) {
            liveKitManagerRef.current.syncAudioTrack(mixed || micTrack, micEnabledRef.current);
          }
          showToast('🎙️ Không có webcam — đã bật Micro, bấm "Chia Sẻ Màn Hình" để phát hình!', 'info');
          return;
        }
        setCameraEnabled(false);
        showToast('⚠️ Không tìm thấy Camera/Mic — Bạn vẫn có thể dùng "Chia Sẻ Màn Hình"!', 'warning');
      }
    });

    return () => {
      isCancelled = true;
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
    };
  }, [isAdmin, isLive, isBroadcastingHost, streamSourceMode, selectedDeviceId]);

  // Keep Admin Video element, Offscreen Cam Source & PIP Video element srcObject synced whenever camera/screen state changes
  useEffect(() => {
    if (!isActiveHost) return;
    if (localStreamRef.current) {
      if (hostCamSourceVideoRef.current && hostCamSourceVideoRef.current.srcObject !== localStreamRef.current) {
        hostCamSourceVideoRef.current.srcObject = localStreamRef.current;
        hostCamSourceVideoRef.current.play().catch(() => {});
      }
      if (!screenShareEnabled && videoRef.current && videoRef.current.srcObject !== localStreamRef.current) {
        videoRef.current.srcObject = localStreamRef.current;
        if (cameraEnabled) videoRef.current.play().catch(() => {});
      }
      if (screenShareEnabled && screenShareVideoRef.current && screenShareVideoRef.current.srcObject !== localStreamRef.current) {
        screenShareVideoRef.current.srcObject = localStreamRef.current;
        screenShareVideoRef.current.play().catch(() => {});
      }
    }
    if (screenShareEnabled && screenStreamRef.current && videoRef.current && videoRef.current.srcObject !== screenStreamRef.current) {
      videoRef.current.srcObject = screenStreamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [isActiveHost, cameraEnabled, screenShareEnabled, streamSourceMode]);

  // Composite Canvas Pipeline (1280x720 @ 30fps desynchronized GPU canvas, or zero-copy native when Host PiP is hidden):
  // Combines Shared Screen + Movable/Resizable/Zoomable Host Live Frame into a single smooth WebRTC stream so Guests see BOTH!
  useEffect(() => {
    if (!isActiveHost || !isLive || !screenShareEnabled) {
      if (compositeStreamRef.current) {
        compositeStreamRef.current.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
        compositeStreamRef.current = null;
      }
      compositeCanvasRef.current = null;
      return;
    }

    // If Host hid the PiP overlay, bypass canvas compositing completely and transmit native zero-copy screen track @ 60 FPS
    if (!hostPipLayout.visible) {
      if (compositeStreamRef.current) {
        compositeStreamRef.current.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
        compositeStreamRef.current = null;
      }
      compositeCanvasRef.current = null;
      const nativeTrack = screenStreamRef.current?.getVideoTracks()[0] || null;
      if (nativeTrack) {
        if ('contentHint' in nativeTrack) {
          nativeTrack.contentHint = 'motion';
        }
        hostBroadcasterRef.current?.replaceVideoTrack(nativeTrack);
      }
      return;
    }

    const canvas = compositeCanvasRef.current || document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    compositeCanvasRef.current = canvas;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
    if (!ctx) return;

    // Helper for rounded rectangle path
    const traceRoundedRect = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.lineTo(x + w - r, y);
      c.quadraticCurveTo(x + w, y, x + w, y + r);
      c.lineTo(x + w, y + h - r);
      c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      c.lineTo(x + r, y + h);
      c.quadraticCurveTo(x, y + h, x, y + h - r);
      c.lineTo(x, y + r);
      c.quadraticCurveTo(x, y, x + r, y);
      c.closePath();
    };

    const drawCompositeFrame = () => {
      const W = canvas.width;
      const H = canvas.height;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#030508';
      ctx.fillRect(0, 0, W, H);

      // 1. Draw Shared Screen background (object-contain)
      const screenEl = videoRef.current;
      if (screenEl && screenEl.readyState >= 2 && screenEl.videoWidth > 0 && screenEl.videoHeight > 0) {
        const sRatio = screenEl.videoWidth / screenEl.videoHeight;
        const cRatio = W / H;
        let dw = W;
        let dh = H;
        let dx = 0;
        let dy = 0;
        if (sRatio > cRatio) {
          dh = W / sRatio;
          dy = (H - dh) / 2;
        } else {
          dw = H * sRatio;
          dx = (W - dw) / 2;
        }
        ctx.drawImage(screenEl, dx, dy, dw, dh);
      }

      // 2. Draw Host Live PiP Frame at exact moved/resized/zoomed coordinates (zero software shadowBlur for smooth 30 FPS)
      const pip = hostPipLayoutRef.current;
      if (pip.visible) {
        const pipW = Math.max(160, Math.round((pip.widthPct / 100) * W));
        const pipH = Math.round(pipW * (9 / 16));
        const pipX = Math.max(8, Math.min(W - pipW - 8, Math.round((pip.xPct / 100) * W)));
        const pipY = Math.max(8, Math.min(H - pipH - 8, Math.round((pip.yPct / 100) * H)));
        const radius = 14;

        ctx.save();
        traceRoundedRect(ctx, pipX, pipY, pipW, pipH, radius);
        ctx.clip();

        ctx.fillStyle = '#070d1b';
        ctx.fillRect(pipX, pipY, pipW, pipH);

        // Prefer the visible PiP <video> so Chromium hardware-decodes frames without throttling
        const camEl =
          (screenShareVideoRef.current && screenShareVideoRef.current.readyState >= 2 && screenShareVideoRef.current.videoWidth > 0)
            ? screenShareVideoRef.current
            : hostCamSourceVideoRef.current;
        const hasCam = Boolean(
          cameraEnabledRef.current &&
          camEl &&
          camEl.readyState >= 2 &&
          camEl.videoWidth > 0 &&
          camEl.videoHeight > 0
        );

        if (hasCam && camEl) {
          const zoom = Math.max(1, Math.min(2.5, pip.zoom || 1));
          const camRatio = camEl.videoWidth / camEl.videoHeight;
          const pipRatio = pipW / pipH;
          let sw = camEl.videoWidth;
          let sh = camEl.videoHeight;
          if (camRatio > pipRatio) {
            sw = camEl.videoHeight * pipRatio;
          } else {
            sh = camEl.videoWidth / pipRatio;
          }
          const zoomedSw = sw / zoom;
          const zoomedSh = sh / zoom;
          const sx = (camEl.videoWidth - zoomedSw) / 2;
          const sy = (camEl.videoHeight - zoomedSh) / 2;
          ctx.drawImage(camEl, sx, sy, zoomedSw, zoomedSh, pipX, pipY, pipW, pipH);
        } else {
          ctx.fillStyle = '#09142b';
          ctx.fillRect(pipX, pipY, pipW, pipH);

          const cx = pipX + pipW / 2;
          const cy = pipY + pipH / 2 - 8;
          const avatarR = Math.max(16, Math.min(30, Math.round(pipH * 0.2)));
          ctx.beginPath();
          ctx.arc(cx, cy, avatarR, 0, Math.PI * 2);
          ctx.fillStyle = '#00F2FE';
          ctx.fill();
          ctx.fillStyle = '#030508';
          ctx.font = `900 ${Math.round(avatarR * 0.9)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('N', cx, cy + 1);

          ctx.fillStyle = '#E0F7FA';
          ctx.font = `700 ${Math.max(11, Math.round(pipW * 0.045))}px sans-serif`;
          ctx.fillText('HOST • nptteam', cx, cy + avatarR + 14);
        }

        // Badge on Host Live Frame
        const badgeW = Math.min(pipW - 16, 134);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
        ctx.fillRect(pipX + 8, pipY + pipH - 26, badgeW, 18);
        ctx.fillStyle = '#05FFD2';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('👑 HOST LIVE', pipX + 14, pipY + pipH - 17);

        ctx.restore();

        // Crisp neon border without expensive software shadowBlur
        traceRoundedRect(ctx, pipX, pipY, pipW, pipH, radius);
        ctx.strokeStyle = 'rgba(5, 255, 210, 0.35)';
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = '#05FFD2';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    };

    // Draw initial frame & attach smooth 30 FPS composite track with 'motion' hint
    drawCompositeFrame();
    let capturedStream: MediaStream | null = null;
    try {
      capturedStream = canvas.captureStream(30);
      compositeStreamRef.current = capturedStream;
      const compositeTrack = capturedStream.getVideoTracks()[0];
      if (compositeTrack) {
        if ('contentHint' in compositeTrack) {
          compositeTrack.contentHint = 'motion';
        }
        hostBroadcasterRef.current?.replaceVideoTrack(compositeTrack);
      }
    } catch {}

    // Hybrid scheduler: vsync-locked rAF when tab is visible, 33ms (30 FPS) Web Worker ticker when presenting in another window/tab
    let isDisposed = false;
    let rafId: number | null = null;
    let worker: Worker | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    const startWorkerLoop = () => {
      if (worker || fallbackTimer) return;
      try {
        const blob = new Blob(
          ['setInterval(() => postMessage(1), 33);'],
          { type: 'application/javascript' }
        );
        const url = URL.createObjectURL(blob);
        worker = new Worker(url);
        worker.onmessage = () => {
          if (!isDisposed && document.hidden) {
            drawCompositeFrame();
          }
        };
        URL.revokeObjectURL(url);
      } catch {
        fallbackTimer = setInterval(() => {
          if (!isDisposed && document.hidden) {
            drawCompositeFrame();
          }
        }, 33);
      }
    };

    const stopWorkerLoop = () => {
      if (worker) {
        try { worker.terminate(); } catch {}
        worker = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    };

    let lastCompositeDrawAt = 0;
    const runRafLoop = (now: number) => {
      if (isDisposed || document.hidden) {
        rafId = null;
        return;
      }
      // Lock composite redraw cleanly to ~30 FPS (32ms) so 60-144Hz monitors never overload main thread
      if (now - lastCompositeDrawAt >= 32) {
        lastCompositeDrawAt = now;
        drawCompositeFrame();
      }
      rafId = requestAnimationFrame(runRafLoop);
    };

    const handleVisibility = () => {
      if (isDisposed) return;
      if (document.hidden) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        startWorkerLoop();
      } else {
        stopWorkerLoop();
        if (rafId === null) {
          rafId = requestAnimationFrame(runRafLoop);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    if (document.hidden) {
      startWorkerLoop();
    } else {
      rafId = requestAnimationFrame(runRafLoop);
    }

    return () => {
      isDisposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      stopWorkerLoop();
      if (capturedStream) {
        capturedStream.getTracks().forEach((t) => {
          try { t.stop(); } catch {}
        });
      }
      compositeStreamRef.current = null;
      compositeCanvasRef.current = null;
    };
  }, [isActiveHost, isLive, screenShareEnabled, hostPipLayout.visible]);

  // Non-blocking off-main-thread WebP/JPEG encoding via canvas.toBlob so Host scrolling NEVER freezes
  const encodeCanvasFrameAsync = (offCanvas: HTMLCanvasElement, quality: number): Promise<string | null> => {
    return new Promise((resolve) => {
      try {
        if (typeof offCanvas.toBlob === 'function') {
          offCanvas.toBlob((blob) => {
            if (!blob) {
              try {
                resolve(offCanvas.toDataURL('image/jpeg', quality));
              } catch {
                resolve(null);
              }
              return;
            }
            const reader = new FileReader();
            reader.onloadend = () => {
              resolve(typeof reader.result === 'string' ? reader.result : null);
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          }, 'image/webp', quality);
        } else {
          resolve(offCanvas.toDataURL('image/jpeg', quality));
        }
      } catch {
        resolve(null);
      }
    });
  };

  // Capture & relay crisp HD adaptive frames via WS/Supabase (~12 FPS) + throttled Cloud Firestore backup when remote viewers lack P2P/LiveKit
  const captureAndPublishHostFrame = async (forceImmediate: boolean = false) => {
    if (!isActiveHostRef.current) return;
    if (isEncodingCloudFrameRef.current && !forceImmediate) return;
    if (!forceImmediate && hasAllViewersDirectTransport()) return;
    if (!forceImmediate && supabaseRealtimeManager.hasActiveRealtimeTransport() && supabaseRealtimeManager.isWsRelayCongested()) {
      return;
    }

    const isSharing = screenShareEnabledRef.current;
    const compCanvas = compositeCanvasRef.current;
    const el = videoRef.current;

    if (!relayOffscreenCanvasRef.current) {
      relayOffscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = relayOffscreenCanvasRef.current;

    if (isSharing && compCanvas && compCanvas.width > 0 && compCanvas.height > 0) {
      isEncodingCloudFrameRef.current = true;
      try {
        const targetW = 1024;
        const targetH = 576;
        if (offCanvas.width !== targetW || offCanvas.height !== targetH) {
          offCanvas.width = targetW;
          offCanvas.height = targetH;
        }
        const ctx = offCanvas.getContext('2d', { alpha: false }) || offCanvas.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(compCanvas, 0, 0, targetW, targetH);
        const frameData = await encodeCanvasFrameAsync(offCanvas, 0.72);
        if (!frameData) return;
        publishLiveVideoFrameToCloud(frameData, liveSessionIdRef.current, true, forceImmediate);
      } catch {} finally {
        isEncodingCloudFrameRef.current = false;
      }
      return;
    }

    if (!el || el.readyState < 2 || el.videoWidth === 0 || el.videoHeight === 0) return;
    if (!cameraEnabledRef.current && !isSharing) return;

    isEncodingCloudFrameRef.current = true;
    try {
      const targetWidth = isSharing ? 1024 : 720;
      const targetHeight = Math.max(360, Math.round((targetWidth * el.videoHeight) / el.videoWidth));
      if (offCanvas.width !== targetWidth || offCanvas.height !== targetHeight) {
        offCanvas.width = targetWidth;
        offCanvas.height = targetHeight;
      }
      const ctx = offCanvas.getContext('2d', { alpha: false }) || offCanvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(el, 0, 0, targetWidth, targetHeight);

      const frameData = await encodeCanvasFrameAsync(offCanvas, isSharing ? 0.72 : 0.68);
      if (!frameData) return;
      publishLiveVideoFrameToCloud(frameData, liveSessionIdRef.current, isSharing, forceImmediate);
    } catch {} finally {
      isEncodingCloudFrameRef.current = false;
    }
  };

  // --- ADMIN CLOUD/WS RELAY SNAPSHOT LOOP (Smooth ~11-12 FPS HD over WS/Supabase; throttled backup over Firestore when WS inactive) ---
  useEffect(() => {
    if (!isActiveHost || !isLive || (!cameraEnabled && !screenShareEnabled)) return;

    const initialTimer = setTimeout(() => captureAndPublishHostFrame(true), 150);
    const captureInterval = setInterval(() => {
      if (!hasAllViewersDirectTransport()) {
        if (supabaseRealtimeManager.hasActiveRealtimeTransport() || Date.now() - lastFrameTimeRef.current >= 450) {
          lastFrameTimeRef.current = Date.now();
          captureAndPublishHostFrame(false);
        }
      }
    }, screenShareEnabled ? 90 : 85);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(captureInterval);
    };
  }, [isActiveHost, isLive, cameraEnabled, screenShareEnabled, liveSessionId]);

  // Host Toggle Camera - Clean track toggle with zero black-screen lag
  const handleToggleCamera = async () => {
    if (!isAdmin || !isBroadcastingHostRef.current) return;
    getAudioMixer();
    const nextState = !cameraEnabled;
    setCameraEnabled(nextState);

    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      if (videoTracks.length > 0) {
        videoTracks.forEach(t => {
          t.enabled = nextState;
        });
      }
      if (hostCamSourceVideoRef.current) {
        if (hostCamSourceVideoRef.current.srcObject !== localStreamRef.current) {
          hostCamSourceVideoRef.current.srcObject = localStreamRef.current;
        }
        if (nextState) hostCamSourceVideoRef.current.play().catch(() => {});
      }
      if (screenShareVideoRef.current) {
        if (screenShareVideoRef.current.srcObject !== localStreamRef.current) {
          screenShareVideoRef.current.srcObject = localStreamRef.current;
        }
        if (nextState) screenShareVideoRef.current.play().catch(() => {});
      }
      if (videoRef.current && !screenShareEnabled) {
        if (videoRef.current.srcObject !== localStreamRef.current) {
          videoRef.current.srcObject = localStreamRef.current;
        }
        if (nextState) {
          videoRef.current.play().catch(() => {});
        }
      }
    } else if (nextState) {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: AUDIO_VOICE_CONSTRAINTS
        });
        if (newStream.getAudioTracks().length === 0) {
          const micTrack = await acquireFallbackMicTrack();
          if (micTrack) newStream.addTrack(micTrack);
        }
        newStream.getAudioTracks().forEach((t) => {
          t.enabled = micEnabledRef.current;
        });
        newStream.getVideoTracks().forEach((t) => {
          if ('contentHint' in t) t.contentHint = 'motion';
        });
        localStreamRef.current = newStream;
        if (hostCamSourceVideoRef.current) {
          hostCamSourceVideoRef.current.srcObject = newStream;
          hostCamSourceVideoRef.current.play().catch(() => {});
        }
        if (screenShareVideoRef.current) {
          screenShareVideoRef.current.srcObject = newStream;
          screenShareVideoRef.current.play().catch(() => {});
        }
        if (videoRef.current && !screenShareEnabled) {
          videoRef.current.srcObject = newStream;
          videoRef.current.play().catch(() => {});
        }
        if (hostBroadcasterRef.current && !screenShareEnabled) {
          const camTrack = newStream.getVideoTracks()[0];
          if (camTrack) hostBroadcasterRef.current.replaceVideoTrack(camTrack);
        }
        updateHostAudioMix();
      } catch (err) {
        console.warn('Acquire camera error:', err);
      }
    }
    
    liveKitManagerRef.current?.sendDataMessage({ type: 'CAM_STATE', enabled: nextState });
    await liveKitManagerRef.current?.toggleCamera(nextState);
    showToast(nextState ? '🎥 Đã bật Camera phát sóng' : '🚫 Đã tắt Camera phát sóng', nextState ? 'success' : 'info');
  };

  // Interactive Drag, Resize & Zoom Helpers for Host Frame
  const startPipDrag = (e: React.PointerEvent) => {
    if (!isActiveHost || !stageContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = stageContainerRef.current.getBoundingClientRect();
    const init = hostPipLayoutRef.current;
    const pipHeightPct = (init.widthPct * 9) / 16 * (rect.width / Math.max(1, rect.height));

    const onMove = (ev: PointerEvent) => {
      const dxPct = ((ev.clientX - startX) / Math.max(1, rect.width)) * 100;
      const dyPct = ((ev.clientY - startY) / Math.max(1, rect.height)) * 100;
      const nextX = Math.max(1, Math.min(99 - init.widthPct, init.xPct + dxPct));
      const nextY = Math.max(1, Math.min(99 - Math.min(85, pipHeightPct), init.yPct + dyPct));
      setHostPipLayout(prev => ({ ...prev, xPct: Math.round(nextX * 10) / 10, yPct: Math.round(nextY * 10) / 10 }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startPipResize = (e: React.PointerEvent) => {
    if (!isActiveHost || !stageContainerRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const rect = stageContainerRef.current.getBoundingClientRect();
    const init = hostPipLayoutRef.current;

    const onMove = (ev: PointerEvent) => {
      const dwPct = ((ev.clientX - startX) / Math.max(1, rect.width)) * 100;
      const maxWidthPct = Math.min(55, 99 - init.xPct);
      const nextW = Math.max(14, Math.min(maxWidthPct, init.widthPct + dwPct));
      setHostPipLayout(prev => ({ ...prev, widthPct: Math.round(nextW * 10) / 10 }));
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Host Toggle Microphone
  const handleToggleMic = async () => {
    if (!isAdmin || !isBroadcastingHostRef.current) return;
    getAudioMixer();
    const nextState = !micEnabledRef.current;
    micEnabledRef.current = nextState;
    setMicEnabled(nextState);

    if (nextState) {
      const existingAudio = localStreamRef.current?.getAudioTracks().filter((t) => t.readyState === 'live') || [];
      if (existingAudio.length === 0) {
        const micTrack = await acquireFallbackMicTrack();
        if (micTrack) {
          if (!localStreamRef.current) {
            localStreamRef.current = new MediaStream([micTrack]);
          } else {
            localStreamRef.current.addTrack(micTrack);
          }
        }
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = nextState));
    }
    updateHostAudioMix({ micEnabled: nextState, forceSync: true });
    await liveKitManagerRef.current?.toggleMicrophone(nextState);
    showToast(nextState ? '🎙️ Đã bật Microphone' : '🔇 Đã tắt Microphone', nextState ? 'success' : 'info');
  };

  // Host Toggle AI Neural DSP Noise Cancellation & Acoustic Dereverberation
  const handleToggleNoiseFilter = () => {
    if (!isAdmin || !isBroadcastingHostRef.current) return;
    getAudioMixer();
    const nextState = !noiseFilterActiveRef.current;
    noiseFilterActiveRef.current = nextState;
    setNoiseFilterActive(nextState);
    updateHostAudioMix({ noiseFilterActive: nextState, forceSync: true });
    showToast(
      nextState
        ? '🤖 Đã KÍCH HOẠT AI DEREVERB & AEC: Khử Tiếng Vọng Phòng + Lọc Tạp Âm Cực Đại!'
        : '🔉 Đã TẮT Khử Vang & Lọc Tạp Âm AI',
      'info'
    );
  };

  // Host Toggle Screen Share with Smooth 30 FPS HD Video & High Fidelity System Audio
  const handleToggleScreenShare = async () => {
    if (!isAdmin || !isBroadcastingHostRef.current) {
      showToast('⛔ Chỉ người đang phát Live (Host) mới có quyền bật hoặc dừng chia sẻ màn hình!', 'error');
      return;
    }
    getAudioMixer();
    try {
      if (!screenShareEnabledRef.current) {
        let screenStream: MediaStream | null = null;
        try {
          // Native 30 FPS 1080p screen capture synced cleanly with composite canvas & WebRTC encoder
          screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: 1920, max: 1920 },
              height: { ideal: 1080, max: 1080 },
              frameRate: { ideal: 30, max: 30 }
            },
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false
            }
          });
        } catch (e1: any) {
          try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 30 } },
              audio: true
            });
          } catch (e2: any) {
            try {
              screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            } catch (e3: any) {
              if (e3?.name !== 'NotAllowedError' && e3?.message !== 'Permission denied') {
                showToast('⚠️ Vui lòng cấp quyền chia sẻ màn hình để bắt đầu phát sóng!', 'warning');
              }
              return;
            }
          }
        }

        if (!screenStream) return;
        screenStreamRef.current = screenStream;
        screenShareEnabledRef.current = true;
        setScreenShareEnabled(true);

        const screenVideoTrack = screenStream.getVideoTracks()[0];
        if (screenVideoTrack && 'contentHint' in screenVideoTrack) {
          // 'motion' keeps WebRTC encoding at smooth 60 FPS during fast scrolling instead of throttling to low-FPS 'detail' mode
          screenVideoTrack.contentHint = 'motion';
        }

        // 1. Instant 60 FPS zero-latency track replacement for all WebRTC viewers
        if (hostBroadcasterRef.current && screenVideoTrack) {
          await hostBroadcasterRef.current.replaceVideoTrack(screenVideoTrack);
        }

        // 2. Mix in system audio from screen presentation + host mic (await AudioContext resume so mixer runs immediately)
        if (audioMixerContextRef.current?.state === 'suspended') {
          await audioMixerContextRef.current.resume().catch(() => {});
        }
        updateHostAudioMix({ screenShareEnabled: true, forceSync: true });

        // 3. Update host local preview video
        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.play().catch(() => {});
        }

        // 4. In PiP window, show the host camera
        if (screenShareVideoRef.current && localStreamRef.current) {
          screenShareVideoRef.current.srcObject = localStreamRef.current;
          screenShareVideoRef.current.play().catch(() => {});
        }

        await liveKitManagerRef.current?.toggleScreenShare(true, screenVideoTrack);

        const stopHandler = async () => {
          if (!isAdmin || !isBroadcastingHostRef.current) return;
          if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;
          }
          screenShareEnabledRef.current = false;
          setScreenShareEnabled(false);

          // Revert video track back to camera with 'motion' content hint
          const camTrack = localStreamRef.current?.getVideoTracks()[0] || null;
          if (camTrack && 'contentHint' in camTrack) {
            camTrack.contentHint = 'motion';
          }
          if (hostBroadcasterRef.current && camTrack) {
            await hostBroadcasterRef.current.replaceVideoTrack(camTrack);
          }

          // Revert audio back to mic-only
          updateHostAudioMix({ screenShareEnabled: false, forceSync: true });

          if (localStreamRef.current && videoRef.current) {
            videoRef.current.srcObject = localStreamRef.current;
            videoRef.current.play().catch(() => {});
          }
          liveKitManagerRef.current?.toggleScreenShare(false);
          showToast('💻 Đã dừng chia sẻ màn hình', 'info');
        };

        if (screenVideoTrack) {
          screenVideoTrack.onended = stopHandler;
        }

        const hasAudio = screenStream.getAudioTracks().length > 0;
        showToast(
          hasAudio
            ? '💻 Đã chia sẻ màn hình HD 30 FPS CÓ ÂM THANH hệ thống sắc nét, mượt mà!'
            : '💻 Đã chia sẻ màn hình HD 30 FPS sắc nét, mượt mà!',
          'success'
        );
      } else {
        if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(t => t.stop());
          screenStreamRef.current = null;
        }
        screenShareEnabledRef.current = false;
        setScreenShareEnabled(false);

        const camTrack = localStreamRef.current?.getVideoTracks()[0] || null;
        if (hostBroadcasterRef.current && camTrack) {
          await hostBroadcasterRef.current.replaceVideoTrack(camTrack);
        }
        updateHostAudioMix({ screenShareEnabled: false, forceSync: true });

        if (localStreamRef.current && videoRef.current) {
          videoRef.current.srcObject = localStreamRef.current;
          videoRef.current.play().catch(() => {});
        }
        await liveKitManagerRef.current?.toggleScreenShare(false);
        showToast('💻 Đã dừng chia sẻ màn hình', 'info');
      }
    } catch (err) {
      console.warn('Screen share error or cancelled:', err);
    }
  };

  // Admin Start Live Stream (Publishes new live room immediately to Cloud Firestore while cleaning stale session data)
  const handleStartLive = async () => {
    // Synchronously unlock WebAudio inside user click gesture so Host Mic AudioContext starts in 'running' state
    getAudioMixer();
    const newSessionId = `live_${Date.now()}`;
    resetLocalLiveSessionState(newSessionId);
    try { sessionStorage.setItem('npt_host_broadcasting_session', newSessionId); } catch {}
    prevIsLiveRef.current = true;
    setIsBroadcastingHost(true);
    setIsLive(true);

    const [publishResult] = await Promise.all([
      publishLiveStateToCloud(true, streamTitle, null, newSessionId),
      Promise.race([
        clearPreviousLiveSessionData(newSessionId),
        new Promise<void>((resolve) => setTimeout(resolve, 700))
      ]),
    ]);

    liveKitManagerRef.current?.sendDataMessage({ type: 'SESSION_RESET', sessionId: newSessionId });
    liveKitManagerRef.current?.sendDataMessage({ type: 'LIVE_STATE', isLive: true, sessionId: newSessionId, title: streamTitle });

    if (!publishResult?.cloudSynced) {
      showToast(
        `⚠️ Phòng Live đã mở trên máy Host nhưng chưa đồng bộ được lên Cloud (${publishResult?.error || 'Lỗi quyền Firestore'}). Thiết bị khác có thể chưa thấy phòng Live!`,
        'error'
      );
      return;
    }

    showToast('🔴 ĐÃ XÓA DỮ LIỆU PHIÊN CŨ & PHÁT SÓNG PHIÊN LIVE MỚI THÀNH CÔNG!', 'success');
  };

  // Auto-close live ONLY when the actual broadcasting Host tab closes (prevents secondary Admin tabs from killing live)
  useEffect(() => {
    if (!isAdmin || !isLive || !isBroadcastingHost) return;

    // Send heartbeat to cloud every 3 seconds to guarantee live is kept active
    const heartbeatInterval = setInterval(() => {
      sendHostHeartbeat(streamTitle, liveSessionIdRef.current);
    }, 3000);

    const handleWebClose = () => {
      try { sessionStorage.removeItem('npt_host_broadcasting_session'); } catch {}
      sendEndLiveBeacon(streamTitle, liveSessionIdRef.current);
    };

    window.addEventListener('beforeunload', handleWebClose);
    window.addEventListener('unload', handleWebClose);

    return () => {
      clearInterval(heartbeatInterval);
      window.removeEventListener('beforeunload', handleWebClose);
      window.removeEventListener('unload', handleWebClose);
    };
  }, [isAdmin, isLive, isBroadcastingHost, streamTitle]);

  // Admin End Live Stream (Stops media & wipes all current session data cleanly)
  const handleEndLive = async () => {
    try { sessionStorage.removeItem('npt_host_broadcasting_session'); } catch {}
    setIsBroadcastingHost(false);
    prevIsLiveRef.current = false;
    setIsLive(false);

    if (hostBroadcasterRef.current) {
      hostBroadcasterRef.current.stop();
      hostBroadcasterRef.current = null;
    }

    if (micAudioSourceRef.current) {
      try { micAudioSourceRef.current.disconnect(); } catch {}
      micAudioSourceRef.current = null;
    }
    if (screenAudioSourceRef.current) {
      try { screenAudioSourceRef.current.disconnect(); } catch {}
      screenAudioSourceRef.current = null;
    }

    // Stop local media tracks immediately so camera and mic hardware turn off
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    resetLocalLiveSessionState('');

    // Wipe previous session chats, viewers, kicks, WebRTC peers, feed & publish offline state
    await clearPreviousLiveSessionData('');
    await publishLiveStateToCloud(false, streamTitle, null, '');
    liveKitManagerRef.current?.sendDataMessage({ type: 'SESSION_RESET', sessionId: '' });
    liveKitManagerRef.current?.sendDataMessage({ type: 'LIVE_STATE', isLive: false, sessionId: '' });
    showToast('⏹️ Đã kết thúc Live Stream và xóa toàn bộ dữ liệu phiên trước.', 'info');
    if (onCloseLive) onCloseLive();
  };

  // Admin Kick Viewer
  const handleKickViewer = async (viewerId: string, viewerName: string) => {
    if (!isAdmin) return;
    try {
      await kickLiveViewer(viewerId);
    } catch {}
    fetch('/api/live/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: viewerId }),
    }).catch(() => {});

    liveKitManagerRef.current?.sendDataMessage({
      type: 'KICK_VIEWER',
      targetUserId: viewerId,
    });
    setParticipants(prev => prev.filter(p => p.id !== viewerId));
    showToast(`🚫 Đã mời người xem ${viewerName} khỏi phòng Live!`, 'warning');
  };

  // Admin Pin Product
  const handlePinProduct = (product: Product) => {
    if (!isAdmin) return;
    setPinnedProduct(product);
    setIsPinnedProductCollapsed(false);
    setIsPinModalOpen(false);
    publishLiveStateToCloud(isLive, streamTitle, product.id, liveSessionIdRef.current);
    liveKitManagerRef.current?.sendDataMessage({
      type: 'PIN_PRODUCT',
      product,
      sessionId: liveSessionIdRef.current,
    });
    showToast(`📌 Đã ghim sản phẩm: ${product.name}`, 'success');
  };

  // Admin Unpin Product
  const handleUnpinProduct = () => {
    if (!isAdmin) return;
    setPinnedProduct(null);
    setIsPinnedProductCollapsed(false);
    publishLiveStateToCloud(isLive, streamTitle, null, liveSessionIdRef.current);
    liveKitManagerRef.current?.sendDataMessage({
      type: 'PIN_PRODUCT',
      product: null,
      sessionId: liveSessionIdRef.current,
    });
    showToast('📌 Đã bỏ ghim sản phẩm trên màn hình Live', 'info');
  };

  // Send Chat Message with support for Link, Image, File (STRICTLY prevents window scrolling to footer)
  const handleSendMessage = async (e?: React.SyntheticEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!inputMessage.trim() && !attachedImage && !attachedFile) return;

    // 1. Lock exact window scroll position to prevent any jump to footer
    const savedWindowScrollY = window.scrollY;

    const newMsg: LiveChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      senderId: currentUserId,
      senderName: currentUserName,
      senderBadge: isAdmin ? '👑 HOST / QUẢN LÝ' : '⭐ THÀNH VIÊN',
      isAdmin,
      text: inputMessage.trim(),
      image: attachedImage || undefined,
      file: attachedFile || undefined,
      timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => {
      if (prev.some(m => m.id === newMsg.id)) return prev;
      return [...prev, newMsg];
    });

    // Broadcast across Vercel via Firestore + local channel scoped to current session
    await sendLiveChatMessage(newMsg, liveSessionIdRef.current);

    liveKitManagerRef.current?.sendDataMessage({
      type: 'CHAT',
      message: newMsg,
      sessionId: liveSessionIdRef.current,
    });

    setInputMessage('');
    setAttachedImage(null);
    setAttachedFile(null);

    // 2. Scroll internal chat container ONLY
    const el = chatContainerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }

    // 3. Keep focus on input without scrolling the window
    if (chatInputRef.current) {
      chatInputRef.current.focus({ preventScroll: true });
    }

    // 4. Enforce window scroll position remains identical (never scroll to footer)
    requestAnimationFrame(() => {
      if (window.scrollY !== savedWindowScrollY) {
        window.scrollTo({ top: savedWindowScrollY, behavior: 'instant' as ScrollBehavior });
      }
    });
  };

  // Image Upload Handler
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      showToast('Kích thước ảnh không được vượt quá 8MB', 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setAttachedImage(event.target?.result as string);
      showToast('📸 Đã đính kèm hình ảnh!', 'success');
    };
    reader.readAsDataURL(file);
  };

  // File Upload Handler
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      showToast('Kích thước file không được vượt quá 15MB', 'warning');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      setAttachedFile({
        name: file.name,
        size: file.size,
        url: event.target?.result as string,
        type: file.type || 'application/octet-stream',
      });
      showToast(`📄 Đã đính kèm file: ${file.name}`, 'success');
    };
    reader.readAsDataURL(file);
  };

  // Reaction Hearts Floating Effect (Single Red Heart per click, floating straight up and fading away)
  const triggerHeartAnimation = (xPercent?: number) => {
    const heartId = `heart-${Date.now()}-${Math.random()}`;
    const redColor = '#EF4444';
    const randomX = xPercent !== undefined ? xPercent : Math.random() * 60 + 20;

    setFloatingHearts(prev => [...prev, { id: heartId, x: randomX, color: redColor }]);

    setTimeout(() => {
      setFloatingHearts(prev => prev.filter(h => h.id !== heartId));
    }, 2400);
  };

  const handleSendHeart = () => {
    triggerHeartAnimation();
    liveKitManagerRef.current?.sendDataMessage({
      type: 'HEART',
      x: Math.random() * 75 + 10,
    });
  };

  // Helper function to convert links in text into clickable <a> tags
  const renderMessageTextWithLinks = (text?: string) => {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
    const parts = text.split(urlRegex);

    return parts.map((part, index) => {
      if (part.match(urlRegex)) {
        const href = part.startsWith('http') ? part : `https://${part}`;
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#00F2FE] hover:text-[#05FFD2] underline underline-offset-2 font-bold inline-flex items-center gap-1 hover:brightness-125 break-all"
            onClick={(e) => e.stopPropagation()}
          >
            <span>{part}</span>
            <i className="fa-solid fa-arrow-up-right-from-square text-[#00F2FE] text-[10px]"></i>
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  // Copy to clipboard helper
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    showToast(`📋 Đã sao chép ${label} vào bộ nhớ tạm!`, 'success');
  };

  // CASE 1: IF VIEWER IS KICKED
  if (isKicked) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-6 text-center">
        <div className="max-w-md bg-[#0A0F1D]/95 border-2 border-rose-500/80 p-8 rounded-2xl shadow-[0_0_50px_rgba(244,63,94,0.4)] backdrop-blur-xl">
          <div className="w-16 h-16 bg-rose-500/20 text-rose-500 border border-rose-500/50 rounded-full flex items-center justify-center text-3xl mx-auto mb-4 animate-bounce">
            <i className="fa-solid fa-ban"></i>
          </div>
          <h2 className="text-xl font-black text-rose-400 uppercase tracking-wider mb-2">
            BẠN ĐÃ BỊ MỜI RA KHỎI PHIÊN LIVE STREAM!
          </h2>
          <p className="text-sm font-bold text-slate-200 uppercase tracking-wide mb-6">
            BẠN ĐÃ BỊ QUẢN LÝ (ADMIN DANH NGUYỄN) MỜI RA KHỎI PHIÊN LIVE STREAM! VUI LÒNG QUAY VỀ TRANG CHỦ MUA SẮM HOẶC LIÊN HỆ STORE ĐỂ ĐƯỢC HỖ TRỢ.
          </p>
          <button
            onClick={() => {
              if (onCloseLive) onCloseLive();
              else window.location.href = '/';
            }}
            className="w-full bg-gradient-to-r from-rose-600 to-red-600 hover:brightness-110 text-white font-black py-3.5 rounded-full text-xs uppercase tracking-wider shadow-lg transition cursor-pointer"
          >
            QUAY VỀ TRANG CHỦ MUA SẮM
          </button>
        </div>
      </div>
    );
  }

  // CASE 2: IF ADMIN HAS NOT STARTED LIVE YET (WEB KHÁCH / GUEST SIDE)
  if (!isLive && !isAdmin) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-6">
        <div className="max-w-xl w-full bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/60 p-8 sm:p-12 rounded-3xl shadow-[0_0_60px_rgba(0,242,254,0.35)] backdrop-blur-2xl relative overflow-hidden">
          {/* Decorative Background Pulse */}
          <div className="absolute top-0 right-0 -mr-10 -mt-10 w-40 h-40 bg-[#00F2FE]/20 rounded-full blur-3xl pointer-events-none" />

          <div className="w-24 h-24 rounded-3xl border-2 border-[#00F2FE] bg-[#050914] flex items-center justify-center text-4xl text-[#00F2FE] shadow-[0_0_35px_rgba(0,242,254,0.6)] mx-auto mb-6 relative">
            <i className="fa-solid fa-tower-cell animate-pulse"></i>
            <span className="absolute -top-1 -right-1 flex h-4 w-4">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-500 border border-black"></span>
            </span>
          </div>

          <span className="inline-block px-4 py-1.5 bg-rose-500/20 text-rose-400 border border-rose-500/50 rounded-full text-xs font-black uppercase tracking-widest mb-4 shadow-[0_0_15px_rgba(244,63,94,0.3)]">
            🔴 TRẠNG THÁI PHÒNG LIVE
          </span>

          <h1 className="text-2xl sm:text-4xl font-black text-white uppercase tracking-wider mb-4 drop-shadow-[0_0_20px_rgba(0,242,254,0.8)] font-serif-title">
            HIỆN KHÔNG CÓ PHÒNG LIVE
          </h1>

          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed mb-8 max-w-md mx-auto">
            Quản lý Showroom NPTTEAMSTORE hiện chưa mở phiên phát sóng trực tiếp. Bạn vui lòng quay lại sau hoặc tham quan kho sản phẩm DX & CSM chính hãng bên dưới!
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => {
                if (onCloseLive) onCloseLive();
                else window.location.href = '/';
              }}
              className="w-full sm:w-auto bg-gradient-to-r from-[#00F2FE] to-[#05FFD2] hover:brightness-110 text-slate-950 font-black px-8 py-3.5 rounded-2xl text-xs uppercase tracking-wider shadow-[0_0_25px_rgba(0,242,254,0.6)] transition duration-200 cursor-pointer flex items-center justify-center gap-2"
            >
              <i className="fa-solid fa-store"></i>
              <span>XEM KHO SẢN PHẨM KHUYẾN MÃI</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // CASE 3: IF ADMIN HAS NOT STARTED LIVE YET (ADMIN SIDE CONTROL PANEL TO START)
  if (!isLive && isAdmin) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 text-center space-y-6">
        <div className="max-w-xl w-full bg-[#0A0F1D]/95 border-2 border-amber-400/80 p-8 sm:p-12 rounded-3xl shadow-[0_0_60px_rgba(255,215,0,0.35)] backdrop-blur-2xl relative overflow-hidden">
          <div className="w-20 h-20 rounded-2xl border-2 border-[#FFD700] bg-[#050914] flex items-center justify-center text-3xl text-[#FFD700] shadow-[0_0_35px_rgba(255,215,0,0.6)] mx-auto mb-4">
            <i className="fa-solid fa-crown"></i>
          </div>

          <span className="inline-block px-4 py-1.5 bg-amber-400/20 text-[#FFD700] border border-amber-400/50 rounded-full text-xs font-black uppercase tracking-widest mb-4">
            👑 CỔNG ĐIỀU HÀNH PHÁT SÓNG QUẢN LÝ
          </span>

          <h2 className="text-xl sm:text-3xl font-black text-white uppercase tracking-wider mb-2 font-serif-title">
            PHÒNG LIVE ĐANG TẮT
          </h2>

          <p className="text-xs sm:text-sm text-slate-300 mb-6 max-w-md mx-auto">
            Hỗ trợ phát sóng trực tiếp qua <strong>Camera Trực Tiếp</strong> hoặc kết nối phần mềm <strong>OBS Studio</strong>.
          </p>

          {/* Mode Switcher: Camera vs OBS Studio */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <button
              onClick={() => setStreamSourceMode('camera')}
              className={`p-3 rounded-xl border-2 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer ${
                streamSourceMode === 'camera'
                  ? 'border-[#00F2FE] bg-[#00F2FE]/20 text-[#00F2FE] shadow-[0_0_15px_rgba(0,242,254,0.3)]'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
              }`}
            >
              <i className="fa-solid fa-camera"></i>
              <span>Camera Trực Tiếp</span>
            </button>
            <button
              onClick={() => {
                setStreamSourceMode('obs');
                setIsOBSModalOpen(true);
              }}
              className={`p-3 rounded-xl border-2 text-xs font-bold transition flex items-center justify-center gap-2 cursor-pointer ${
                streamSourceMode === 'obs'
                  ? 'border-[#FFD700] bg-[#FFD700]/20 text-[#FFD700] shadow-[0_0_15px_rgba(255,215,0,0.3)]'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-white'
              }`}
            >
              <i className="fa-solid fa-tower-broadcast"></i>
              <span>OBS Studio</span>
            </button>
          </div>

          <div className="space-y-4 text-left mb-8">
            <label className="block text-xs font-bold text-slate-300 uppercase">Tiêu đề buổi Live Stream:</label>
            <input
              type="text"
              value={streamTitle}
              onChange={(e) => setStreamTitle(e.target.value)}
              className="w-full bg-[#030508] border-2 border-slate-700 focus:border-[#FFD700] text-white px-4 py-3 rounded-xl text-xs font-bold outline-none transition shadow-inner"
            />
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={handleStartLive}
              className="w-full bg-gradient-to-r from-amber-400 via-yellow-400 to-[#FFD700] hover:brightness-110 text-slate-950 font-black py-4 rounded-2xl text-sm uppercase tracking-wider shadow-[0_0_30px_rgba(255,215,0,0.5)] transition duration-200 cursor-pointer flex items-center justify-center gap-2"
            >
              <i className="fa-solid fa-tower-broadcast animate-pulse"></i>
              <span>BẮT ĐẦU PHÁT SÓNG TRỰC TIẾP (GO LIVE)</span>
            </button>

            <button
              onClick={() => setIsOBSModalOpen(true)}
              className="w-full bg-slate-900 hover:bg-slate-800 text-[#FFD700] border border-[#FFD700]/60 font-bold py-2.5 rounded-xl text-xs uppercase tracking-wider transition cursor-pointer flex items-center justify-center gap-2"
            >
              <i className="fa-solid fa-sliders"></i>
              <span>Thông số kết nối OBS Studio</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
      {/* Live Header Banner */}
      <div className="bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/60 px-5 py-3.5 rounded-2xl shadow-[0_0_30px_rgba(0,242,254,0.25)] flex flex-wrap items-center justify-between gap-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-500/20 border border-rose-500/50 flex items-center justify-center text-rose-500 text-lg shadow-[0_0_15px_rgba(244,63,94,0.4)] animate-pulse">
            <i className="fa-solid fa-tower-broadcast"></i>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="bg-rose-500 text-white text-[9px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider shadow">
                ĐANG PHÁT LIVE
              </span>
              <span className="text-xs text-cyan-300 font-bold flex items-center gap-1">
                <i className="fa-solid fa-eye"></i> {viewersCount} người xem trực tuyến
              </span>
              <span className="text-xs text-emerald-400 font-bold flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                {connectionState === 'connected' ? 'Đã kết nối' : 'Đang kết nối...'}
              </span>
            </div>
            <h1 className="text-sm sm:text-base font-black text-white tracking-wide truncate max-w-xl">
              {streamTitle}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {isAdmin && (
            <>
              <button
                onClick={() => setIsOBSModalOpen(true)}
                className="bg-amber-400/20 hover:bg-amber-400/30 text-[#FFD700] border border-amber-400/60 font-black px-3.5 py-2 rounded-xl text-xs uppercase tracking-wider transition flex items-center gap-1.5 cursor-pointer shadow"
              >
                <i className="fa-solid fa-sliders"></i> Cấu hình OBS
              </button>
              <button
                onClick={handleEndLive}
                className="bg-rose-600 hover:bg-rose-500 text-white font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider shadow-[0_0_15px_rgba(244,63,94,0.5)] transition flex items-center gap-1.5 cursor-pointer"
              >
                <i className="fa-solid fa-stop"></i> Kết thúc Live
              </button>
            </>
          )}
          {onCloseLive && (
            <button
              onClick={onCloseLive}
              className="bg-[#121214] hover:bg-slate-800 text-slate-300 border border-slate-700 px-3 py-1.5 rounded-full text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
            >
              <i className="fa-solid fa-xmark"></i> Đóng Live
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Video Player (70%) + Chat & Viewer Sidebar (30%) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* Left Column: Video Screen + Host Control Panel (8 Cols desktop) */}
        <div className="lg:col-span-8 space-y-3">
          {/* Main Sci-Fi Video & Canvas Container */}
          <div
            ref={stageContainerRef}
            className="relative aspect-video bg-[#030508] rounded-2xl overflow-hidden border-2 border-[#00F2FE]/50 shadow-[0_0_35px_rgba(0,242,254,0.25)] group"
          >
            <div className="relative w-full h-full">
            {/* Quality Layer Indicator Badge (Top Left) */}
            <div className="absolute top-3 left-3 z-30 flex items-center gap-2">
              <span className="bg-black/80 backdrop-blur-md border border-[#00F2FE]/60 text-[#00F2FE] text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1.5 shadow">
                <i className="fa-solid fa-circle text-rose-500 animate-pulse text-[8px]"></i>
                <span>Trực Tiếp HD</span>
              </span>
            </div>

            {/* HOST BROADCASTER VIEW ONLY: Local Camera / Screen Share Preview + GPU-Decoded Offscreen Cam Source */}
            {isActiveHost ? (
              <div className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden">
                {/* Off-screen GPU-decoded webcam source (never display:none so Chromium never throttles/freezes cam frames) */}
                <video
                  ref={hostCamSourceVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="fixed -left-[9999px] top-0 w-16 h-9 opacity-0 pointer-events-none"
                />

                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full ${screenShareEnabled ? 'object-contain' : 'object-cover'} relative z-10 bg-black ${
                    (cameraEnabled || screenShareEnabled) ? 'block' : 'hidden'
                  }`}
                  onLoadedMetadata={(e) => {
                    const el = e.currentTarget;
                    el.play().catch(() => {});
                    setTimeout(() => captureAndPublishHostFrame(true), 120);
                  }}
                />
                {!cameraEnabled && !screenShareEnabled && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#030508] p-6 text-center z-20">
                    <div className="w-20 h-20 rounded-full border-2 border-[#00F2FE] bg-[#0A0F1D] flex items-center justify-center text-3xl text-[#00F2FE] shadow-[0_0_25px_rgba(0,242,254,0.5)] mb-3 animate-pulse">
                      <i className="fa-solid fa-video-slash"></i>
                    </div>
                    <h3 className="text-lg font-black text-[#E0F7FA] uppercase tracking-wider mb-1">
                      CAMERA ĐANG TẮT TẠM THỜI
                    </h3>
                    <p className="text-xs text-slate-400 max-w-sm">
                      Bấm nút "Bật Cam" hoặc "Chia Sẻ Màn Hình" bên dưới để phát hình trực tiếp.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              /* GUEST VIEW: 60 FPS Hardware-Accelerated WebRTC Video Player + Instant Cloud Canvas Fallback Layer */
              <div 
                className="relative w-full h-full bg-black flex items-center justify-center cursor-pointer select-none overflow-hidden"
                onClick={isGuestAudioMuted ? handleUnmuteGuest : undefined}
              >
                {/* Fallback Canvas Layer (z-10): Renders HD Cloud Firestore & WebSocket video frames smoothly even behind strict NAT */}
                <canvas
                  ref={guestCanvasRef}
                  width={1280}
                  height={720}
                  className={`absolute inset-0 w-full h-full object-contain z-10 block bg-black transition-opacity duration-200 ${
                    hasWebRTCVideoPixels ? 'opacity-0 pointer-events-none' : 'opacity-100'
                  }`}
                />

                {/* Primary WebRTC 60 FPS Video Player (muted so video autoplay never stalls; audio plays via dedicated <audio>) */}
                <video
                  ref={guestVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`relative w-full h-full object-contain z-20 transition-opacity duration-200 ${
                    hasWebRTCVideoPixels ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}
                  onLoadedData={(e) => {
                    const el = e.currentTarget;
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      hasWebRTCVideoPixelsRef.current = true;
                      setHasWebRTCVideoPixels(true);
                      setHasReceivedLiveVideo(true);
                    }
                    setHostCamEnabled(true);
                  }}
                  onCanPlay={(e) => {
                    const el = e.currentTarget;
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      hasWebRTCVideoPixelsRef.current = true;
                      setHasWebRTCVideoPixels(true);
                      setHasReceivedLiveVideo(true);
                    }
                    setHostCamEnabled(true);
                  }}
                  onPlaying={(e) => {
                    const el = e.currentTarget;
                    if (el.videoWidth > 0 && el.videoHeight > 0) {
                      hasWebRTCVideoPixelsRef.current = true;
                      setHasWebRTCVideoPixels(true);
                      setHasReceivedLiveVideo(true);
                    }
                    setHostCamEnabled(true);
                  }}
                />

                {/* Dedicated Guest Audio Elements (DOM-mounted so iOS Safari/Chrome reliably play WebRTC & LiveKit audio) */}
                <audio ref={guestAudioRef} autoPlay playsInline className="hidden" />
                <audio ref={remoteLiveKitAudioRef} autoPlay playsInline className="hidden" />

                {/* Un-Mute Floating Interaction Prompt if Browser Blocked Audio Autoplay */}
                {isGuestAudioMuted && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleUnmuteGuest();
                    }}
                    className="absolute top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-cyan-400 via-teal-300 to-cyan-400 hover:brightness-110 text-slate-950 font-black px-5 py-2.5 rounded-full text-xs uppercase tracking-wider shadow-[0_0_30px_rgba(6,182,212,0.85)] z-40 flex items-center gap-2 animate-bounce cursor-pointer border border-white/60"
                  >
                    <i className="fa-solid fa-volume-high text-sm"></i>
                    <span>BẤM ĐỂ BẬT TIẾNG LIVE STREAM (0MS DELAY)</span>
                  </button>
                )}

                {/* Guest Video/Audio Player Controls: Volume, Mute, Fullscreen */}
                {(hasWebRTCVideoPixels || hasCanvasFrame || hasReceivedLiveVideo || hasReceivedLiveAudio) && (
                  <div 
                    className="absolute bottom-3 right-3 z-40 flex items-center gap-2 bg-[#050914]/85 backdrop-blur-md px-3 py-1.5 rounded-xl border border-cyan-500/40 shadow-[0_0_15px_rgba(0,0,0,0.8)]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={handleToggleGuestMute}
                      className="text-cyan-400 hover:text-cyan-300 text-xs p-1 cursor-pointer transition"
                      title={isGuestAudioMuted || guestVolume === 0 ? 'Bật âm thanh' : 'Tắt âm thanh'}
                    >
                      <i className={`fa-solid ${isGuestAudioMuted || guestVolume === 0 ? 'fa-volume-xmark text-rose-400' : 'fa-volume-high'}`}></i>
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isGuestAudioMuted ? 0 : guestVolume}
                      onChange={(e) => handleGuestVolumeChange(parseFloat(e.target.value))}
                      className="w-16 h-1 accent-cyan-400 cursor-pointer"
                      title={`Âm lượng: ${Math.round((isGuestAudioMuted ? 0 : guestVolume) * 100)}%`}
                    />
                    <button
                      onClick={() => {
                        const container = guestVideoRef.current?.parentElement;
                        if (container) {
                          if (!document.fullscreenElement) {
                            container.requestFullscreen?.().catch(() => {});
                          } else {
                            document.exitFullscreen?.().catch(() => {});
                          }
                        }
                      }}
                      className="text-slate-300 hover:text-white text-xs p-1 ml-1 cursor-pointer transition"
                      title="Xem toàn màn hình"
                    >
                      <i className="fa-solid fa-expand"></i>
                    </button>
                  </div>
                )}

                {!hasWebRTCVideoPixels && !hasCanvasFrame && (
                  <div className="absolute inset-0 bg-[#050914] flex flex-col items-center justify-center p-6 text-center z-30 pointer-events-none">
                    <div className="w-16 h-16 rounded-full border-2 border-[#00F2FE] flex items-center justify-center text-2xl text-[#00F2FE] animate-spin mb-3">
                      <i className="fa-solid fa-rotate"></i>
                    </div>
                    <h4 className="text-sm font-bold text-white uppercase tracking-wider">
                      ĐANG KẾT NỐI CAMERA & MÀN HÌNH TRỰC TIẾP...
                    </h4>
                    <p className="text-xs text-slate-400 mt-1">
                      Vui lòng chờ Quản lý bật Camera hoặc bấm Chia Sẻ Màn Hình
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Movable, Resizable & Zoomable Host Live PiP Frame during Screen Share (Active Host Only - Synced live to Guests!) */}
            {isActiveHost && screenShareEnabled && (
              hostPipLayout.visible ? (
                <div
                  onPointerDown={startPipDrag}
                  style={{
                    left: `${hostPipLayout.xPct}%`,
                    top: `${hostPipLayout.yPct}%`,
                    width: `${hostPipLayout.widthPct}%`,
                  }}
                  className="absolute aspect-video bg-[#070d1b]/95 border-2 border-[#05FFD2] rounded-xl overflow-hidden shadow-[0_0_24px_rgba(5,255,210,0.65)] z-30 cursor-move select-none touch-none group/pip"
                  title="Kéo để di chuyển khung Live của Host (khách cũng thấy đúng vị trí này)"
                >
                  {cameraEnabled ? (
                    <video
                      ref={screenShareVideoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{
                        transform: `scale(${hostPipLayout.zoom})`,
                        transition: 'transform 120ms ease-out',
                      }}
                      className="w-full h-full object-cover pointer-events-none"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-[#0a152e] to-[#050814] pointer-events-none">
                      <div className="w-9 h-9 rounded-full bg-[#00F2FE] text-slate-950 font-black flex items-center justify-center text-sm shadow">
                        N
                      </div>
                      <span className="text-[10px] font-bold text-cyan-200 mt-1">HOST • nptteam</span>
                    </div>
                  )}

                  {/* Top Mini Controls on Host Live PiP Frame */}
                  <div
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute top-1 left-1 right-1 flex items-center justify-between gap-1 opacity-95 sm:opacity-0 sm:group-hover/pip:opacity-100 transition-opacity z-20"
                  >
                    <span className="bg-black/80 text-[#05FFD2] text-[8px] font-bold px-1.5 py-0.5 rounded pointer-events-none">
                      ✥ Kéo
                    </span>
                    <div className="flex items-center gap-0.5 bg-black/85 rounded-md p-0.5 border border-[#05FFD2]/40">
                      <button
                        type="button"
                        onClick={() => setHostPipLayout(p => ({ ...p, widthPct: Math.max(14, p.widthPct - 4) }))}
                        className="w-4 h-4 rounded hover:bg-slate-700 text-white text-[10px] font-black cursor-pointer"
                        title="Thu nhỏ khung Host"
                      >
                        −
                      </button>
                      <button
                        type="button"
                        onClick={() => setHostPipLayout(p => ({ ...p, widthPct: Math.min(52, p.widthPct + 4) }))}
                        className="w-4 h-4 rounded hover:bg-slate-700 text-white text-[10px] font-black cursor-pointer"
                        title="Phóng to khung Host"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const steps = [1, 1.35, 1.75, 2.2];
                          const idx = steps.findIndex(v => Math.abs(v - hostPipLayout.zoom) < 0.1);
                          const nextZoom = steps[(idx + 1) % steps.length];
                          setHostPipLayout(p => ({ ...p, zoom: nextZoom }));
                        }}
                        className="px-1 h-4 rounded hover:bg-slate-700 text-[#FFD700] text-[8px] font-black cursor-pointer"
                        title="Zoom camera Host"
                      >
                        {hostPipLayout.zoom}x
                      </button>
                      <button
                        type="button"
                        onClick={() => setHostPipLayout({ xPct: 72, yPct: 5, widthPct: 25, zoom: 1, visible: true })}
                        className="w-4 h-4 rounded hover:bg-slate-700 text-cyan-300 text-[9px] cursor-pointer"
                        title="Đặt lại mặc định"
                      >
                        ↺
                      </button>
                      <button
                        type="button"
                        onClick={() => setHostPipLayout(p => ({ ...p, visible: false }))}
                        className="w-4 h-4 rounded hover:bg-rose-700 text-rose-300 text-[9px] font-black cursor-pointer"
                        title="Ẩn khung Host trên màn hình chia sẻ"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Host Label */}
                  <span className="absolute bottom-1 left-1 bg-black/85 text-[#05FFD2] text-[9px] font-black px-1.5 py-0.5 rounded pointer-events-none">
                    👑 KHUNG LIVE HOST
                  </span>

                  {/* Bottom-Right Corner Resize Handle */}
                  <div
                    onPointerDown={startPipResize}
                    className="absolute bottom-0 right-0 w-4 h-4 bg-[#05FFD2] text-slate-950 flex items-center justify-center rounded-tl-md cursor-nwse-resize z-20 shadow"
                    title="Kéo để thu phóng kích thước khung Host"
                  >
                    <i className="fa-solid fa-up-right-and-down-left-from-center text-[8px] rotate-90"></i>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setHostPipLayout(p => ({ ...p, visible: true }))}
                  className="absolute top-3 right-3 z-30 bg-black/85 hover:bg-slate-900 border border-[#05FFD2]/70 text-[#05FFD2] text-[10px] font-black px-3 py-1.5 rounded-full shadow-lg cursor-pointer flex items-center gap-1.5"
                >
                  <i className="fa-solid fa-eye"></i>
                  <span>Hiện Khung Live Host</span>
                </button>
              )
            )}

            {/* Real-time Floating Hearts Overlay */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden z-40">
              {floatingHearts.map((heart) => (
                <div
                  key={heart.id}
                  className="absolute bottom-6 text-2xl sm:text-3xl animate-float-up-straight pointer-events-none"
                  style={{
                    left: `${heart.x}%`,
                    color: heart.color || '#EF4444',
                    filter: 'drop-shadow(0 0 12px rgba(239, 68, 68, 0.9))',
                  }}
                >
                  <i className="fa-solid fa-heart"></i>
                </div>
              ))}
            </div>

            {/* Pinned Product Floating Overlay Card (Bottom Left of Video - Collapsible) */}
            {pinnedProduct && (
              isPinnedProductCollapsed ? (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-3 left-3 z-30 max-w-[265px] sm:max-w-xs bg-[#0A0F1D]/92 border-2 border-[#FFD700]/90 px-2.5 py-1.5 rounded-xl shadow-[0_0_20px_rgba(255,215,0,0.35)] backdrop-blur-xl flex items-center gap-2"
                >
                  <img
                    src={pinnedProduct.images[0]}
                    alt={pinnedProduct.name}
                    className="w-8 h-8 object-contain rounded-lg bg-black/60 p-0.5 border border-[#FFD700]/40 shrink-0 cursor-pointer"
                    onClick={() => setIsPinnedProductCollapsed(false)}
                    onError={(e) => {
                      e.currentTarget.src = '/p/dx/d01.jpg';
                    }}
                  />
                  <div
                    className="min-w-0 flex-grow cursor-pointer"
                    onClick={() => setIsPinnedProductCollapsed(false)}
                  >
                    <p className="text-[11px] font-bold text-white truncate leading-tight">
                      {pinnedProduct.name}
                    </p>
                    <span className="text-[11px] font-black text-[#FFD700]">
                      {pinnedProduct.price.toLocaleString('vi-VN')}đ
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onBuyNow(pinnedProduct)}
                    className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:brightness-110 text-slate-950 font-black px-2 py-1 rounded-lg text-[10px] uppercase shrink-0 cursor-pointer"
                    title="Mua ngay sản phẩm này"
                  >
                    Mua
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPinnedProductCollapsed(false)}
                    className="bg-slate-800/90 hover:bg-slate-700 text-[#FFD700] border border-[#FFD700]/40 px-2 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1 shrink-0 cursor-pointer transition"
                    title="Mở rộng sản phẩm đang ghim"
                  >
                    <i className="fa-solid fa-chevron-up text-[9px]"></i>
                    <span>Mở</span>
                  </button>
                </div>
              ) : (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-3 left-3 right-3 sm:right-auto sm:max-w-md bg-[#0A0F1D]/95 border-2 border-[#FFD700] p-2.5 rounded-xl shadow-[0_0_25px_rgba(255,215,0,0.4)] backdrop-blur-xl z-30 flex items-center gap-3"
                >
                  <img
                    src={pinnedProduct.images[0]}
                    alt={pinnedProduct.name}
                    className="w-14 h-14 object-contain rounded-lg bg-black/60 p-1 border border-[#FFD700]/40 shrink-0"
                    onError={(e) => {
                      e.currentTarget.src = '/p/dx/d01.jpg';
                    }}
                  />
                  <div className="min-w-0 flex-grow">
                    <div className="flex items-center justify-between gap-1.5 mb-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="bg-[#FFD700] text-slate-950 font-black text-[9px] px-1.5 py-0.2 rounded uppercase shrink-0">
                          📌 ĐANG GHIM LIVE
                        </span>
                        <span className="text-[10px] text-cyan-300 font-semibold truncate">
                          {pinnedProduct.series}
                        </span>
                      </div>
                    </div>
                    <h4 className="text-xs font-bold text-white truncate">{pinnedProduct.name}</h4>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm font-black text-[#FFD700]">
                        {pinnedProduct.price.toLocaleString('vi-VN')}đ
                      </span>
                      {pinnedProduct.originalPrice && (
                        <span className="text-[10px] text-slate-400 line-through">
                          {pinnedProduct.originalPrice.toLocaleString('vi-VN')}đ
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <div className="flex items-center justify-end gap-1 mb-0.5">
                      <button
                        type="button"
                        onClick={() => setIsPinnedProductCollapsed(true)}
                        className="bg-slate-800/90 hover:bg-slate-700 text-slate-200 hover:text-[#FFD700] border border-slate-600/80 px-2 py-0.5 rounded-md text-[10px] font-bold flex items-center gap-1 cursor-pointer transition"
                        title="Thu gọn sản phẩm trên màn hình Live"
                      >
                        <i className="fa-solid fa-chevron-down text-[9px]"></i>
                        <span>Thu gọn</span>
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={handleUnpinProduct}
                          className="bg-rose-950/90 hover:bg-rose-900 text-rose-300 border border-rose-500/60 px-1.5 py-0.5 rounded-md text-[10px] font-bold cursor-pointer transition"
                          title="Bỏ ghim sản phẩm này"
                        >
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onBuyNow(pinnedProduct)}
                      className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:brightness-110 text-slate-950 font-black px-3 py-1.5 rounded-lg text-xs uppercase tracking-wider shadow-md transition cursor-pointer"
                    >
                      MUA NGAY
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectProduct(pinnedProduct)}
                      className="bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold px-2.5 py-1 rounded-lg text-[10px] transition cursor-pointer"
                    >
                      Chi tiết
                    </button>
                  </div>
                </div>
              )
            )}
            </div>
          </div>

          {/* Broadcast Controls Toolbar (CHỈ NGƯỜI ĐANG PHÁT LIVE MỚI CÓ QUYỀN BẬT/DỪNG MÀN HÌNH, CAM, MIC) */}
          {isActiveHost ? (
            <div className="bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/60 p-3.5 rounded-2xl shadow-[0_0_20px_rgba(0,242,254,0.2)] flex flex-wrap items-center justify-between gap-2.5 backdrop-blur-xl">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Toggle Camera */}
                <button
                  onClick={handleToggleCamera}
                  className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 cursor-pointer shadow-md ${
                    cameraEnabled
                      ? 'bg-cyan-500/20 text-[#00F2FE] border border-[#00F2FE] shadow-[0_0_12px_rgba(0,242,254,0.3)]'
                      : 'bg-rose-950/80 text-rose-300 border border-rose-600'
                  }`}
                  title={cameraEnabled ? 'Tắt Camera' : 'Bật Camera'}
                >
                  <i className={`fa-solid ${cameraEnabled ? 'fa-video' : 'fa-video-slash'}`}></i>
                  <span>{cameraEnabled ? 'TẮT CAM' : 'BẬT CAM'}</span>
                </button>

                {/* Toggle Mic + Live Voice Pickup Level Meter */}
                <button
                  onClick={handleToggleMic}
                  className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 cursor-pointer shadow-md ${
                    micEnabled
                      ? 'bg-cyan-500/20 text-[#00F2FE] border border-[#00F2FE] shadow-[0_0_12px_rgba(0,242,254,0.3)]'
                      : 'bg-rose-950/80 text-rose-300 border border-rose-600'
                  }`}
                  title={micEnabled ? 'Tắt Microphone' : 'Bật Microphone'}
                >
                  <i className={`fa-solid ${micEnabled ? 'fa-microphone' : 'fa-microphone-slash'}`}></i>
                  <span>{micEnabled ? 'TẮT MIC' : 'BẬT MIC'}</span>
                  {micEnabled && (
                    <span className="flex items-end gap-0.5 h-3.5 ml-0.5" title={`Tín hiệu giọng nói: ${hostMicLevel}%`}>
                      {[18, 38, 62, 85].map((thresh, idx) => (
                        <span
                          key={idx}
                          className={`w-1 rounded-full transition-all duration-75 ${
                            hostMicLevel >= thresh ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-slate-600/70'
                          }`}
                          style={{ height: `${5 + idx * 2}px` }}
                        />
                      ))}
                    </span>
                  )}
                </button>

                {/* AI Dereverberation, AEC & Noise Suppression (Khử Vang, Vọng Phòng & Tạp Âm Mic) */}
                <button
                  onClick={handleToggleNoiseFilter}
                  className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 cursor-pointer shadow-md ${
                    noiseFilterActive
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.35)]'
                      : 'bg-slate-800 text-slate-400 border border-slate-700'
                  }`}
                  title="Studio DSP: Triệt tiêu hoàn toàn tiếng vang dội phòng, tường rỗng & chống feedback vọng mic"
                >
                  <i className="fa-solid fa-wand-magic-sparkles text-emerald-400"></i>
                  <span>AI KHỬ VANG & CHỐNG VỌNG: {noiseFilterActive ? 'BẬT (STUDIO)' : 'TẮT'}</span>
                </button>

                {/* Screen Share as Live Source */}
                <button
                  onClick={handleToggleScreenShare}
                  className={`px-3.5 py-2 rounded-xl text-xs font-black transition flex items-center gap-2 cursor-pointer shadow-md ${
                    screenShareEnabled
                      ? 'bg-[#05FFD2] text-slate-950 shadow-[0_0_15px_rgba(5,255,210,0.5)]'
                      : 'bg-[#05FFD2]/20 text-[#05FFD2] border border-[#05FFD2] hover:bg-[#05FFD2]/30'
                  }`}
                  title="Chia sẻ toàn màn hình hoặc cửa sổ OBS vào Live"
                >
                  <i className="fa-solid fa-desktop"></i>
                  <span>{screenShareEnabled ? 'DỪNG PHÁT MÀN HÌNH' : 'PHÁT MÀN HÌNH (SHARE SCREEN)'}</span>
                </button>

                {/* Camera Device Selector Dropdown */}
                {availableVideoDevices.length > 0 && (
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => {
                      setSelectedDeviceId(e.target.value);
                      setStreamSourceMode('camera');
                    }}
                    className="bg-slate-900 border border-cyan-500/50 text-cyan-300 px-3 py-2 rounded-xl text-xs font-bold outline-none cursor-pointer"
                    title="Chọn nguồn camera (Webcam hoặc OBS Virtual Camera)"
                  >
                    <option value="">🎥 Mặc định (Webcam)</option>
                    {availableVideoDevices.map(dev => (
                      <option key={dev.deviceId} value={dev.deviceId}>
                        📹 {dev.label || `Camera ${dev.deviceId.slice(0, 5)}`}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setIsOBSModalOpen(true)}
                  className="bg-slate-800 hover:bg-slate-700 text-[#FFD700] border border-[#FFD700]/50 font-bold px-3 py-2 rounded-xl text-xs uppercase tracking-wider transition flex items-center gap-1.5 cursor-pointer"
                >
                  <i className="fa-solid fa-sliders"></i> Cài Đặt OBS
                </button>

                <button
                  onClick={() => setIsPinModalOpen(true)}
                  className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:brightness-110 text-slate-950 font-black px-4 py-2 rounded-xl text-xs uppercase tracking-wider shadow-[0_0_15px_rgba(255,215,0,0.4)] transition flex items-center gap-1.5 cursor-pointer"
                >
                  <i className="fa-solid fa-thumbtack"></i> GHIM SP
                </button>
              </div>
            </div>
          ) : (
            /* GUEST INTERACTION BAR (LIKE HEARTS) */
            <div className="bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/60 p-3.5 rounded-2xl shadow-[0_0_20px_rgba(0,242,254,0.2)] flex items-center justify-between gap-3 backdrop-blur-xl">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
                <span className="text-xs text-slate-300 font-bold">Thả tim tương tác cùng buổi phát trực tiếp!</span>
              </div>
              <button
                onClick={handleSendHeart}
                className="bg-gradient-to-r from-rose-500 to-pink-600 hover:scale-105 text-white font-black px-5 py-2.5 rounded-xl text-xs uppercase tracking-wider shadow-[0_0_20px_rgba(244,63,94,0.6)] transition duration-200 cursor-pointer flex items-center gap-2 active:scale-95"
              >
                <i className="fa-solid fa-heart animate-bounce text-sm"></i>
                <span>THẢ TIM (LIKE) ❤️</span>
              </button>
            </div>
          )}
        </div>

        {/* Right Column: Interactive Chat, Viewers, & Pinned Products Tab Sidebar (4 Cols desktop) */}
        <div className="lg:col-span-4 bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/60 rounded-2xl shadow-[0_0_30px_rgba(0,242,254,0.2)] flex flex-col h-[650px] backdrop-blur-xl overflow-hidden">
          {/* Sidebar Tab Navigation Header */}
          <div className="grid grid-cols-3 border-b-2 border-slate-800 bg-[#030508]/80 text-xs font-black">
            <button
              onClick={() => setChatTab('chat')}
              className={`py-3 text-center transition cursor-pointer ${
                chatTab === 'chat'
                  ? 'text-[#00F2FE] border-b-2 border-[#00F2FE] bg-[#00F2FE]/10 shadow-[inset_0_-2px_10px_rgba(0,242,254,0.2)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              💬 BÌNH LUẬN ({messages.length})
            </button>
            <button
              onClick={() => setChatTab('viewers')}
              className={`py-3 text-center transition cursor-pointer ${
                chatTab === 'viewers'
                  ? 'text-[#00F2FE] border-b-2 border-[#00F2FE] bg-[#00F2FE]/10 shadow-[inset_0_-2px_10px_rgba(0,242,254,0.2)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              👥 NGƯỜI XEM ({participants.length})
            </button>
            <button
              onClick={() => setChatTab('products')}
              className={`py-3 text-center transition cursor-pointer ${
                chatTab === 'products'
                  ? 'text-[#00F2FE] border-b-2 border-[#00F2FE] bg-[#00F2FE]/10 shadow-[inset_0_-2px_10px_rgba(0,242,254,0.2)]'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              🛍️ SẢN PHẨM
            </button>
          </div>

          {/* TAB 1: LIVE CHAT MESSAGES & ATTACHMENTS (LINK, IMAGE, FILE) */}
          {chatTab === 'chat' && (
            <div className="flex-grow flex flex-col min-h-0">
              {/* Message History Feed */}
              <div ref={chatContainerRef} className="flex-grow overflow-y-auto p-3.5 space-y-3">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-3 rounded-xl border transition text-xs ${
                      msg.isAdmin
                        ? 'bg-amber-950/20 border-amber-500/50 shadow-[0_0_15px_rgba(255,215,0,0.15)]'
                        : 'bg-slate-900/80 border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`font-bold ${msg.isAdmin ? 'text-[#FFD700]' : 'text-cyan-300'}`}>
                          {msg.senderName}
                        </span>
                        {msg.senderBadge && (
                          <span className={`text-[9px] font-black px-1.5 py-0.2 rounded uppercase ${
                            msg.isAdmin ? 'bg-amber-400 text-slate-950' : 'bg-slate-800 text-slate-300 border border-slate-700'
                          }`}>
                            {msg.senderBadge}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400">{msg.timestamp}</span>
                    </div>

                    {/* Text content with clickable links */}
                    {msg.text && (
                      <p className="text-slate-200 leading-relaxed break-words mt-1">
                        {renderMessageTextWithLinks(msg.text)}
                      </p>
                    )}

                    {/* Attached Image with click to view in Lightbox */}
                    {msg.image && (
                      <div className="mt-2.5">
                        <img
                          src={msg.image}
                          alt="Attached"
                          className="max-h-36 rounded-lg border border-cyan-500/40 object-cover cursor-pointer hover:brightness-110 transition shadow"
                          onClick={() => setSelectedImageLightbox(msg.image || null)}
                        />
                        <span className="text-[9px] text-cyan-400 italic block mt-1">Bấm vào ảnh để phóng to</span>
                      </div>
                    )}

                    {/* Attached File with download button */}
                    {msg.file && (
                      <div className="mt-2.5 bg-[#030508] border border-cyan-500/40 p-2.5 rounded-xl flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-[#00F2FE] flex items-center justify-center shrink-0">
                            <i className="fa-solid fa-file-arrow-down text-sm"></i>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-white truncate">{msg.file.name}</p>
                            <span className="text-[10px] text-slate-400">
                              {(msg.file.size / (1024 * 1024)).toFixed(2)} MB
                            </span>
                          </div>
                        </div>
                        <a
                          href={msg.file.url}
                          download={msg.file.name}
                          className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black px-3 py-1.5 rounded-lg text-[10px] uppercase transition shrink-0 shadow flex items-center gap-1 cursor-pointer"
                        >
                          <i className="fa-solid fa-download"></i> Tải file
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Chat Input Bar with Image & File Attachments */}
              <div className="p-3 border-t-2 border-slate-800 bg-[#030508]/90 space-y-2">
                {/* Preview attached image or file before sending */}
                {attachedImage && (
                  <div className="flex items-center justify-between bg-slate-900 border border-cyan-500/40 p-2 rounded-xl">
                    <div className="flex items-center gap-2">
                      <img src={attachedImage} alt="Preview" className="w-10 h-10 object-cover rounded-lg" />
                      <span className="text-xs text-cyan-300 font-bold">Đã đính kèm ảnh</span>
                    </div>
                    <button
                      onClick={() => setAttachedImage(null)}
                      className="text-rose-400 hover:text-rose-300 p-1 cursor-pointer"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  </div>
                )}

                {attachedFile && (
                  <div className="flex items-center justify-between bg-slate-900 border border-cyan-500/40 p-2 rounded-xl">
                    <div className="flex items-center gap-2">
                      <i className="fa-solid fa-file text-[#00F2FE]"></i>
                      <span className="text-xs text-cyan-300 font-bold truncate max-w-[180px]">{attachedFile.name}</span>
                    </div>
                    <button
                      onClick={() => setAttachedFile(null)}
                      className="text-rose-400 hover:text-rose-300 p-1 cursor-pointer"
                    >
                      <i className="fa-solid fa-xmark"></i>
                    </button>
                  </div>
                )}

                <form 
                  onSubmit={(e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    handleSendMessage(e); 
                  }} 
                  className="flex items-center gap-2"
                >
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Upload Image Button */}
                    <label className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 flex items-center justify-center cursor-pointer transition shadow" title="Gửi ảnh">
                      <i className="fa-solid fa-image text-xs"></i>
                      <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                    </label>

                    {/* Upload File Button */}
                    <label className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 flex items-center justify-center cursor-pointer transition shadow" title="Gửi file tài liệu">
                      <i className="fa-solid fa-paperclip text-xs"></i>
                      <input type="file" onChange={handleFileUpload} className="hidden" />
                    </label>
                  </div>

                  <input
                    ref={chatInputRef}
                    type="text"
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        handleSendMessage(e);
                      }
                    }}
                    placeholder="Nhập bình luận, dán link..."
                    className="flex-grow bg-[#0A0F1D] border border-slate-700 focus:border-[#00F2FE] text-white px-3 py-2 rounded-xl text-xs outline-none transition"
                  />

                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSendMessage(e);
                    }}
                    className="bg-gradient-to-r from-cyan-500 to-blue-600 hover:brightness-110 text-slate-950 font-black px-3.5 py-2 rounded-xl text-xs transition shadow cursor-pointer shrink-0 flex items-center gap-1 active:scale-95"
                  >
                    <span>Gửi</span>
                    <i className="fa-solid fa-paper-plane text-[10px]"></i>
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* TAB 2: PARTICIPANTS / VIEWERS LIST (100% REAL ACCOUNTS ONLY) */}
          {chatTab === 'viewers' && (
            <div className="flex-grow overflow-y-auto p-3.5 space-y-2.5">
              {/* Real Connection Status Banner */}
              <div className="bg-slate-900/90 border border-emerald-500/30 p-3 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                  <div>
                    <h4 className="text-xs font-bold text-white flex items-center gap-1.5">
                      Khán giả đang theo dõi
                    </h4>
                    <p className="text-[10.5px] text-slate-400">
                      Danh sách người xem có mặt trong phòng
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      const cloudViewers = await fetchLiveViewersOnce(liveSessionIdRef.current);
                      if (cloudViewers.length > 0) {
                        setParticipants(cloudViewers);
                        setViewersCount(cloudViewers.length);
                        showToast('🔄 Đã làm mới danh sách người xem từ Cloud!', 'info');
                        return;
                      }
                      fetch('/api/live/viewers')
                        .then(r => (r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json() : null))
                        .then(d => {
                          if (d && Array.isArray(d.viewers)) {
                            setParticipants(d.viewers);
                            setViewersCount(d.viewers.length > 0 ? d.viewers.length : 1);
                            showToast('🔄 Đã làm mới danh sách người xem thật', 'info');
                          }
                        })
                        .catch(() => {});
                    }}
                    className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs transition cursor-pointer"
                    title="Làm mới danh sách"
                  >
                    <i className="fa-solid fa-arrows-rotate"></i>
                  </button>
                  <span className="bg-cyan-500/20 text-[#00F2FE] border border-cyan-500/40 px-2 py-0.5 rounded-full text-xs font-black">
                    {participants.length} người
                  </span>
                </div>
              </div>

              {/* Guest Login Suggestion Banner if not logged in */}
              {!currentUser && !isAdmin && onOpenAuth && (
                <div className="bg-amber-950/40 border border-amber-500/40 p-3 rounded-xl flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-amber-200 text-xs">
                    <i className="fa-solid fa-circle-user text-amber-400 text-base"></i>
                    <div>
                      <p className="font-bold">Bạn đang xem với tư cách Khách ghé thăm</p>
                      <p className="text-[10.5px] text-amber-300/80">Đăng nhập tài khoản để hiện họ tên thật của bạn</p>
                    </div>
                  </div>
                  <button
                    onClick={onOpenAuth}
                    className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-3 py-1.5 rounded-lg text-[11px] uppercase transition cursor-pointer shrink-0 shadow"
                  >
                    Đăng Nhập
                  </button>
                </div>
              )}

              {participants.length === 0 ? (
                <div className="text-center py-8 text-slate-500 text-xs">
                  <i className="fa-solid fa-users text-2xl mb-2 block opacity-40"></i>
                  Đang đồng bộ người xem từ máy chủ...
                </div>
              ) : (
                participants.map((viewer) => {
                  const isCurrent = viewer.id === currentUserId;
                  return (
                    <div
                      key={viewer.id}
                      className={`p-3 rounded-xl flex items-center justify-between gap-2.5 transition border ${
                        viewer.isAdmin
                          ? 'bg-amber-950/30 border-amber-500/40'
                          : isCurrent
                          ? 'bg-cyan-950/30 border-cyan-500/40'
                          : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black shrink-0 relative ${
                          viewer.isAdmin
                            ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20'
                            : viewer.isRegisteredCustomer
                            ? 'bg-gradient-to-tr from-cyan-600 to-blue-500 text-white'
                            : 'bg-slate-800 text-slate-300 border border-slate-700'
                        }`}>
                          {viewer.isAdmin ? (
                            <i className="fa-solid fa-crown"></i>
                          ) : viewer.isRegisteredCustomer ? (
                            viewer.name.slice(0, 2).toUpperCase()
                          ) : (
                            <i className="fa-solid fa-user"></i>
                          )}
                          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 border-2 border-slate-950 rounded-full"></span>
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-xs font-bold text-white truncate">{viewer.name}</h4>
                            {isCurrent && (
                              <span className="bg-cyan-400/20 text-cyan-300 border border-cyan-400/40 text-[9px] px-1.5 py-0.2 rounded font-bold">
                                Bạn
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                            <span className={viewer.isAdmin ? 'text-amber-400 font-bold' : viewer.isRegisteredCustomer ? 'text-cyan-300 font-bold' : 'text-slate-400'}>
                              {viewer.roleBadge || (viewer.isAdmin ? '👑 Quản Lý Showroom' : viewer.isRegisteredCustomer ? '⭐ Thành Viên Đã Đăng Ký' : '👤 Khách Trực Tuyến')}
                            </span>
                            {viewer.joinedAt && (
                              <>
                                <span>•</span>
                                <span>{viewer.joinedAt}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1 bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          Online
                        </span>

                        {isAdmin && !viewer.isAdmin && !isCurrent && (
                          <button
                            onClick={() => handleKickViewer(viewer.id, viewer.name)}
                            className="bg-rose-950 hover:bg-rose-900 text-rose-300 border border-rose-600 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition cursor-pointer shadow"
                            title="Mời người xem này ra khỏi phòng live"
                          >
                            <i className="fa-solid fa-user-slash mr-1"></i> Mời ra
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {/* TAB 3: PRODUCTS STORE CATALOG FOR LIVE */}
          {chatTab === 'products' && (
            <div className="flex-grow overflow-y-auto p-3.5 space-y-2.5">
              <div className="bg-slate-900 border border-slate-800 p-2.5 rounded-xl mb-2 flex items-center justify-between">
                <span className="text-[11px] text-slate-300 font-bold">Danh mục sản phẩm Live Store</span>
                {isAdmin && (
                  <button
                    onClick={() => setIsPinModalOpen(true)}
                    className="bg-amber-400 text-slate-950 font-black text-[10px] px-2.5 py-1 rounded-lg uppercase shadow"
                  >
                    Ghim sản phẩm
                  </button>
                )}
              </div>

              {products.map((product) => (
                <div
                  key={product.id}
                  className="bg-slate-900/90 border border-slate-800 hover:border-[#FFD700] p-2.5 rounded-xl flex items-center gap-3 transition group cursor-pointer"
                  onClick={() => onSelectProduct(product)}
                >
                  <img
                    src={product.images[0]}
                    alt={product.name}
                    className="w-14 h-14 object-contain rounded-lg bg-black/60 p-1 border border-slate-700 shrink-0"
                    onError={(e) => {
                      e.currentTarget.src = '/p/dx/d01.jpg';
                    }}
                  />
                  <div className="min-w-0 flex-grow">
                    <span className="text-[9px] text-[#00F2FE] font-bold uppercase">{product.series}</span>
                    <h4 className="text-xs font-bold text-white truncate group-hover:text-[#FFD700] transition">
                      {product.name}
                    </h4>
                    <span className="text-xs font-black text-[#FFD700]">
                      {product.price.toLocaleString('vi-VN')}đ
                    </span>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onBuyNow(product);
                      }}
                      className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-2.5 py-1 rounded-lg text-[10px] uppercase shadow"
                    >
                      Mua ngay
                    </button>
                    {isAdmin && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePinProduct(product);
                        }}
                        className="bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-300 border border-cyan-500/50 font-bold px-2 py-0.5 rounded-lg text-[9px]"
                      >
                        Ghim live
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* OBS STUDIO CONFIGURATION MODAL FOR ADMIN */}
      {isOBSModalOpen && isAdmin && (
        <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0A0F1D] border-2 border-[#FFD700] rounded-3xl p-6 sm:p-8 max-w-2xl w-full shadow-[0_0_50px_rgba(255,215,0,0.4)] max-h-[90vh] flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-400/20 text-[#FFD700] border border-[#FFD700]/50 flex items-center justify-center text-xl">
                  <i className="fa-solid fa-tower-broadcast"></i>
                </div>
                <div>
                  <h3 className="text-base font-black text-[#FFD700] uppercase tracking-wider">
                    Cấu Hình Kết Nối OBS Studio
                  </h3>
                  <p className="text-xs text-slate-400">
                    Thông số kết nối phần mềm phát sóng trực tiếp
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsOBSModalOpen(false)}
                className="text-slate-400 hover:text-white p-2 rounded-lg bg-slate-800/80 cursor-pointer"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Method 1: Virtual Camera */}
              <div className="bg-[#050914] border-2 border-emerald-500/60 p-4 rounded-2xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-black text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <i className="fa-solid fa-camera"></i> CÁCH 1: SỬ DỤNG MÁY QUAY ẢO (VIRTUAL CAMERA)
                  </span>
                </div>
                <p className="text-slate-200 leading-relaxed text-[11px]">
                  1. Trong OBS Studio, bấm nút <strong>Bắt đầu máy quay ảo (Start Virtual Camera)</strong>.<br />
                  2. Tại giao diện quản lý trên web, chọn <strong>Camera Trực Tiếp</strong> rồi bấm <strong>GO LIVE</strong>.<br />
                  3. Hình ảnh và âm thanh từ OBS Studio sẽ được truyền trực tiếp lên phòng phát sóng.
                </p>
              </div>

              {/* Method 2: Direct Stream */}
              <div className="bg-slate-900 border-2 border-[#00F2FE]/50 p-4 rounded-2xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-black text-[#00F2FE] uppercase tracking-wider flex items-center gap-1.5">
                    <i className="fa-solid fa-bolt"></i> CÁCH 2: KẾT NỐI LUỒNG TRỰC TIẾP
                  </span>
                </div>
                <p className="text-slate-300">
                  Trong OBS: Vào <strong>Thiết đặt (Settings) &gt; Luồng (Stream)</strong>:
                </p>

                <div className="space-y-2">
                    <div>
                      <label className="text-slate-400 block mb-1 font-bold">Địa chỉ máy chủ (Server URL):</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          readOnly
                          value={obsConfig?.whipUrl || 'https://live.nptteamstore.vn/stream'}
                          className="flex-grow bg-[#050914] border border-slate-700 px-3 py-2 rounded-xl text-white font-mono text-[11px]"
                        />
                        <button
                          onClick={() => copyToClipboard(obsConfig?.whipUrl || 'https://live.nptteamstore.vn/stream', 'Địa chỉ máy chủ')}
                          className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black px-3 py-2 rounded-xl text-xs uppercase"
                        >
                          Sao chép
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="text-slate-400 block mb-1 font-bold">Khóa xác thực luồng (Token):</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          readOnly
                          value={obsConfig?.bearerToken || 'npt_live_stream_key_2026'}
                          className="flex-grow bg-[#050914] border border-slate-700 px-3 py-2 rounded-xl text-white font-mono text-[11px]"
                        />
                        <button
                          onClick={() => copyToClipboard(obsConfig?.bearerToken || 'npt_live_stream_key_2026', 'Khóa xác thực luồng')}
                          className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black px-3 py-2 rounded-xl text-xs uppercase"
                        >
                          Sao chép
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Method 3: Custom Server */}
                <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-2.5">
                  <span className="font-black text-[#FFD700] uppercase tracking-wider block">
                    CÁCH 3: TÙY CHỌN MÁY CHỦ PHÁT SÓNG
                  </span>
                  <p className="text-slate-300 text-[11px]">
                    Trong OBS: Dịch vụ chọn <strong>Tùy chỉnh (Custom)</strong>:
                  </p>
                  <div>
                    <label className="text-slate-400 block mb-1 font-bold">Máy chủ (Server):</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={obsConfig?.rtmpServer || 'https://live.nptteamstore.vn/ingest'}
                        className="flex-grow bg-[#050914] border border-slate-700 px-3 py-2 rounded-xl text-white font-mono text-[11px]"
                      />
                      <button
                        onClick={() => copyToClipboard(obsConfig?.rtmpServer || 'https://live.nptteamstore.vn/ingest', 'Máy chủ')}
                        className="bg-slate-800 hover:bg-slate-700 text-[#FFD700] font-black px-3 py-2 rounded-xl text-xs uppercase"
                      >
                        Sao chép
                      </button>
                    </div>
                  </div>

                <div>
                  <label className="text-slate-400 block mb-1 font-bold">Khóa luồng (Stream Key):</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      readOnly
                      value={obsConfig?.streamKey || 'npt-live-stream-key'}
                      className="flex-grow bg-[#050914] border border-slate-700 px-3 py-2 rounded-xl text-white font-mono text-[11px]"
                    />
                    <button
                      onClick={() => copyToClipboard(obsConfig?.streamKey || 'npt-live-stream-key', 'Khóa luồng Stream Key')}
                      className="bg-slate-800 hover:bg-slate-700 text-[#FFD700] font-black px-3 py-2 rounded-xl text-xs uppercase"
                    >
                      Sao chép
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-4 mt-4 border-t border-slate-800 flex justify-end">
              <button
                onClick={() => setIsOBSModalOpen(false)}
                className="bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 font-black px-6 py-2.5 rounded-xl uppercase tracking-wider text-xs shadow-lg cursor-pointer"
              >
                Đã Lưu Thông Số
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LIGHTBOX MODAL FOR VIEWING ATTACHED IMAGES */}
      {selectedImageLightbox && (
        <div
          className="fixed inset-0 z-[9999] bg-black/90 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setSelectedImageLightbox(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <button
              onClick={() => setSelectedImageLightbox(null)}
              className="absolute -top-10 right-0 bg-rose-600 hover:bg-rose-500 text-white w-8 h-8 rounded-full flex items-center justify-center font-black shadow-lg cursor-pointer"
            >
              <i className="fa-solid fa-xmark"></i>
            </button>
            <img
              src={selectedImageLightbox}
              alt="Lightbox Fullsize"
              className="max-w-full max-h-[85vh] rounded-2xl border-2 border-[#00F2FE] shadow-[0_0_50px_rgba(0,242,254,0.5)] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}

      {/* PIN PRODUCT MODAL FOR ADMIN */}
      {isPinModalOpen && isAdmin && (
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-[#0A0F1D] border-2 border-[#FFD700] rounded-3xl p-6 max-w-xl w-full shadow-[0_0_50px_rgba(255,215,0,0.4)] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-black text-[#FFD700] uppercase tracking-wider flex items-center gap-2">
                <i className="fa-solid fa-thumbtack"></i> Chọn sản phẩm ghim lên Live
              </h3>
              <button
                onClick={() => setIsPinModalOpen(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg bg-slate-800/80 cursor-pointer"
              >
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="flex-grow overflow-y-auto space-y-2.5 pr-1">
              {products.map((product) => (
                <div
                  key={product.id}
                  onClick={() => handlePinProduct(product)}
                  className="bg-slate-900 border border-slate-800 hover:border-[#FFD700] p-3 rounded-2xl flex items-center justify-between gap-3 cursor-pointer transition group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={product.images[0]}
                      alt={product.name}
                      className="w-12 h-12 object-contain bg-black/60 rounded-xl p-1 border border-slate-700 shrink-0"
                    />
                    <div className="min-w-0">
                      <h4 className="text-xs font-bold text-white truncate group-hover:text-[#FFD700]">{product.name}</h4>
                      <span className="text-xs font-black text-[#FFD700]">{product.price.toLocaleString('vi-VN')}đ</span>
                    </div>
                  </div>
                  <button className="bg-amber-400 hover:bg-amber-300 text-slate-950 font-black px-4 py-2 rounded-xl text-xs uppercase shadow shrink-0">
                    Ghim ngay
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
