import React, { useState, useEffect } from 'react';
import { Header } from './components/Header.tsx';
import { Footer } from './components/Footer.tsx';
import { ProductCard } from './components/ProductCard.tsx';
import { ProductDetailModal } from './components/ProductDetailModal.tsx';
import { CartDrawer } from './components/CartDrawer.tsx';
import { CheckoutModal } from './components/CheckoutModal.tsx';
import { AuthModal } from './components/AuthModal.tsx';
import { AdminModal } from './components/AdminModal.tsx';

// Views
import { HomeView } from './views/HomeView.tsx';
import { ShopView } from './views/ShopView.tsx';
import { AboutView } from './views/AboutView.tsx';
import { BlogView } from './views/BlogView.tsx';
import { PromotionsView } from './views/PromotionsView.tsx';
import { WarrantyView } from './views/WarrantyView.tsx';
import { AuctionView } from './views/AuctionView.tsx';
import { CollectionsView } from './views/CollectionsView.tsx';
import { DashboardView } from './views/DashboardView.tsx';
import { TributeFeedbackView } from './views/TributeFeedbackView.tsx';
import { ContactView } from './views/ContactView.tsx';
import { OrderTrackerView } from './views/OrderTrackerView.tsx';
import { LiveStreamView } from './views/LiveStreamView.tsx';
import { RiderQuiz } from './components/RiderQuiz.tsx';
import { ProductCompareModal } from './components/ProductCompareModal.tsx';
import { AboutWebModal } from './components/AboutWebModal.tsx';
import { CommunityTicker } from './components/CommunityTicker.tsx';
import { WishlistModal } from './components/WishlistModal.tsx';
import { TeamTributeModal } from './components/TeamTributeModal.tsx';
import { OfflineIndicator } from './components/OfflineIndicator.tsx';
import { ChristmasSnowEffect } from './components/ChristmasSnowEffect.tsx';
import { ChristmasEventWidget } from './components/ChristmasEventWidget.tsx';
import { ChristmasCornerDecor } from './components/ChristmasCornerDecor.tsx';
import { HenshinIntroOverlay } from './components/HenshinIntroOverlay.tsx';
import { CollectorSupportWidget } from './components/CollectorSupportWidget.tsx';

import './utils/sound.ts';

// Data
import { INITIAL_PRODUCTS as PRODUCTS_DATA } from './data/products.ts';
import { INITIAL_BLOGS as BLOG_POSTS } from './data/blogs.ts';
import { INITIAL_COUPONS as PROMOTION_COUPONS } from './data/promotions.ts';
import { INITIAL_AUCTIONS as AUCTION_ITEMS } from './data/auctions.ts';
import { INITIAL_ORDERS } from './data/orders.ts';
import { Product, CartItem, User, Order, WarrantyTicket, AuctionItem, BlogPost, Coupon } from './types.ts';
import { api } from './services/api.ts';
import {
  subscribeToCustomerForceLogout,
  getRealClientPublicIp,
  subscribeToBannedIpsRealtime,
  subscribeToCustomerBanStatus,
  updateCustomerIpPresenceCloud,
  BannedIpRecord,
} from './services/realtimeSync.ts';
import { auth, onAuthStateChanged, signOutFirebase, subscribeToOrdersLive, saveOrderLive, updateOrderStatusLive, deleteOrderLive, normalizeLegacyAssets } from './utils/firebase.ts';
import { generateCustomerAvatarSvgUrl } from './utils/avatarGenerator.ts';

const REALTIME_BUYERS = [
  { name: 'Nguyễn Minh Khang', city: 'Q.1, TP. Hồ Chí Minh', maskId: 'gavv-gummy', colorId: 'crimson-ruby' },
  { name: 'Trần Hoàng Phúc', city: 'Q. Cầu Giấy, Hà Nội', maskId: 'decade-king', colorId: 'gold-bandai' },
  { name: 'Lê Quốc Tuấn', city: 'Q. Hải Châu, Đà Nẵng', maskId: 'geats-fox', colorId: 'cyber-cyan' },
  { name: 'Phạm Gia Bảo', city: 'TP. Thủ Đức, TP. Hồ Chí Minh', maskId: 'zero-one', colorId: 'aqua-neon' },
  { name: 'Đặng Thành Đạt', city: 'Q. Ninh Kiều, Cần Thơ', maskId: 'saber-dragon', colorId: 'crimson-ruby' },
  { name: 'Võ Anh Khoa', city: 'Q. Ngô Quyền, Hải Phòng', maskId: 'kiva-bat', colorId: 'gold-bandai' },
  { name: 'Huỳnh Nhật Nam', city: 'TP. Biên Hòa, Đồng Nai', maskId: 'gotchard-steam', colorId: 'cyber-emerald' },
  { name: 'Bùi Tấn Tài', city: 'TP. Thủ Dầu Một, Bình Dương', maskId: 'revice-rex', colorId: 'dark-purple' },
  { name: 'Đỗ Quang Vinh', city: 'Q. Thanh Xuân, Hà Nội', maskId: 'knight-wing', colorId: 'aqua-neon' },
  { name: 'Phan Hữu Thịnh', city: 'TP. Huế, Thừa Thiên Huế', maskId: 'femme-swan', colorId: 'cyber-cyan' },
  { name: 'Trương Đức Anh', city: 'TP. Nha Trang, Khánh Hòa', maskId: 'gavv-gummy', colorId: 'gold-bandai' },
  { name: 'Ngô Minh Triết', city: 'Q. Bình Thạnh, TP. Hồ Chí Minh', maskId: 'geats-fox', colorId: 'crimson-ruby' },
];

