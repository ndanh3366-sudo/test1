import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  getFirestore, 
  initializeFirestore,
  doc, 
  getDoc, 
  setDoc, 
  deleteDoc,
  getDocFromServer,
  collection,
  onSnapshot,
  updateDoc,
  increment,
  getDocs,
  query,
  orderBy,
  limit
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import { User, CustomerFeedback, Order, TributeCustomer } from '../types.ts';
import { INITIAL_FEEDBACKS, CERTIFIED_TOP_CUSTOMERS } from '../data/feedbacks.ts';

const app = initializeApp(firebaseConfig);

const env = (import.meta as any).env || {};
const customAuthConfig =
  env.VITE_FIREBASE_AUTH_API_KEY &&
  env.VITE_FIREBASE_AUTH_DOMAIN &&
  env.VITE_FIREBASE_AUTH_PROJECT_ID
    ? {
        apiKey: String(env.VITE_FIREBASE_AUTH_API_KEY).trim(),
        authDomain: String(env.VITE_FIREBASE_AUTH_DOMAIN).trim(),
        projectId: String(env.VITE_FIREBASE_AUTH_PROJECT_ID).trim(),
        appId: String(env.VITE_FIREBASE_AUTH_APP_ID || firebaseConfig.appId).trim(),
      }
    : null;

const authApp = customAuthConfig ? initializeApp(customAuthConfig, 'custom-auth-app') : app;