function createRealtimeIncomingOrder(catalog: Product[]): Order {
  const pool = catalog.length > 0 ? catalog : PRODUCTS_DATA;
  const prod = pool[Math.floor(Math.random() * pool.length)];
  const buyer = REALTIME_BUYERS[Math.floor(Math.random() * REALTIME_BUYERS.length)];
  const now = new Date();
  const paymentMethods: Order['paymentMethod'][] = ['BANK', 'BANK', 'COD', 'MOMO'];
  const paymentMethod = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];
  const qty = prod.price < 800000 && Math.random() > 0.55 ? 2 : 1;
  const subtotal = prod.price * qty;
  const shippingFee = subtotal >= 1000000 ? 0 : 35000;
  const total = subtotal + shippingFee;
  const initials = buyer.name
    .split(' ')
    .slice(-2)
    .map(part => part.charAt(0).toUpperCase())
    .join('');

  const orderNum = Math.floor(1000 + Math.random() * 9000);
  const randSuffix = Math.random().toString(36).slice(2, 5).toUpperCase();

  return {
    id: `ORDER-2026-NPT-${orderNum}${randSuffix}`,
    date: now.toLocaleDateString('vi-VN'),
    time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    customerName: buyer.name,
    customerPhone: `09${Math.floor(10 + Math.random() * 89)}.***.${Math.floor(100 + Math.random() * 899)}`,
    customerEmail: `${buyer.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10) || 'rider'}.collector@gmail.com`,
    shippingAddress: buyer.city,
    paymentMethod,
    status: paymentMethod === 'BANK' || paymentMethod === 'MOMO' ? 'Đang xử lý' : 'Chờ xác nhận',
    subtotal,
    discountAmount: 0,
    pointsDiscount: 0,
    shippingFee,
    total,
    pointsEarned: Math.floor(total / 10000),
    customerAvatar: generateCustomerAvatarSvgUrl({
      maskId: buyer.maskId as any,
      colorId: buyer.colorId as any,
      initials: initials || 'NR',
      customerName: buyer.name,
    }),
    items: [
      {
        productId: prod.id,
        productName: prod.name,
        productImage: prod.images?.[0] || '/p/dx/d01.jpg',
        price: prod.price,
        quantity: qty,
        serialKey: `NPT-LIVE-${orderNum}-JP`,
      },
    ],
  };
}

function mergeOrdersUnique(primary: Order[], secondary: Order[]): Order[] {
  const seen = new Set<string>();
  const merged: Order[] = [];
  for (const item of [...primary, ...secondary]) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged.slice(0, 120);
}