let firestoreDb;
try {
  firestoreDb = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  }, firebaseConfig.firestoreDatabaseId);
} catch (e) {
  firestoreDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db = firestoreDb; /* CRITICAL: The app will break without this line */
export const auth = getAuth(authApp);
export const activeAuthProjectId = (customAuthConfig || firebaseConfig).projectId;
export const activeAuthDomain = (customAuthConfig || firebaseConfig).authDomain;
export const isCustomAuthProject = Boolean(customAuthConfig);
export const googleProvider = new GoogleAuthProvider();
export { onAuthStateChanged };

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test Firestore Connection as specified in skill guidelines
async function testConnection() {
  try {
    const connDoc = doc(db, 'test', 'connection');
    // Attach error handler to prevent unhandled 10s backend connection timeout errors
    const connPromise = getDocFromServer(connDoc).catch((err) => {
      console.warn("Firestore status: Client operating in offline mode or waiting for connection.", err?.message);
      return null;
    });
    const timeoutPromise = new Promise<null>((resolve) => 
      setTimeout(() => resolve(null), 2000)
    );
    await Promise.race([connPromise, timeoutPromise]);
    console.log('🔥 Firebase Firestore connection initialized safely');
  } catch (error: any) {
    console.warn("Firestore status: Client operating in offline mode or waiting for connection.");
  }
}
testConnection();

// Safe Promise timeout helper so no external network call hangs the login flow
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

export async function signInWithGoogle(): Promise<{ user: User; firebaseUser: FirebaseUser }> {
  try {
    // 1. Trigger Google Sign In Popup
    googleProvider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(auth, googleProvider);
    const fbUser = result.user;

    // 2. Resolve 100% real public IP & enforce Cloud/Backend IP + account ban check
    const { getRealClientPublicIp, checkClientBanStatusNow } = await import('../services/realtimeSync.ts');
    const clientIp = await getRealClientPublicIp(true);
    const banStatus = await checkClientBanStatusNow(clientIp, fbUser.uid, fbUser.email || '');
    if (banStatus.blocked) {
      await firebaseSignOut(auth).catch(() => {});
      throw new Error(`BLOCKED_IP:${banStatus.ip || clientIp}:${banStatus.reason || 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.'}`);
    }

    // 3. Fast check for existing profile in Firestore (1.5s max timeout to prevent hang)
    let riderPoints = 100;
    let tierRank: User['tierRank'] = 'Novice Rider';
    let role: User['role'] = fbUser.email?.includes('admin') ? 'admin' : 'user';

    try {
      const userDocRef = doc(db, 'users', fbUser.uid);
      const snap = await withTimeout(getDoc(userDocRef), 1500, null);
      if (snap && snap.exists()) {
        const data = snap.data();
        if (typeof data.riderPoints === 'number') riderPoints = data.riderPoints;
        if (data.tierRank) tierRank = data.tierRank;
        if (data.role) role = data.role;
      }
    } catch (err) {
      console.warn('Firestore user profile read timed out or skipped:', err);
    }

    // 4. Build application User model immediately
    const appUser: User = {
      id: fbUser.uid,
      name: fbUser.displayName || fbUser.email?.split('@')[0] || 'Collector Rider',
      email: fbUser.email || '',
      avatar: fbUser.photoURL || undefined,
      phone: fbUser.phoneNumber || undefined,
      role: role,
      riderPoints: riderPoints,
      tierRank: tierRank,
      referralCode: 'RIDER-' + fbUser.uid.substring(0, 5).toUpperCase(),
      wishlist: []
    };

    // 5. Asynchronously persist/update profile in Firestore (never blocks login return)
    try {
      const userDocRef = doc(db, 'users', fbUser.uid);
      setDoc(userDocRef, {
        uid: fbUser.uid,
        name: appUser.name,
        email: appUser.email,
        avatar: appUser.avatar || '',
        role: appUser.role,
        riderPoints: appUser.riderPoints,
        tierRank: appUser.tierRank,
        ...(clientIp ? { lastIp: clientIp } : {}),
        lastLoginAt: new Date().toISOString()
      }, { merge: true }).catch(err => {
        console.warn('Background Firestore profile save note:', err);
      });
    } catch (err) {
      console.warn('Firestore setDoc initiation note:', err);
    }

    return { user: appUser, firebaseUser: fbUser };
  } catch (error: any) {
    if (
      error?.code === 'auth/popup-closed-by-user' ||
      error?.code === 'auth/cancelled-popup-request' ||
      error?.message?.includes('popup-closed-by-user') ||
      error?.message?.includes('cancelled-popup-request')
    ) {
      console.log('Firebase Google Sign-In: Popup closed by user');
      throw new Error('USER_CANCELLED_POPUP');
    }
    console.error('Firebase Google Sign-In Error:', error);
    throw error;
  }
}

export async function loginWithGoogleAccountFallback(
  email: string,
  name?: string
): Promise<User> {
  const cleanEmail = email.trim().toLowerCase();
  const displayName = name?.trim() || cleanEmail.split('@')[0];
  const uid = 'goog_' + Math.abs(cleanEmail.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36);

  const { getRealClientPublicIp, checkClientBanStatusNow } = await import('../services/realtimeSync.ts');
  const clientIp = await getRealClientPublicIp(true);
  const banStatus = await checkClientBanStatusNow(clientIp, uid, cleanEmail);
  if (banStatus.blocked) {
    throw new Error(`BLOCKED_IP:${banStatus.ip || clientIp}:${banStatus.reason || 'Địa chỉ IP của bạn đã bị Quản Lý chặn truy cập.'}`);
  }

  let riderPoints = 150;
  let tierRank: User['tierRank'] = cleanEmail.includes('vip') ? 'CSM Master' : 'Novice Rider';
  let role: User['role'] = (cleanEmail.includes('admin') || cleanEmail === 'ndanh3366@gmail.com') ? 'admin' : 'user';

  try {
    const userDocRef = doc(db, 'users', uid);
    const snap = await withTimeout(getDoc(userDocRef), 1500, null);
    if (snap && snap.exists()) {
      const data = snap.data();
      if (typeof data.riderPoints === 'number') riderPoints = data.riderPoints;
      if (data.tierRank) tierRank = data.tierRank;
      if (data.role) role = data.role;
    }
  } catch {}

  const user: User = {
    id: uid,
    name: displayName,
    email: cleanEmail,
    avatar: '/brand/l01.png',
    role,
    riderPoints,
    tierRank,
    referralCode: 'RIDER-' + uid.slice(0, 5).toUpperCase(),
    wishlist: []
  };

  // Background sync to Firestore
  try {
    const userDocRef = doc(db, 'users', uid);
    setDoc(userDocRef, {
      uid,
      name: user.name,
      email: user.email,
      role: user.role,
      riderPoints: user.riderPoints,
      tierRank: user.tierRank,
      lastLoginAt: new Date().toISOString()
    }, { merge: true }).catch(() => {});
  } catch {}

  return user;
}

export async function signOutFirebase(): Promise<void> {
  try {
    await firebaseSignOut(auth);
  } catch (err) {
    console.warn('Firebase signout warning:', err);
  }
}

// =========================================================================
// REAL-TIME FEEDBACK SYNCHRONIZATION (FIRESTORE + REAL BACKEND)
// =========================================================================

// =========================================================================
// CUSTOMER FEEDBACKS & REVIEWS SYNCHRONIZATION
// =========================================================================

/**
 * Removes undefined fields from objects before saving to Firestore
 * to prevent 'Unsupported field value: undefined' errors
 */
function cleanFirestoreData<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      result[key] = value.filter(v => v !== undefined && v !== null);
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      result[key] = cleanFirestoreData(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function subscribeToFeedbacksLive(callback: (feedbacks: CustomerFeedback[]) => void): () => void {
  try {
    const feedbacksRef = collection(db, 'feedbacks');
    const unsub = onSnapshot(feedbacksRef, (snapshot) => {
      if (!snapshot.empty) {
        const loaded: CustomerFeedback[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          loaded.push({
            id: docSnap.id,
            customerName: data.customerName || 'Khách Hàng Rider',
            customerLocation: data.customerLocation || 'Việt Nam',
            customerAvatar: data.customerAvatar || '/icons/c01.png',
            rating: typeof data.rating === 'number' ? data.rating : 5,
            category: data.category || 'Chất lượng sản phẩm',
            productId: data.productId || undefined,
            productName: data.productName || undefined,
            productImage: data.productImage || undefined,
            comment: data.comment || '',
            images: Array.isArray(data.images) ? data.images : (data.images ? [data.images] : []),
            verifiedPurchase: data.verifiedPurchase ?? true,
            date: data.date || new Date().toLocaleDateString('vi-VN'),
            helpfulCount: typeof data.helpfulCount === 'number' ? data.helpfulCount : 0,
            userLiked: data.userLiked || false,
            adminReply: data.adminReply
          });
        });

        // Sort newest first
        loaded.sort((a, b) => b.id.localeCompare(a.id));
        callback(normalizeLegacyAssets(loaded));
      } else {
        // If Firestore feedbacks collection is empty, seed initial feedbacks safely
        INITIAL_FEEDBACKS.forEach((fb) => {
          const safeFb = cleanFirestoreData({
            ...fb,
            images: fb.images || []
          });
          setDoc(doc(db, 'feedbacks', fb.id), safeFb).catch(() => {});
        });
        callback(INITIAL_FEEDBACKS);
      }
    }, (error) => {
      console.warn('Feedbacks live subscription fallback:', error?.message);
    });

    return unsub;
  } catch (e) {
    console.warn('Could not initialize feedbacks live listener:', e);
    return () => {};
  }
}

export async function saveFeedbackLive(feedback: CustomerFeedback): Promise<void> {
  // Normalize payload and strip any undefined fields
  const safePayload = cleanFirestoreData({
    ...feedback,
    images: Array.isArray(feedback.images) ? feedback.images : (feedback.images ? [feedback.images] : []),
    productId: feedback.productId || '',
    productName: feedback.productName || '',
    productImage: feedback.productImage || '',
    syncedAt: new Date().toISOString()
  });

  // 1. Write to Firestore in real time
  try {
    const fbDoc = doc(db, 'feedbacks', feedback.id);
    await setDoc(fbDoc, safePayload, { merge: true });
  } catch (err) {
    console.warn('Firestore feedback write fallback:', err);
  }

  // 2. Also persist to backend API
  try {
    await fetch('/api/feedbacks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(safePayload)
    });
  } catch (err) {
    console.warn('API feedback write fallback:', err);
  }
}

export async function likeFeedbackLive(feedbackId: string): Promise<void> {
  try {
    const fbDoc = doc(db, 'feedbacks', feedbackId);
    await updateDoc(fbDoc, {
      helpfulCount: increment(1)
    });
  } catch (err) {
    console.warn('Firestore feedback like fallback:', err);
  }

  try {
    await fetch(`/api/feedbacks/${feedbackId}/like`, { method: 'POST' });
  } catch {}
}

// =========================================================================
// REAL-TIME ORDERS & HALL OF FAME CALCULATION (>= 20 SẢN PHẨM)
// =========================================================================

export function subscribeToOrdersLive(callback: (orders: Order[]) => void): () => void {
  try {
    const ordersRef = collection(db, 'orders');
    const unsub = onSnapshot(ordersRef, (snapshot) => {
      if (!snapshot.empty) {
        const loaded: Order[] = [];
        snapshot.forEach((docSnap) => {
          loaded.push(normalizeLegacyAssets({ id: docSnap.id, ...(docSnap.data() as any) }));
        });
        callback(loaded);
      }
    }, (error) => {
      console.warn('Orders live subscription fallback:', error?.message);
    });
    return unsub;
  } catch (e) {
    console.warn('Could not initialize orders live listener:', e);
    return () => {};
  }
}

export async function saveOrderLive(order: Order): Promise<void> {
  try {
    const orderDoc = doc(db, 'orders', order.id);
    const safeOrder = cleanFirestoreData({
      ...order,
      syncedAt: new Date().toISOString()
    });
    await setDoc(orderDoc, safeOrder, { merge: true });
  } catch (err) {
    console.warn('Firestore order write fallback:', err);
  }
}