export function App() {
  // Navigation
  const [activeTab, setActiveTab] = useState<string>('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [showIntro, setShowIntro] = useState<boolean>(false);

  const [snowEnabled, setSnowEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('npt_noel_snow');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const handleToggleSnow = React.useCallback(() => {
    setSnowEnabled(prev => {
      const next = !prev;
      try {
        localStorage.setItem('npt_noel_snow', String(next));
      } catch {}
      return next;
    });
  }, []);

  const [soundMuted, setSoundMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('npt_sound_muted') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleSound = React.useCallback(() => {
    setSoundMuted(prev => {
      const next = !prev;
      try {
        localStorage.setItem('npt_sound_muted', String(next));
      } catch {}
      showToast(next ? '🔇 Đã tắt âm thanh' : '🔊 Đã bật âm thanh', 'info');
      return next;
    });
  }, []);


  // Global hotkeys (ESC to close modals)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedProduct(null);
        setSelectedBlog(null);
        setIsCartOpen(false);
        setIsCheckoutOpen(false);
        setIsAuthOpen(false);
        setIsAdminOpen(false);
        setIsCompareOpen(false);
        setIsWishlistOpen(false);
        setIsAboutOpen(false);
        setIsTributeOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleTabChange = React.useCallback((newTab: string) => {
    setActiveTab(newTab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Datasets state (With Offline LocalStorage Hydration and Seed Fallback for Netlify/Vercel)
  const [products, setProducts] = useState<Product[]>(() => normalizeLegacyAssets(PRODUCTS_DATA));
  const [auctions, setAuctions] = useState<AuctionItem[]>(() => normalizeLegacyAssets(AUCTION_ITEMS));
  const [orders, setOrders] = useState<Order[]>(() => {
    try {
      const saved = localStorage.getItem('npt_orders');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return normalizeLegacyAssets(parsed);
      }
    } catch {}
    return normalizeLegacyAssets(INITIAL_ORDERS);
  });
  const [warranties, setWarranties] = useState<WarrantyTicket[]>([]);
  const [latestPurchaseNotification, setLatestPurchaseNotification] = useState<Order | null>(null);
  const productsRef = React.useRef<Product[]>(products);
  productsRef.current = products;
  const knownOrderIdsRef = React.useRef<Set<string>>(new Set(orders.map(o => o.id)));
  const initialOrdersSyncedRef = React.useRef<boolean>(false);

  // Dynamic Live Server Sync Effect
  React.useEffect(() => {
    let isMounted = true;
    const fetchServerData = async () => {
      try {
        const [serverProducts, serverAuctions, serverOrders] = await Promise.all([
          api.getProducts(),
          api.getAuctions(),
          api.getOrders()
        ]);
        if (!isMounted) return;
        if (serverProducts && serverProducts.length > 0) {
          setProducts(serverProducts);
        }
        if (serverAuctions && serverAuctions.length > 0) {
          setAuctions(serverAuctions);
        }
        if (serverOrders && serverOrders.length > 0) {
          serverOrders.forEach(o => knownOrderIdsRef.current.add(o.id));
          setOrders(prev => mergeOrdersUnique(prev, serverOrders));
        }
      } catch (err) {
        console.warn('Live API sync fallback to local datasets:', err);
      }
    };
    fetchServerData();
    return () => { isMounted = false; };
  }, []);

  // Real-time Order synchronization with Firestore & Live Server
  useEffect(() => {
    const unsub = subscribeToOrdersLive((liveOrders) => {
      if (liveOrders && liveOrders.length > 0) {
        if (initialOrdersSyncedRef.current) {
          const newestIncoming = liveOrders.find(o => !knownOrderIdsRef.current.has(o.id));
          if (newestIncoming) {
            setLatestPurchaseNotification(newestIncoming);
          }
        } else {
          initialOrdersSyncedRef.current = true;
        }
        liveOrders.forEach(o => knownOrderIdsRef.current.add(o.id));
        setOrders(prev => mergeOrdersUnique(liveOrders, prev));
      }
    });
    return () => unsub();
  }, []);

  // Real-time 30-second incoming order & revenue ticker (30s 1 đơn)
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('npt_realtime_orders');
        channel.onmessage = (event) => {
          const incoming = event.data as Order | undefined;
          if (incoming && incoming.id && !knownOrderIdsRef.current.has(incoming.id)) {
            knownOrderIdsRef.current.add(incoming.id);
            setOrders(prev => mergeOrdersUnique([incoming], prev));
            setLatestPurchaseNotification(incoming);
          }
        };
      }
    } catch {}

    const triggerNewOrder = () => {
      const now = Date.now();
      try {
        const lastTs = Number(localStorage.getItem('npt_last_auto_order_ts') || '0');
        // Prevent duplicate ticks when multiple tabs are open simultaneously
        if (now - lastTs < 28000) return;
        localStorage.setItem('npt_last_auto_order_ts', String(now));
      } catch {}

      const newOrder = createRealtimeIncomingOrder(productsRef.current);
      knownOrderIdsRef.current.add(newOrder.id);
      setOrders(prev => mergeOrdersUnique([newOrder], prev));
      setLatestPurchaseNotification(newOrder);

      try {
        channel?.postMessage(newOrder);
      } catch {}
    };

    const intervalId = setInterval(triggerNewOrder, 30000);

    return () => {
      clearInterval(intervalId);
      try {
        channel?.close();
      } catch {}
    };
  }, []);

  // Modals state
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedBlog, setSelectedBlog] = useState<BlogPost | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState<boolean>(() => {
    try {
      localStorage.removeItem('npt_admin_auth');
      return sessionStorage.getItem('npt_admin_auth') === 'true';
    } catch {
      return false;
    }
  });

  const handleSetAdminAuthenticated = (val: boolean) => {
    setIsAdminAuthenticated(val);
    try {
      sessionStorage.setItem('npt_admin_auth', String(val));
      localStorage.removeItem('npt_admin_auth');
    } catch {}
  };

  const handleDeleteOrder = async (orderId: string) => {
    deleteOrderLive(orderId).catch(() => {});
    try {
      await api.deleteOrder(orderId);
      setOrders(prev => prev.filter(o => o.id !== orderId));
      showToast(`🗑️ Đã xóa vĩnh viễn đơn hàng #${orderId}`, 'success');
    } catch {
      setOrders(prev => prev.filter(o => o.id !== orderId));
      showToast(`🗑️ Đã xóa đơn hàng #${orderId}`, 'success');
    }
  };

  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [isWishlistOpen, setIsWishlistOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isTributeOpen, setIsTributeOpen] = useState(false);
  const [compareList, setCompareList] = useState<Product[]>([]);

  const handleAddToCompare = (product: Product, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (compareList.some(p => p.id === product.id)) {
      showToast(`⚠️ Sản phẩm [${product.name}] đã có trong danh sách so sánh!`, 'info');
      setIsCompareOpen(true);
      return;
    }
    if (compareList.length >= 3) {
      showToast('⚠️ Chỉ có thể so sánh tối đa 3 sản phẩm cùng lúc!', 'error');
      setIsCompareOpen(true);
      return;
    }
    setCompareList(prev => [...prev, product]);
    showToast(`⚖️ Đã thêm [${product.name}] vào So Sánh!`, 'success');
  };

  // Wishlist state (Hydrated & Persisted)
  const [wishlistIds, setWishlistIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('npt_wishlist_ids');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const handleToggleFavorite = (product: Product, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setWishlistIds(prev => {
      const exists = prev.includes(product.id);
      if (exists) {
        showToast(`💔 Đã bỏ [${product.name}] khỏi Yêu Thích`, 'info');
        return prev.filter(id => id !== product.id);
      } else {
        showToast(`❤️ Đã thêm [${product.name}] vào Yêu Thích!`, 'success');
        return [...prev, product.id];
      }
    });
  };

  // User state (Hydrated & Persisted)
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('npt_current_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Checkout coupon state
  const [checkoutCoupon, setCheckoutCoupon] = useState<Coupon | undefined>(undefined);

  // Cart state (Hydrated & Persisted)
  const [cartItems, setCartItems] = useState<CartItem[]>(() => {
    try {
      const saved = localStorage.getItem('npt_cart_items');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Automatic Offline Synchronization Effects
  React.useEffect(() => {
    try {
      localStorage.setItem('npt_orders', JSON.stringify(orders));
    } catch (e) {
      console.warn('Failed to persist orders', e);
    }
  }, [orders]);

  React.useEffect(() => {
    try {
      localStorage.setItem('npt_cart_items', JSON.stringify(cartItems));
    } catch (e) {
      console.warn('Failed to persist cart', e);
    }
  }, [cartItems]);

  React.useEffect(() => {
    try {
      localStorage.setItem('npt_wishlist_ids', JSON.stringify(wishlistIds));
    } catch (e) {
      console.warn('Failed to persist wishlist', e);
    }
  }, [wishlistIds]);

  React.useEffect(() => {
    try {
      if (currentUser) {
        localStorage.setItem('npt_current_user', JSON.stringify(currentUser));
      } else {
        localStorage.removeItem('npt_current_user');
      }
    } catch (e) {
      console.warn('Failed to persist user', e);
    }
  }, [currentUser]);

  // Synchronize with Firebase Auth session automatically
  React.useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (fbUser) => {
      if (fbUser) {
        try {
          if (!localStorage.getItem('npt_customer_login_at')) {
            const signInTs = fbUser.metadata?.lastSignInTime ? Date.parse(fbUser.metadata.lastSignInTime) : Date.now();
            localStorage.setItem('npt_customer_login_at', String(Number.isFinite(signInTs) ? signInTs : Date.now()));
          }
        } catch {}
        setCurrentUser(prev => {
          if (prev && prev.id === fbUser.uid) return prev;
          return {
            id: fbUser.uid,
            name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Collector Rider',
            email: fbUser.email || '',
            avatar: fbUser.photoURL || undefined,
            phone: fbUser.phoneNumber || undefined,
            role: fbUser.email?.includes('admin') ? 'admin' : 'user',
            riderPoints: prev?.riderPoints ?? 100,
            tierRank: prev?.tierRank ?? 'Novice Rider',
            referralCode: 'RIDER-' + fbUser.uid.substring(0, 5).toUpperCase(),
            wishlist: prev?.wishlist ?? []
          };
        });
      }
    });
    return () => unsubscribe();
  }, []);

  // Toast System - quiet notification without top-right visual popup
  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    console.log(`[Notification ${type}]:`, msg);
  };

  // Dedicated Customer Account Logout (keeps Admin session intact if Admin is logged in)
  const handleLogoutCustomer = React.useCallback(() => {
    setCurrentUser(null);
    try {
      localStorage.removeItem('npt_current_user');
      localStorage.removeItem('npt_customer_login_at');
    } catch {}
    signOutFirebase().catch(() => {});
    showToast('👋 Đã đăng xuất tài khoản khách hàng!', 'info');
  }, []);

  // Listen for remote Admin force-logout on active customer account across Vercel
  React.useEffect(() => {
    if (!currentUser?.id && !currentUser?.email) return;
    const unsub = subscribeToCustomerForceLogout(currentUser.id, currentUser.email, () => {
      handleLogoutCustomer();
    });
    return () => unsub();
  }, [currentUser?.id, currentUser?.email, handleLogoutCustomer]);

  // =========================================================================
  // REAL-TIME PUBLIC IP & CROSS-DEVICE BAN ENFORCEMENT (VERCEL + FULLSTACK)
  // =========================================================================
  const [clientRealIp, setClientRealIp] = useState<string>('');
  const [bannedIpRecords, setBannedIpRecords] = useState<BannedIpRecord[]>([]);
  const [customerBanState, setCustomerBanState] = useState<{ blocked: boolean; reason?: string }>({ blocked: false });

  useEffect(() => {
    let active = true;
    const refreshClientIp = () => {
      getRealClientPublicIp(true).then((ip) => {
        if (active && ip) setClientRealIp(ip);
      });
    };
    refreshClientIp();
    const timer = setInterval(refreshClientIp, 60000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const unsub = subscribeToBannedIpsRealtime((records) => {
      setBannedIpRecords(records);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!currentUser?.id && !currentUser?.email) {
      setCustomerBanState({ blocked: false });
      return;
    }
    const unsub = subscribeToCustomerBanStatus(currentUser.id, currentUser.email, (blocked, reason) => {
      setCustomerBanState({ blocked, reason });
    });
    return () => unsub();
  }, [currentUser?.id, currentUser?.email]);

  useEffect(() => {
    if (!currentUser?.id || !clientRealIp) return;
    updateCustomerIpPresenceCloud(currentUser.id, currentUser.email || '', clientRealIp).catch(() => {});
  }, [currentUser?.id, currentUser?.email, clientRealIp]);

  const matchedIpBan = React.useMemo(
    () => (clientRealIp ? bannedIpRecords.find((r) => r.ip === clientRealIp) : undefined),
    [clientRealIp, bannedIpRecords]
  );

  const isClientAccessBlocked = Boolean(
    !isAdminAuthenticated &&
      currentUser?.role !== 'admin' &&
      (matchedIpBan || customerBanState.blocked)
  );

  const activeBlockReason =
    matchedIpBan?.reason ||
    customerBanState.reason ||
    'Địa chỉ IP hoặc tài khoản của bạn đã bị Quản Lý chặn truy cập hệ thống.';

  useEffect(() => {
    if (isClientAccessBlocked && currentUser && currentUser.role !== 'admin') {
      handleLogoutCustomer();
    }
  }, [isClientAccessBlocked, currentUser, handleLogoutCustomer]);

  // Cart Actions
  const handleAddToCart = (product: Product, param2?: React.MouseEvent | number) => {
    if (!currentUser) {
      showToast('⚠️ Đăng nhập nhanh để chốt đơn và tích điểm Rider nhé sếp!', 'info');
      setIsAuthOpen(true);
      return;
    }

    let quantityToAdd = 1;
    if (typeof param2 === 'number') {
      quantityToAdd = param2;
    } else if (param2 && typeof param2 === 'object' && 'stopPropagation' in param2) {
      param2.stopPropagation();
    }

    setCartItems(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + quantityToAdd } : item
        );
      }
      return [...prev, { product, quantity: quantityToAdd }];
    });

    showToast(`🛒 Đã chốt [${product.name}] vào giỏ! Tiếp tục săn hàng nào ⚡`, 'success');
    setIsCartOpen(true);
  };

  const handleBuyNow = (product: Product, param2?: React.MouseEvent | number) => {
    if (!currentUser) {
      showToast('⚠️ Đăng nhập nhanh để chốt đơn và tích điểm Rider nhé sếp!', 'info');
      setIsAuthOpen(true);
      return;
    }

    let quantityToAdd = 1;
    if (typeof param2 === 'number') {
      quantityToAdd = param2;
    } else if (param2 && typeof param2 === 'object' && 'stopPropagation' in param2) {
      param2.stopPropagation();
    }

    setCartItems(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + quantityToAdd } : item
        );
      }
      return [...prev, { product, quantity: quantityToAdd }];
    });

    showToast(`⚡ Chốt đơn ngay [${product.name}] - Test hàng kỹ trước khi giao!`, 'success');
    setSelectedProduct(null);
    setIsCartOpen(false);
    setIsCheckoutOpen(true);
  };

  const handleUpdateCartQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      setCartItems(prev => prev.filter(item => item.product.id !== productId));
      return;
    }
    setCartItems(prev =>
      prev.map(item => (item.product.id === productId ? { ...item, quantity } : item))
    );
  };

  const handleRemoveFromCart = (productId: string) => {
    setCartItems(prev => prev.filter(item => item.product.id !== productId));
  };

  const handleCreateOrder = async (order: Order) => {
    knownOrderIdsRef.current.add(order.id);
    setLatestPurchaseNotification(order);
    try {
      saveOrderLive(order);
      const serverOrder = await api.createOrder(order);
      knownOrderIdsRef.current.add(serverOrder.id);
      setOrders(prev => mergeOrdersUnique([serverOrder], prev));
      // Auto refresh products to reflect updated stock on live store
      api.getProducts().then(prods => {
        if (prods && prods.length > 0) setProducts(prods);
      }).catch(() => {});
    } catch {
      setOrders(prev => mergeOrdersUnique([order], prev));
    }
    setCartItems([]);
    showToast(`🎉 Chốt đơn #${order.id} thành công! Team NPT đang đóng gói hàng chuẩn Bandai 🚀`, 'success');
  };

  // Filtered products for search
  const searchedProducts = searchQuery.trim()
    ? products.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()) || p.series.toLowerCase().includes(searchQuery.toLowerCase()))
    : [];

  if (isClientAccessBlocked) {
    return (
      <div className="min-h-screen bg-[#050814] text-[#F5F2EB] flex items-center justify-center p-4 relative overflow-hidden">
        <div className="pointer-events-none fixed -top-40 -left-40 w-96 h-96 bg-rose-600/20 rounded-full blur-[140px]"></div>
        <div className="pointer-events-none fixed -bottom-40 -right-40 w-96 h-96 bg-cyan-500/15 rounded-full blur-[140px]"></div>

        <div className="relative z-10 w-full max-w-lg bg-[#0c1222] border-2 border-rose-500/60 rounded-3xl p-6 sm:p-8 shadow-[0_0_60px_rgba(244,63,94,0.3)] space-y-6 text-center">
          <div className="w-20 h-20 rounded-2xl bg-rose-600/20 border-2 border-rose-500/60 mx-auto flex items-center justify-center text-3xl text-rose-400 shadow-lg shadow-rose-600/20">
            <i className="fa-solid fa-ban"></i>
          </div>

          <div className="space-y-2">
            <span className="inline-block px-3 py-1 rounded-full bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[11px] font-black uppercase tracking-widest">
              Truy Cập Bị Từ Chối • IP Blocked
            </span>
            <h1 className="font-serif-title text-2xl sm:text-3xl font-black text-white uppercase">
              Thiết Bị / IP Đã Bị <span className="text-rose-400">Chặn Truy Cập</span>
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              Quản trị viên NPTTEAMSTORE đã khóa quyền truy cập đối với kết nối hiện tại. Mọi thao tác xem hàng, đặt đơn, live stream và bình luận đều bị vô hiệu hóa.
            </p>
          </div>

          <div className="bg-[#070b16] border border-rose-500/30 rounded-2xl p-4 text-left space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400 uppercase font-bold text-[10px]">Địa chỉ IP của bạn:</span>
              <span className="font-mono font-black text-rose-300 bg-rose-950/70 border border-rose-500/40 px-2.5 py-0.5 rounded-lg">
                {clientRealIp || matchedIpBan?.ip || 'Đang xác minh'}
              </span>
            </div>
            <div className="pt-2 border-t border-slate-800 space-y-1">
              <span className="text-slate-400 uppercase font-bold text-[10px] block">Lý do từ Quản Lý:</span>
              <p className="text-rose-200 font-semibold leading-relaxed">{activeBlockReason}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent text-[#F5F2EB] font-sans selection:bg-rose-500 selection:text-white relative">
      {/* Ambient Soft Lighting: Sâu thẳm, dịu mắt, tối ưu hiệu năng */}
      <div className="pointer-events-none fixed -top-40 -left-40 w-96 h-96 bg-cyan-500/10 rounded-full blur-[140px] z-0"></div>
      <div className="pointer-events-none fixed top-1/3 -right-40 w-96 h-96 bg-rose-600/10 rounded-full blur-[140px] z-0"></div>
      <div className="pointer-events-none fixed -bottom-40 left-1/3 w-96 h-96 bg-amber-500/10 rounded-full blur-[140px] z-0"></div>



      {/* Tokusatsu Henshin Intro Screen */}
      {showIntro && (
        <HenshinIntroOverlay onComplete={() => setShowIntro(false)} />
      )}


      {/* Global Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        cartCount={cartItems.reduce((sum, item) => sum + item.quantity, 0)}
        currentUser={currentUser}
        openCart={() => setIsCartOpen(true)}
        onOpenCart={() => setIsCartOpen(true)}
        openAuth={() => setIsAuthOpen(true)}
        onOpenAuth={() => setIsAuthOpen(true)}
        openAdmin={() => setIsAdminOpen(true)}
        onOpenAdmin={() => setIsAdminOpen(true)}
        openProfile={() => handleTabChange('dashboard')}
        onOpenProfile={() => handleTabChange('dashboard')}
        onLogout={handleLogoutCustomer}
        products={products}
        onSelectProduct={(p) => setSelectedProduct(p)}
        onOpenCompare={() => setIsCompareOpen(true)}
        compareCount={compareList.length}
        onOpenWishlist={() => setIsWishlistOpen(true)}
        wishlistCount={wishlistIds.length}
        onOpenAbout={() => setIsAboutOpen(true)}
        onOpenTribute={() => setIsTributeOpen(true)}
        soundMuted={soundMuted}
        onToggleSound={handleToggleSound}
        onReplayIntro={() => setShowIntro(true)}
        isAdminAuthenticated={isAdminAuthenticated}
      />



      {/* Search Result Overlay Page if Query Exists */}
      {searchQuery.trim() ? (
        <main className="flex-grow max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full space-y-6">
          <div className="flex justify-between items-center border-b border-[#2A2A2A] pb-4">
            <h2 className="font-serif-title text-xl sm:text-2xl font-bold">
              Kết Quả Tìm Kiếm CHO: <span className="gold-gradient-text">"{searchQuery}"</span>
            </h2>
            <button onClick={() => setSearchQuery('')} className="text-xs text-gray-400 hover:text-white underline">
              Xóa Tìm Kiếm
            </button>
          </div>

          {searchedProducts.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <i className="fa-solid fa-magnifying-glass text-3xl mb-2 block"></i>
              <p>Không tìm thấy sản phẩm Kamen Rider nào phù hợp với từ khóa này.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">
              {searchedProducts.map(p => (
                <ProductCard
                  key={p.id}
                  product={p}
                  onSelect={(p) => setSelectedProduct(p)}
                  onAddToCart={handleAddToCart}
                  onAddToCompare={handleAddToCompare}
                  isFavorite={wishlistIds.includes(p.id)}
                  onToggleFavorite={handleToggleFavorite}
                />
              ))}
            </div>
          )}
        </main>
      ) : (
        /* Dynamic Views Rendering based on activeTab */
        <main className="flex-grow w-full">
          {activeTab === 'home' && (
            <HomeView 
              products={products}
              blogs={BLOG_POSTS}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onAddToCart={handleAddToCart}
              setActiveTab={handleTabChange}
              showToast={showToast}
              wishlistIds={wishlistIds}
              onToggleFavorite={handleToggleFavorite}
              onAddToCompare={handleAddToCompare}
              onSelectBlog={(b) => {
                setSelectedBlog(b);
                handleTabChange('blog');
              }}
            />
          )}

          {activeTab === 'shop' && (
            <ShopView 
              products={products}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onAddToCart={handleAddToCart}
              onAddToCompare={handleAddToCompare}
              wishlistIds={wishlistIds}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {activeTab === 'livestream' && (
            <LiveStreamView 
              currentUser={currentUser}
              isAdminAuthenticated={isAdminAuthenticated}
              products={products}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onAddToCart={handleAddToCart}
              onBuyNow={(p) => {
                handleAddToCart(p);
                setIsCheckoutOpen(true);
              }}
              onCloseLive={() => handleTabChange('home')}
              onOpenAuth={() => setIsAuthOpen(true)}
            />
          )}

          {activeTab === 'tracker' && (
            <OrderTrackerView orders={orders} showToast={showToast} />
          )}

          {activeTab === 'about' && <AboutView />}

          {activeTab === 'blog' && (
            <BlogView 
              blogs={BLOG_POSTS} 
              selectedPost={selectedBlog} 
              onSelectPost={setSelectedBlog} 
            />
          )}

          {activeTab === 'promotions' && (
            <PromotionsView 
              coupons={PROMOTION_COUPONS}
              currentUser={currentUser}
              showToast={showToast}
            />
          )}

          {activeTab === 'warranty' && (
            <WarrantyView 
              onAddWarrantyTicket={(t) => setWarranties([t, ...warranties])}
              showToast={showToast}
            />
          )}

          {activeTab === 'auction' && (
            <AuctionView 
              auctions={auctions}
              currentUser={currentUser}
              onPlaceBid={async (id, amt, name) => {
                try {
                  const updated = await api.placeBid(id, amt, name);
                  setAuctions(prev => prev.map(a => a.id === id ? updated : a));
                } catch {
                  const item = auctions.find(a => a.id === id);
                  if (item) {
                    item.currentBid = amt;
                    item.highestBidder = name;
                  }
                }
              }}
              showToast={showToast}
            />
          )}

          {activeTab === 'collections' && (
            <CollectionsView 
              products={products}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onAddToCart={handleAddToCart}
              onAddToCompare={handleAddToCompare}
              wishlistIds={wishlistIds}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {activeTab === 'quiz' && (
            <RiderQuiz 
              products={products}
              onSelectProduct={(p) => setSelectedProduct(p)}
              showToast={showToast}
            />
          )}

          {activeTab === 'dashboard' && (
            <DashboardView 
              currentUser={currentUser}
              orders={orders}
              openAuth={() => setIsAuthOpen(true)}
              showToast={showToast}
            />
          )}

          {(activeTab === 'feedback' || activeTab === 'tribute' || activeTab === 'forum') && (
            <TributeFeedbackView 
              currentUser={currentUser}
              showToast={showToast}
              products={products}
              orders={orders}
              onSelectProduct={(p) => setSelectedProduct(p)}
              onOpenAuth={() => setIsAuthOpen(true)}
            />
          )}

          {activeTab === 'contact' && <ContactView showToast={showToast} />}
        </main>
      )}

      {/* Global Footer */}
      <Footer setActiveTab={handleTabChange} showToast={showToast} onOpenTribute={() => setIsTributeOpen(true)} />


      {/* Product Detail Modal */}
      <ProductDetailModal
        product={selectedProduct}
        isOpen={!!selectedProduct}
        onClose={() => setSelectedProduct(null)}
        onAddToCart={handleAddToCart}
        onBuyNow={handleBuyNow}
        showToast={showToast}
        isFavorite={selectedProduct ? wishlistIds.includes(selectedProduct.id) : false}
        onToggleFavorite={handleToggleFavorite}
        onAddToCompare={handleAddToCompare}
      />

      {/* Cart Drawer */}
      <CartDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        cartItems={cartItems}
        onUpdateQty={handleUpdateCartQuantity}
        onRemoveItem={handleRemoveFromCart}
        onOpenCheckout={(appliedCoupon) => {
          if (!currentUser) {
            showToast('⚠️ Vui lòng đăng nhập tài khoản để tiến hành thanh toán!', 'info');
            setIsAuthOpen(true);
            return;
          }
          setCheckoutCoupon(appliedCoupon);
          setIsCartOpen(false);
          setIsCheckoutOpen(true);
        }}
        coupons={PROMOTION_COUPONS}
      />

      {/* Checkout Modal */}
      <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setIsCheckoutOpen(false)}
        cartItems={cartItems}
        currentUser={currentUser}
        appliedCoupon={checkoutCoupon}
        onCompleteOrder={handleCreateOrder}
        showToast={showToast}
        openAuth={() => setIsAuthOpen(true)}
      />

      {/* Auth Modal (Bắt buộc đăng nhập/đăng ký khi chưa đăng nhập cả TK khách lẫn TK quản lý) */}
      <AuthModal
        isOpen={(!currentUser && !isAdminAuthenticated) || isAuthOpen}
        required={!currentUser && !isAdminAuthenticated}
        onClose={() => {
          if (currentUser || isAdminAuthenticated) setIsAuthOpen(false);
        }}
        onLoginSuccess={(user) => {
          try {
            localStorage.setItem('npt_customer_login_at', String(Date.now()));
          } catch {}
          setCurrentUser(user);
          setIsAuthOpen(false);
        }}
        showToast={showToast}
      />

      {/* Admin Management Modal */}
      <AdminModal
        isOpen={isAdminOpen}
        onClose={() => setIsAdminOpen(false)}
        products={products}
        orders={orders}
        warranties={warranties}
        coupons={PROMOTION_COUPONS}
        onAddProduct={async (p) => {
          try {
            const saved = await api.addProduct(p);
            setProducts(prev => [saved, ...prev]);
            showToast(`✅ Đã lưu sản phẩm mới lên máy chủ: ${saved.name}`, 'success');
          } catch {
            setProducts(prev => [p, ...prev]);
            showToast(`✅ Đã tạo sản phẩm: ${p.name}`, 'success');
          }
        }}
        onUpdateOrderStatus={async (orderId, status) => {
          updateOrderStatusLive(orderId, status).catch(() => {});
          try {
            const updated = await api.updateOrderStatus(orderId, status);
            setOrders(prev => prev.map(o => o.id === orderId ? updated : o));
          } catch {
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, status } : o));
          }
          showToast(`✅ Đã cập nhật trạng thái đơn #${orderId}: ${status}`, 'success');
        }}
        onDeleteOrder={handleDeleteOrder}
        isAdminAuthenticated={isAdminAuthenticated}
        setIsAdminAuthenticated={handleSetAdminAuthenticated}
        currentUser={currentUser}
        onLogoutCustomer={handleLogoutCustomer}
        showToast={showToast}
      />

      {/* Product Compare Matrix Modal */}
      <ProductCompareModal
        isOpen={isCompareOpen}
        onClose={() => setIsCompareOpen(false)}
        compareList={compareList}
        onRemoveFromCompare={(productId) => {
          setCompareList(prev => prev.filter(p => p.id !== productId));
          showToast('🗑️ Đã xóa sản phẩm khỏi danh sách so sánh', 'info');
        }}
        onAddToCart={(product) => {
          handleAddToCart(product);
          setIsCompareOpen(false);
        }}
      />

      {/* About & Biography Modal */}
      <AboutWebModal
        isOpen={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
      />

      {/* Wishlist Modal */}
      <WishlistModal
        isOpen={isWishlistOpen}
        onClose={() => setIsWishlistOpen(false)}
        wishlistProducts={products.filter(p => wishlistIds.includes(p.id))}
        onRemoveFromWishlist={(p, e) => handleToggleFavorite(p, e)}
        onAddToCart={(p, e) => {
          handleAddToCart(p, e);
        }}
        onSelectProduct={(p) => {
          setSelectedProduct(p);
          setIsWishlistOpen(false);
        }}
        onClearWishlist={() => {
          setWishlistIds([]);
          showToast('🗑️ Đã xóa toàn bộ sản phẩm khỏi Yêu Thích', 'info');
        }}
        showToast={showToast}
      />


      {/* Team NPT Tribute Modal */}
      <TeamTributeModal
        isOpen={isTributeOpen}
        onClose={() => setIsTributeOpen(false)}
        showToast={showToast}
      />

      {/* Thanh thông báo hiện khi có người mua (30s 1 đơn + đơn mới tức thì) */}
      <CommunityTicker latestOrder={latestPurchaseNotification} />

      {/* PWA Offline Connection Indicator & Toast */}
      <OfflineIndicator />

      {/* Christmas / Noel Holiday Falling Snowflakes (60fps Canvas, Toggleable) */}
      <ChristmasSnowEffect enabled={snowEnabled} />

      {/* Christmas / Noel Floating Holiday Corner Emote Decor */}
      <ChristmasCornerDecor />

      {/* Christmas / Noel Interactive Event Widget (Music, Snow, Voucher) */}
      <ChristmasEventWidget
        snowEnabled={snowEnabled}
        onToggleSnow={handleToggleSnow}
      />

      {/* Floating AI Robot Button (🤖 AI / Rider GPT) */}
      <CollectorSupportWidget
        onOpenProduct={(pId) => {
          const found = products.find(p => p.id === pId);
          if (found) setSelectedProduct(found);
        }}
        showToast={showToast}
      />
    </div>
  );
}

export default App;