export async function updateOrderStatusLive(orderId: string, status: Order['status']): Promise<void> {
  try {
    const orderDoc = doc(db, 'orders', orderId);
    await setDoc(orderDoc, { status, syncedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.warn('Firestore order status update fallback:', err);
  }
}

export async function deleteOrderLive(orderId: string): Promise<void> {
  try {
    const orderDoc = doc(db, 'orders', orderId);
    await deleteDoc(orderDoc);
  } catch (err) {
    console.warn('Firestore order delete fallback:', err);
  }
}

// Dynamic calculation of Hall of Fame based on real orders
// STRICT CONDITION: Only customers who have purchased >= 20 products are included
export function computeHallOfFameFromOrders(orders: Order[]): TributeCustomer[] {
  const customerMap: Record<string, {
    name: string;
    totalProducts: number;
    ordersCount: number;
    avatar?: string;
    location?: string;
    productsList: string[];
  }> = {};

  // Aggregate genuine orders
  for (const ord of orders) {
    if (!ord.customerName) continue;
    const name = ord.customerName.trim();
    if (!customerMap[name]) {
      customerMap[name] = {
        name,
        totalProducts: 0,
        ordersCount: 0,
        avatar: ord.customerAvatar,
        location: ord.shippingAddress ? ord.shippingAddress.split(',').pop()?.trim() : undefined,
        productsList: []
      };
    }

    const itemsCount = ord.items?.reduce((acc, it) => acc + (it.quantity || 1), 0) || 1;
    customerMap[name].totalProducts += itemsCount;
    customerMap[name].ordersCount += 1;
    if (ord.items) {
      for (const it of ord.items) {
        if (it.productName && !customerMap[name].productsList.includes(it.productName)) {
          customerMap[name].productsList.push(it.productName);
        }
      }
    }
  }

  // Combine with certified base customers
  const mergedCustomers: TributeCustomer[] = CERTIFIED_TOP_CUSTOMERS.map((cert) => {
    const extra = customerMap[cert.name] || { totalProducts: 0, ordersCount: 0, productsList: [] };
    const combinedProducts = cert.totalProductsPurchased + extra.totalProducts;
    const combinedOrders = cert.totalOrders + extra.ordersCount;
    const allProds = Array.from(new Set([...cert.featuredCollection, ...extra.productsList]));

    return {
      ...cert,
      totalProductsPurchased: combinedProducts,
      totalOrders: combinedOrders,
      featuredCollection: allProds.slice(0, 5)
    };
  });

  // Check if any other real customers reached 20+ products
  for (const [name, data] of Object.entries(customerMap)) {
    const alreadyIncluded = mergedCustomers.some(c => c.name.toLowerCase() === name.toLowerCase());
    if (!alreadyIncluded && data.totalProducts >= 20) {
      mergedCustomers.push({
        id: 'trib-dyn-' + Math.abs(name.split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(36),
        name: data.name,
        location: data.location || 'Việt Nam',
        avatar: data.avatar || '/icons/c01.png',
        title: 'Đại Sứ Sưu Tầm',
        tierBadge: 'Thành Viên Vinh Danh',
        totalProductsPurchased: data.totalProducts,
        totalOrders: data.ordersCount,
        memberSince: '2026',
        favoriteSeries: 'Kamen Rider Series',
        featuredCollection: data.productsList.slice(0, 5)
      });
    }
  }

  // CRITICAL FILTER: ONLY customers with >= 20 products purchased!
  const qualified = mergedCustomers.filter(c => (c.totalProductsPurchased || 0) >= 20);

  // Sort descending by total products
  qualified.sort((a, b) => b.totalProductsPurchased - a.totalProductsPurchased);

  // Assign ranking badges
  return qualified.map((c, idx) => ({
    ...c,
    tierBadge: idx === 0 
      ? 'Hạng 1 - Vương Miện Vàng' 
      : idx === 1 
      ? 'Hạng 2 - Vương Miện Bạc' 
      : idx === 2 
      ? 'Hạng 3 - Vương Miện Đồng' 
      : `Top Sưu Tầm #${idx + 1}`
  }));
}

export const LEGACY_ASSET_MAP: Record<string, string> = {
  "/Banner Slider Đầu Trang Chủ (Hero Banner Slider)/hiep-si-mat-na-gia-dinh-sieu-pham-fpt-play-1727665332423_Landscape.jpg": "/banners/b03.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats Surprise Mission Box 001 & DX Double Driver Raise Buckle Set 1.jpg": "/p/dx/d20.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats Surprise Mission Box 001 & DX Double Driver Raise Buckle Set 2.jpg": "/p/dx/d21.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats Surprise Mission Box 001 & DX Double Driver Raise Buckle Set 3.jpg": "/p/dx/d22.jpg",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOHUNTER - HYAKUJUU SENTAI GAORANGER 2.webp": "/p/ss/ss01.webp",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOHUNTER - HYAKUJUU SENTAI GAORANGER 3.webp": "/p/ss/ss02.webp",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOHUNTER - HYAKUJUU SENTAI GAORANGER.webp": "/p/ss/ss03.webp",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOKING - HYAKUJUU SENTAI GAORANGER 1.webp": "/p/ss/ss04.webp",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOKING - HYAKUJUU SENTAI GAORANGER 2.webp": "/p/ss/ss05.webp",
  "/Ảnh Sản Phẩm/super sentai/SHOKUGAN MODELING PROJECT SMP HYAKUJUU GATTAI GAOKING - HYAKUJUU SENTAI GAORANGER 3.webp": "/p/ss/ss06.webp",
  "/Bộ Sưu Tập Poster Dọc/MV5BNTczMDEzY2QtYzg0Zi00MjExLWJjNjMtODhmYTc2NDI3ZDA5XkEyXkFqcGc@._V1_FMjpg_UX1000_.jpg": "/posters/p05.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Command Twin Buckle & Raging Sword 1.jpg": "/p/wp/w22.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Command Twin Buckle & Raging Sword 2.jpg": "/p/wp/w23.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Command Twin Buckle & Raging Sword 3.jpg": "/p/wp/w24.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ghost Ore Damashii Heisei Generations Edition 1.jpg": "/p/shfp/sp19.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ghost Ore Damashii Heisei Generations Edition 2.jpg": "/p/shfp/sp20.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ghost Ore Damashii Heisei Generations Edition 3.jpg": "/p/shfp/sp21.jpg",
  "/Logo & Thương Hiệu (Brand Logo)/dreamina-2026-07-29-3008-A minimalist stencil-style logo of an oc....png": "/brand/l01.png",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Drive Type Speed Heisei Generations Edition 1.jpg": "/p/shfp/sp16.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Drive Type Speed Heisei Generations Edition 2.jpg": "/p/shfp/sp17.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Drive Type Speed Heisei Generations Edition 3.jpg": "/p/shfp/sp18.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Lion Vistamp Transformation Item from Japan 1.jpg": "/p/it/i19.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Lion Vistamp Transformation Item from Japan 2.jpg": "/p/it/i20.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Lion Vistamp Transformation Item from Japan 3.jpg": "/p/it/i21.jpg",
  "/Bộ Sưu Tập Poster Dọc/new-updated-poster-for-kamen-rider-gavv-with-a-certain-v0-yqn5a8urnjgd1.webp": "/posters/p15.webp",
  "/Bộ Sưu Tập Poster Dọc/kamen_rider_gavv_meet_kamen_rider_legend_poster_by_billaeu_di6bprr-pre.jpg": "/posters/p13.jpg",
  "/Ảnh Sản Phẩm/dx/Đai biến hình Kamen Rider Ichigo CSM Typhoon 50th Anniversary Bandai Japan 1.jpg": "/p/dx/d23.jpg",
  "/Ảnh Sản Phẩm/dx/Đai biến hình Kamen Rider Ichigo CSM Typhoon 50th Anniversary Bandai Japan 2.jpg": "/p/dx/d24.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Jackal Vistamp & Vistamp Bar from Japan 1.jpg": "/p/it/i16.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Jackal Vistamp & Vistamp Bar from Japan 2.jpg": "/p/it/i17.jpg",
  "/Ảnh Sản Phẩm/item/NEW Bandai Kamen Rider Revice DX Jackal Vistamp & Vistamp Bar from Japan 3.jpg": "/p/it/i18.jpg",
  "/Bộ Sưu Tập Poster Dọc/MV5BYjg2ODg1MzAtYmVhMi00ZjI1LWExMzMtNTMwMzg3OTlkZTI4XkEyXkFqcGc@._V1_.jpg": "/posters/p06.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats DX Drill & Propeller Raise Buckle Set 1.jpg": "/p/dx/d17.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats DX Drill & Propeller Raise Buckle Set 2.jpg": "/p/dx/d18.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider Geats DX Drill & Propeller Raise Buckle Set 3.jpg": "/p/dx/d19.jpg",
  "/Bộ Sưu Tập Poster Dọc/first-poster-for-kamen-rider-the-summer-movie-2024-v0-vjn6l4fwdqvc1.webp": "/posters/p08.webp",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Cross-Z Heisei Generations Edition 1.jpg": "/p/shfp/sp10.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Cross-Z Heisei Generations Edition 2.jpg": "/p/shfp/sp11.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Cross-Z Heisei Generations Edition 3.jpg": "/p/shfp/sp12.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Specter Heisei Generations Edition 1.jpg": "/p/shfp/sp31.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Specter Heisei Generations Edition 2.jpg": "/p/shfp/sp32.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Specter Heisei Generations Edition 3.jpg": "/p/shfp/sp33.jpg",
  "/Bộ Sưu Tập Poster Dọc/kamen-rider-gavv-v-cinema-suprise-for-hanto-fans-v0-6l7l29ykz5mf1.webp": "/posters/p12.webp",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Saber Brave Dragon Metallic Color Edition1.jpg": "/p/shf/f25.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Saber Brave Dragon Metallic Color Edition2.jpg": "/p/shf/f26.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Saber Brave Dragon Metallic Color Edition3.jpg": "/p/shf/f27.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-Zero & Ark Effect Parts Set 1.jpg": "/p/shfp/sp07.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-Zero & Ark Effect Parts Set 2.jpg": "/p/shfp/sp08.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-Zero & Ark Effect Parts Set 3.jpg": "/p/shfp/sp09.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Mach Heisei Generations Edition 1.jpg": "/p/shfp/sp28.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Mach Heisei Generations Edition 2.jpg": "/p/shfp/sp29.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Mach Heisei Generations Edition 3.jpg": "/p/shfp/sp30.jpg",
  "/Banner Slider Đầu Trang Chủ (Hero Banner Slider)/e094e508-ec72-4168-8a1d-e924fd323829.webp": "/banners/b02.webp",
  "/Bộ Sưu Tập Poster Dọc/brand-new-official-poster-for-gavvs-latest-arc-v0-tgav2jhk04te1.webp": "/posters/p07.webp",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider DX Chain Array & Claw Raise Buckle Set 1.jpg": "/p/dx/d14.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider DX Chain Array & Claw Raise Buckle Set 2.jpg": "/p/dx/d15.jpg",
  "/Ảnh Sản Phẩm/dx/Đồ chơi siêu nhân Kamen Rider DX Chain Array & Claw Raise Buckle Set 3.jpg": "/p/dx/d16.jpg",
  "/Ảnh Sản Phẩm/item/Hộp Mù Blokees Figures Kamen Rider All Stars 01 Beyond Generations 1.jpg": "/p/it/i01.jpg",
  "/Ảnh Sản Phẩm/item/Hộp Mù Blokees Figures Kamen Rider All Stars 01 Beyond Generations 2.jpg": "/p/it/i02.jpg",
  "/Ảnh Sản Phẩm/item/Hộp Mù Blokees Figures Kamen Rider All Stars 01 Beyond Generations 3.jpg": "/p/it/i03.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Aguilera Queen Bee Genome 1.jpg.webp": "/p/shfp/sp01.webp",
  "/Ảnh Sản Phẩm/vũ khí/BANDAI Kamen Rider Geats DX Magnum Shooter 40X Weapon from Japan 1.jpg": "/p/wp/w01.jpg",
  "/Ảnh Sản Phẩm/vũ khí/BANDAI Kamen Rider Geats DX Magnum Shooter 40X Weapon from Japan 2.jpg": "/p/wp/w02.jpg",
  "/Ảnh Sản Phẩm/vũ khí/BANDAI Kamen Rider Geats DX Magnum Shooter 40X Weapon from Japan 3.jpg": "/p/wp/w03.jpg",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/kamen_rider_knight_logo_by_driftingcar_dg73k3x-414w-2x.png": "/icons/c04.png",
  "/Ảnh Sản Phẩm/dx/Đồ chơi biến hình Kamen Rider Gotchard DX Legend Kamen Raiser2.jpg.jpg": "/p/dx/d13.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí biến hình Kamen Rider Gotchard DX Valvarusher 1.jpg": "/p/wp/w16.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí biến hình Kamen Rider Gotchard DX Valvarusher 2.jpg": "/p/wp/w17.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí biến hình Kamen Rider Gotchard DX Valvarusher 3.jpg": "/p/wp/w18.jpg",
  "/Ảnh Sản Phẩm/item/Thẻ bài Kamen Rider Gotchard Ride Chemy Trading Card Phase 01 1.jpg": "/p/it/i22.jpg",
  "/Ảnh Sản Phẩm/item/Thẻ bài Kamen Rider Gotchard Ride Chemy Trading Card Phase 01 2.jpg": "/p/it/i23.jpg",
  "/Ảnh Sản Phẩm/item/Thẻ bài Kamen Rider Gotchard Ride Chemy Trading Card Phase 01 3.jpg": "/p/it/i24.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Aguilera Queen Bee Genome 2.jpg": "/p/shfp/sp02.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Aguilera Queen Bee Genome 3.jpg": "/p/shfp/sp03.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Marblebreacookie Form1.jpg": "/p/shf/f01.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Marblebreacookie Form2.jpg": "/p/shf/f02.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Marblebreacookie Form3.jpg": "/p/shf/f03.jpg",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/kamen_rider_revice_logo_by_driftingcar_dghk15w-pre.png": "/icons/c05.png",
  "/Ảnh Sản Phẩm/item/Motor Nuclear Blind Box MNH-AA IM Great Hero - Đại Anh Hùng 1.jpg": "/p/it/i13.jpg",
  "/Ảnh Sản Phẩm/item/Motor Nuclear Blind Box MNH-AA IM Great Hero - Đại Anh Hùng 2.jpg": "/p/it/i14.jpg",
  "/Ảnh Sản Phẩm/item/Motor Nuclear Blind Box MNH-AA IM Great Hero - Đại Anh Hùng 3.jpg": "/p/it/i15.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX Legend Ride Magnum 1.jpg": "/p/wp/w13.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX Legend Ride Magnum 2.jpg": "/p/wp/w14.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX Legend Ride Magnum 3.jpg": "/p/wp/w15.jpg",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/kamen_rider_femme_logo_by_driftingcar_dg73lkh-pre.png": "/icons/c02.png",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/kamen_rider_saber_logo_by_driftingcar_dgh9vay-pre.png": "/icons/c06.png",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/kamen_rider_kiva_logo_by_driftingcar_dg7tj5z-pre.png": "/icons/c03.png",
  "/Sản Phẩm Đấu Giá Hoàng Gia/21272532_1434672139962663_2080887280343778585_n_3.webp": "/auction/a01.webp",
  "/Ảnh Sản Phẩm/dx/Đồ chơi biến hình Kamen Rider Gotchard DX Legend Kamen Raiser.jpg": "/p/dx/d12.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX EX Exgotchalibur 1.jpg": "/p/wp/w10.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX EX Exgotchalibur 2.jpg": "/p/wp/w11.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí Kamen Rider Gotchard DX EX Exgotchalibur 3.jpg": "/p/wp/w12.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Sparkingummy Form1.jpg": "/p/shf/f04.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Sparkingummy Form2.jpg": "/p/shf/f05.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Bitter Gavv Sparkingummy Form3.jpg": "/p/shf/f06.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Demons Spider Genome 1.jpg": "/p/shfp/sp13.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Demons Spider Genome 2.jpg": "/p/shfp/sp14.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Demons Spider Genome 3.jpg": "/p/shfp/sp15.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Beat Axe 1.jpg": "/p/wp/w19.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Beat Axe 2.jpg": "/p/wp/w20.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Đồ chơi vũ khí siêu nhân Kamen Rider Geats DX Beat Axe 3.jpg": "/p/wp/w21.jpg",
  "/Ảnh Sản Phẩm/dx/Super Best DX Sengoku Driver Kamen Rider Gaim & Baron Set 1.jpg": "/p/dx/d07.jpg",
  "/Ảnh Sản Phẩm/dx/Super Best DX Sengoku Driver Kamen Rider Gaim & Baron Set 2.jpg": "/p/dx/d08.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Legend Rider Capsem Sparkly Ver 03 1.jpg": "/p/it/i04.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Legend Rider Capsem Sparkly Ver 03 2.jpg": "/p/it/i05.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Legend Rider Capsem Sparkly Ver 03 3.jpg": "/p/it/i06.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jeanne Cobra Genome 1.jpg": "/p/shfp/sp25.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jeanne Cobra Genome 2.jpg": "/p/shfp/sp26.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jeanne Cobra Genome 3.jpg": "/p/shfp/sp27.jpg",
  "/BIỂU TƯỢNG DANH MỤC SẢN PHẨM/dlyjpm8-ea90294c-de09-4bc2-8718-6b49acbf082e.png": "/icons/c01.png",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Vice Lovekov Option Parts Set 1.jpg": "/p/shfp/sp34.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Vice Lovekov Option Parts Set 2.jpg": "/p/shfp/sp35.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Vice Lovekov Option Parts Set 3.jpg": "/p/shfp/sp36.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Amazingummy Form2.jpg.jpg": "/p/shf/f14.jpg",
  "/Ảnh Sản Phẩm/vũ khí/NEW Bandai Dx Kamen Rider Dawn Henshin Weapon Item 1.jpg": "/p/wp/w07.jpg",
  "/Ảnh Sản Phẩm/vũ khí/NEW Bandai Dx Kamen Rider Dawn Henshin Weapon Item 2.jpg": "/p/wp/w08.jpg",
  "/Ảnh Sản Phẩm/vũ khí/NEW Bandai Dx Kamen Rider Dawn Henshin Weapon Item 3.jpg": "/p/wp/w09.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Blizzardsorbet Form1.jpg": "/p/shf/f16.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Blizzardsorbet Form2.jpg": "/p/shf/f17.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Blizzardsorbet Form3.jpg": "/p/shf/f18.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jack Revice 3.jpg.jpg": "/p/shfp/sp24.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Durendal Ocean History1.jpg": "/p/shf/f07.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Durendal Ocean History2.jpg": "/p/shf/f08.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Durendal Ocean History3.jpg": "/p/shf/f09.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Espada Arabiana Night1.jpg": "/p/shf/f10.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Espada Arabiana Night2.jpg": "/p/shf/f11.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Espada Arabiana Night3.jpg": "/p/shf/f12.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Amazingummy Form1.jpg": "/p/shf/f13.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Amazingummy Form3.jpg": "/p/shf/f15.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Poppingummy Form1.jpg": "/p/shf/f22.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Poppingummy Form2.jpg": "/p/shf/f23.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Poppingummy Form3.jpg": "/p/shf/f24.jpg",
  "/Banner Slider Đầu Trang Chủ (Hero Banner Slider)/km3_20240206150553.jpg": "/banners/b04.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Rider Capsem Single Box 05 1.jpg": "/p/it/i07.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Rider Capsem Single Box 05 2.jpg": "/p/it/i08.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz DX Rider Capsem Single Box 05 3.jpg": "/p/it/i09.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Caking Form3.jpg.jpg": "/p/shf/f21.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jack Revice 1.jpg": "/p/shfp/sp22.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Jack Revice 2.jpg": "/p/shfp/sp23.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Kamen Rider Geats Zombie Breaker Weapon Japan 1.jpg": "/p/wp/w04.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Kamen Rider Geats Zombie Breaker Weapon Japan 2.jpg": "/p/wp/w05.jpg",
  "/Ảnh Sản Phẩm/vũ khí/Kamen Rider Geats Zombie Breaker Weapon Japan 3.jpg": "/p/wp/w06.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz Gear Series DX Zeztz License 1.jpg": "/p/it/i10.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz Gear Series DX Zeztz License 2.jpg": "/p/it/i11.jpg",
  "/Ảnh Sản Phẩm/item/Kamen Rider Zeztz Gear Series DX Zeztz License 3.jpg": "/p/it/i12.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Valen Chocodon Form1.jpg": "/p/shf/f28.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Valen Chocodon Form2.jpg": "/p/shf/f29.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Valen Chocodon Form3.jpg": "/p/shf/f30.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Vram Pudding Custom1.jpg": "/p/shf/f31.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Vram Pudding Custom2.jpg": "/p/shf/f32.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Vram Pudding Custom3.jpg": "/p/shf/f33.jpg",
  "/Banner Slider Đầu Trang Chủ (Hero Banner Slider)/KR_CSM_Banner.webp": "/banners/b01.webp",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Henshin Belt Lord Invoker1.jpg": "/p/dx/d01.jpg",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Henshin Belt Lord Invoker2.jpg": "/p/dx/d02.jpg",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Henshin Belt Lord Invoker3.jpg": "/p/dx/d03.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Caking Form1.jpg": "/p/shf/f19.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Gavv Caking Form2.jpg": "/p/shf/f20.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-One 1.jpg": "/p/shfp/sp04.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-One 2.jpg": "/p/shfp/sp05.jpg",
  "/Ảnh Sản Phẩm/shf premium/[Chính Hãng] SHF Kamen Rider Ark-One 3.jpg": "/p/shfp/sp06.jpg",
  "/Sản Phẩm Đấu Giá Hoàng Gia/DX Don Onitaijin Gold Mekki Version.jpg": "/auction/a02.jpg",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Ohkuwagata Ohger 1.webp": "/p/ss/ss16.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Ohkuwagata Ohger 2.webp": "/p/ss/ss17.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Ohkuwagata Ohger 3.webp": "/p/ss/ss18.webp",
  "/Tin Tức & Bài Viết Blog/thumb_hiep-si-mat-na-zeztz_4567685e.webp": "/blog/n03.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Spider Kumonos 1.webp": "/p/ss/ss19.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Spider Kumonos 2.webp": "/p/ss/ss20.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Spider Kumonos 3.webp": "/p/ss/ss21.webp",
  "/Tin Tức & Bài Viết Blog/tojima-wants-to-be-3840x2160-24455.jpg": "/blog/n04.jpg",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Rider Capsem Set 02 1.jpg": "/p/dx/d04.jpg",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Rider Capsem Set 02 2.jpg": "/p/dx/d05.jpg",
  "/Ảnh Sản Phẩm/dx/Kamen Rider Zeztz DX Rider Capsem Set 02 3.jpg": "/p/dx/d06.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Xross Saber1.jpg": "/p/shf/f34.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Xross Saber2.jpg": "/p/shf/f35.jpg",
  "/Ảnh Sản Phẩm/shf/[Chính Hãng] SHF Kamen Rider Xross Saber3.jpg": "/p/shf/f36.jpg",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Don Momotaro 1.webp": "/p/ss/ss07.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Don Momotaro 2.webp": "/p/ss/ss08.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Don Momotaro 3.webp": "/p/ss/ss09.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Kyoryu Red 1.webp": "/p/ss/ss13.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Kyoryu Red 2.webp": "/p/ss/ss14.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Kyoryu Red 3.webp": "/p/ss/ss15.webp",
  "/Bộ Sưu Tập Poster Dọc/new-gavv-poster-v0-48h4kp8apa8e1.webp": "/posters/p14.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Gozyuwolf 1.webp": "/p/ss/ss10.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Gozyuwolf 2.webp": "/p/ss/ss11.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Gozyuwolf 3.webp": "/p/ss/ss12.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Twokaizer 1.webp": "/p/ss/ss22.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Twokaizer 2.webp": "/p/ss/ss23.webp",
  "/Ảnh Sản Phẩm/super sentai/[Chính Hãng] SHF Twokaizer 3.webp": "/p/ss/ss24.webp",
  "/Tin Tức & Bài Viết Blog/zero-one-banner_20231208170759.jpg": "/blog/n05.jpg",
  "/Bộ Sưu Tập Poster Dọc/Kamen_Rider_Cross-Z_Poster.webp": "/posters/p03.webp",
  "/Bộ Sưu Tập Poster Dọc/Kamen_Rider_Gotchard_Poster.png": "/posters/p04.png",
  "/Logo & Thương Hiệu (Brand Logo)/npt_letter_logo.jpg": "/brand/npt-letter.jpg",
  "/Bộ Sưu Tập Poster Dọc/fty6-1iaqaewwjk_orig.jpg": "/posters/p09.jpg",
  "/Ảnh Showroom & Cửa Hàng/20240708_161850.jpg": "/store/s01.jpg",
  "/Ảnh Sản Phẩm/teamnpt/Nguyễn Thành Danh.jpg": "/p/team/t02.jpg",
  "/Ảnh Sản Phẩm/kamen rider/bitter gavv.webp": "/p/kr/k01.webp",
  "/Ảnh Sản Phẩm/teamnpt/Hoàng Trọng Hiệp.jpg": "/p/team/t01.jpg",
  "/Bộ Sưu Tập Poster Dọc/ss04s1mfe0bg1.jpeg": "/posters/p16.jpeg",
  "/Tin Tức & Bài Viết Blog/176948617660.jpg": "/blog/n01.jpg",
  "/Ảnh Sản Phẩm/dx/Zezts Item Set 03  3.jpg": "/p/dx/d09.jpg",
  "/Bộ Sưu Tập Poster Dọc/3yya7pw1zck91.jpg": "/posters/p01.jpg",
  "/Bộ Sưu Tập Poster Dọc/greaseposter.webp": "/posters/p10.webp",
  "/Ảnh Sản Phẩm/dx/Zezts Item Set 03 1.jpg": "/p/dx/d10.jpg",
  "/Ảnh Sản Phẩm/dx/Zezts Item Set 03 2.jpg": "/p/dx/d11.jpg",
  "/Ảnh Sản Phẩm/teamnpt/Vũ Tạ Hữu Luân.jpg": "/p/team/t04.jpg",
  "/Ảnh Sản Phẩm/kamen rider/gotchard.webp": "/p/kr/k03.webp",
  "/Ảnh Sản Phẩm/teamnpt/Vũ Thanh Bình.png": "/p/team/t03.png",
  "/Ảnh Sản Phẩm/teamnpt/Đoàn Tiến Đạt.jpg": "/p/team/t05.jpg",
  "/Ảnh Sản Phẩm/kamen rider/builfd.jpg": "/p/kr/k02.jpg",
  "/Bộ Sưu Tập Poster Dọc/DNvuIXb.webp": "/posters/p02.webp",
  "/Ảnh Sản Phẩm/kamen rider/kuuga.jpg": "/p/kr/k04.jpg",
  "/Tin Tức & Bài Viết Blog/hq720.jpg": "/blog/n02.jpg",
  "/Bộ Sưu Tập Poster Dọc/images.jpg": "/posters/p11.jpg"
};

const FALLBACK_ASSET_EXACT: Record<string, string> = {
  '/p/shf/f35.jpg': '/p/shf/f33.jpg',
  '/p/shf/f36.jpg': '/p/shf/f34.jpg',
  '/p/team/t01.jpg': '/assets/aistudio/Ho_ng_Tr_ng_Hi_p_97c66dbe.jpg',
  '/p/team/t02.jpg': '/assets/aistudio/Nguy_n_Th_nh_Danh_6a393100.jpg',
  '/p/team/t03.png': '/assets/aistudio/V__Thanh_B_nh_308c5bed.png',
  '/p/team/t04.jpg': '/assets/aistudio/V__T__H_u_Lu_n_c05e707c.jpg',
  '/p/team/t05.jpg': '/assets/aistudio/_o_n_Ti_n___t_6f6aba34.jpg',
  '/store/s01.jpg': '/banners/b04.jpg',
};

const POSTER_REPLACEMENTS = [
  '/p/kr/k01.webp',
  '/p/kr/k02.jpg',
  '/p/kr/k03.webp',
  '/p/kr/k04.jpg',
  '/banners/b01.webp',
  '/banners/b02.webp',
  '/banners/b03.jpg',
  '/banners/b04.jpg',
  '/blog/n01.jpg',
  '/blog/n02.jpg',
  '/blog/n03.webp',
  '/blog/n04.jpg',
  '/blog/n05.jpg',
  '/auction/a01.webp',
  '/auction/a02.jpg',
  '/brand/npt-letter.jpg',
];

const SENTAI_REPLACEMENTS = [
  '/auction/a02.jpg',
  '/p/shf/f07.jpg',
  '/p/shf/f08.jpg',
  '/auction/a01.webp',
  '/p/shf/f09.jpg',
  '/p/shf/f10.jpg',
];

function resolveMissingStaticPath(p: string): string {
  if (!p) return p;
  if (FALLBACK_ASSET_EXACT[p]) return FALLBACK_ASSET_EXACT[p];

  const shfpMatch = p.match(/^\/p\/shfp\/sp(\d+)\.(webp|jpe?g|png)$/i);
  if (shfpMatch) {
    const num = Math.max(1, parseInt(shfpMatch[1], 10));
    const mapped = ((num - 1) % 34) + 1;
    return `/p/shf/f${String(mapped).padStart(2, '0')}.jpg`;
  }

  const ssMatch = p.match(/^\/p\/ss\/ss(\d+)\.(webp|jpe?g|png)$/i);
  if (ssMatch) {
    const num = Math.max(1, parseInt(ssMatch[1], 10));
    if (num <= SENTAI_REPLACEMENTS.length) return SENTAI_REPLACEMENTS[num - 1];
    const mapped = ((num - 7 + 10) % 34) + 1;
    return `/p/shf/f${String(mapped).padStart(2, '0')}.jpg`;
  }

  const wpMatch = p.match(/^\/p\/wp\/w(\d+)\.(webp|jpe?g|png)$/i);
  if (wpMatch) {
    const num = Math.max(1, parseInt(wpMatch[1], 10));
    const mapped = ((num - 1) % 24) + 1;
    return `/p/it/i${String(mapped).padStart(2, '0')}.jpg`;
  }

  const posterMatch = p.match(/^\/posters\/p(\d+)\.(webp|jpe?g|png)$/i);
  if (posterMatch) {
    const num = Math.max(1, parseInt(posterMatch[1], 10));
    return POSTER_REPLACEMENTS[(num - 1) % POSTER_REPLACEMENTS.length];
  }

  return p;
}

export function normalizeAssetUrl(url: string): string {
  if (!url || typeof url !== "string") return url;
  if (LEGACY_ASSET_MAP[url]) return resolveMissingStaticPath(LEGACY_ASSET_MAP[url]);
  try {
    const decoded = decodeURI(url);
    if (LEGACY_ASSET_MAP[decoded]) return resolveMissingStaticPath(LEGACY_ASSET_MAP[decoded]);
  } catch {}
  return resolveMissingStaticPath(url);
}

export function normalizeLegacyAssets<T>(input: T): T {
  if (!input) return input;
  if (typeof input === "string") {
    return normalizeAssetUrl(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => normalizeLegacyAssets(item)) as unknown as T;
  }
  if (typeof input === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(input as Record<string, any>)) {
      out[k] = normalizeLegacyAssets(v);
    }
    return out as T;
  }
  return input;
}


