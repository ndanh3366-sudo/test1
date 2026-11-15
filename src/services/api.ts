import { Product, AuctionItem, Order, ForumPost, WarrantyTicket, Review, CustomerFeedback, TributeCustomer } from '../types.ts';
import { INITIAL_PRODUCTS } from '../data/products.ts';
import { INITIAL_AUCTIONS } from '../data/auctions.ts';
import { INITIAL_ORDERS } from '../data/orders.ts';
import { INITIAL_POSTS } from '../data/forumPosts.ts';
import { INITIAL_FEEDBACKS, CERTIFIED_TOP_CUSTOMERS } from '../data/feedbacks.ts';
import { INITIAL_COUPONS } from '../data/promotions.ts';
import { normalizeLegacyAssets } from '../utils/firebase.ts';
import { generateSmartLocalAnswer } from '../utils/aiResponder.ts';

let staticChatUnavailable = false;
let staticApiDetected = false;

async function safeJson<T = any>(res: Response): Promise<T | null> {
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('application/json')) {
    if (res.status === 404 || ct.includes('text/html')) {
      staticApiDetected = true;
    }
    return null;
  }
  return await res.json();
}

// Helper for instant catalog-aware AI Chat responses (active on static hosts / fallback)
function generateOfflineAiResponse(message: string, hasImage?: boolean): string {
  return generateSmartLocalAnswer(message, INITIAL_PRODUCTS, hasImage, INITIAL_AUCTIONS, INITIAL_COUPONS);
}

export const api = {
  // Store stats
  async getStats() {
    if (!staticApiDetected) {
      try {
        const res = await fetch('/api/stats');
        const data = await safeJson(res);
        if (data) return data;
      } catch {}
    }
    return {
      totalProducts: 50,
      totalOrders: 120,
      totalRevenue: 345000000,
      totalPosts: 35,
      activeAuctions: 2,
      status: 'cached'
    };
  },

  // Products
  async getProducts(params?: { category?: string; era?: string; search?: string }): Promise<Product[]> {
    try {
      if (!staticApiDetected) {
        const query = new URLSearchParams();
        if (params?.category) query.append('category', params.category);
        if (params?.era) query.append('era', params.era);
        if (params?.search) query.append('search', params.search);

        const res = await fetch(`/api/products?${query.toString()}`);
        const data = await safeJson(res);
        if (Array.isArray(data) && data.length > 0) return normalizeLegacyAssets(data);
      }
      throw new Error('Fallback to local products');
    } catch (e) {
      let filtered = normalizeLegacyAssets([...INITIAL_PRODUCTS]);
      if (params?.category && params.category !== 'all') {
        filtered = filtered.filter(p => p.category === params.category);
      }
      if (params?.era && params.era !== 'all') {
        filtered = filtered.filter(p => p.era === params.era);
      }
      if (params?.search) {
        const q = params.search.toLowerCase();
        filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || p.series.toLowerCase().includes(q));
      }
      return filtered;
    }
  },

  async addProduct(product: Product): Promise<Product> {
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(product)
      });
      if (res.ok) return await res.json();
    } catch {}
    return product;
  },

  async updateProduct(id: string, updates: Partial<Product>): Promise<Product> {
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) return await res.json();
    } catch {}
    const found = INITIAL_PRODUCTS.find(p => p.id === id) || ({} as Product);
    return { ...found, ...updates };
  },

  async deleteProduct(id: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/products/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) return true;
    } catch {}
    return true;
  },

  async addReview(productId: string, review: { userName: string; rating: number; comment: string; userAvatar?: string; images?: string[] }): Promise<{ review: Review; product: Product }> {
    const newReview: Review = {
      id: 'rev_' + Date.now(),
      userName: review.userName,
      userAvatar: review.userAvatar,
      rating: review.rating,
      comment: review.comment,
      images: Array.isArray(review.images) ? review.images : (review.images ? [review.images] : []),
      date: new Date().toLocaleDateString('vi-VN'),
      verifiedPurchase: true
    };
    try {
      const res = await fetch(`/api/products/${productId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...review,
          images: Array.isArray(review.images) ? review.images : (review.images ? [review.images] : [])
        })
      });
      if (res.ok) return await res.json();
    } catch {}
    const found = INITIAL_PRODUCTS.find(p => p.id === productId) || INITIAL_PRODUCTS[0];
    return { review: newReview, product: found };
  },

  // Auctions
  async getAuctions(): Promise<AuctionItem[]> {
    if (!staticApiDetected) {
      try {
        const res = await fetch('/api/auctions');
        const data = await safeJson(res);
        if (Array.isArray(data) && data.length > 0) return normalizeLegacyAssets(data);
      } catch {}
    }
    return INITIAL_AUCTIONS;
  },

  async placeBid(auctionId: string, amount: number, bidderName: string): Promise<AuctionItem> {
    if (!staticApiDetected) {
      try {
        const res = await fetch(`/api/auctions/${auctionId}/bid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, bidderName })
        });
        const data = await safeJson(res);
        if (data) return data;
      } catch {}
    }
    const item = INITIAL_AUCTIONS.find(a => a.id === auctionId) || INITIAL_AUCTIONS[0];
    const updated = {
      ...item,
      currentBid: amount,
      highestBidder: bidderName,
      bidCount: (item.bidCount || 0) + 1,
      bidHistory: [
        { bidderName, amount, time: 'Vừa xong' },
        ...(item.bidHistory || [])
      ]
    };
    return updated;
  },

  // Orders
  async getOrders(): Promise<Order[]> {
    if (!staticApiDetected) {
      try {
        const res = await fetch('/api/orders');
        const data = await safeJson(res);
        if (Array.isArray(data) && data.length > 0) return normalizeLegacyAssets(data);
      } catch {}
    }
    try {
      const saved = localStorage.getItem('npt_orders');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return normalizeLegacyAssets(parsed);
      }
    } catch {}
    return INITIAL_ORDERS;
  },

  async getOrder(query: string): Promise<Order | null> {
    const clean = query.trim().toLowerCase();
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(query.trim())}`);
      if (res.ok) return await res.json();
    } catch {}
    const orders = await this.getOrders();
    return orders.find(o => 
      o.id.toLowerCase() === clean || 
      o.customerPhone.toLowerCase().includes(clean) ||
      o.customerEmail.toLowerCase() === clean
    ) || null;
  },

  async createOrder(order: Order): Promise<Order> {
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });
      if (res.ok) return await res.json();
    } catch {}
    try {
      const saved = localStorage.getItem('npt_orders');
      const list: Order[] = saved ? JSON.parse(saved) : [...INITIAL_ORDERS];
      const updated = [order, ...list];
      localStorage.setItem('npt_orders', JSON.stringify(updated));
    } catch {}
    return order;
  },

  async updateOrderStatus(orderId: string, status: Order['status']): Promise<Order> {
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) return await res.json();
    } catch {}
    const orders = await this.getOrders();
    const target = orders.find(o => o.id === orderId) || orders[0];
    const updated = { ...target, status };
    try {
      const newList = orders.map(o => o.id === orderId ? updated : o);
      localStorage.setItem('npt_orders', JSON.stringify(newList));
    } catch {}
    return updated;
  },

  async deleteOrder(orderId: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: 'DELETE'
      });
      if (res.ok) return true;
    } catch {}
    try {
      const orders = await this.getOrders();
      const newList = orders.filter(o => o.id !== orderId);
      localStorage.setItem('npt_orders', JSON.stringify(newList));
    } catch {}
    return true;
  },

  // Admin & Customers Management
  async adminLogin(username: string, password: string) {
    if (!staticApiDetected) {
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await safeJson(res);
        if (data) return data;
      } catch {}
    }
    const norm = username.trim().toLowerCase();
    if (norm === 'nptteam' && password.trim() === 'nptteam12345') {
      return { success: true, message: 'Đăng nhập thành công', admin: { name: 'nptteam', role: 'admin' } };
    }
    throw new Error('Tài khoản hoặc mật khẩu không chính xác');
  },

  async getClientIp(): Promise<{ ip: string; isBlocked: boolean }> {
    try {
      const res = await fetch('/api/client/ip');
      if (res.ok) return await res.json();
    } catch {}
    return { ip: '127.0.0.1', isBlocked: false };
  },

  async getCustomers() {
    try {
      const res = await fetch('/api/admin/customers');
      if (res.ok) return await res.json();
    } catch {}
    try {
      const saved = localStorage.getItem('npt_customers_registry');
      const savedBanned = localStorage.getItem('npt_banned_ips');
      return {
        customers: saved ? JSON.parse(saved) : [],
        bannedIps: savedBanned ? JSON.parse(savedBanned) : []
      };
    } catch {}
    return { customers: [], bannedIps: [] };
  },

  async blockIp(ip: string, customerId?: string, reason?: string) {
    try {
      const res = await fetch('/api/admin/customers/block-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, customerId, reason })
      });
      if (res.ok) return await res.json();
    } catch {}
    return { success: true, ip, isBlocked: true };
  },

  async unblockIp(ip: string, customerId?: string) {
    try {
      const res = await fetch('/api/admin/customers/unblock-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, customerId })
      });
      if (res.ok) return await res.json();
    } catch {}
    return { success: true, ip, isBlocked: false };
  },

  async deleteCustomer(id: string) {
    try {
      const res = await fetch(`/api/admin/customers/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) return await res.json();
    } catch {}
    return { success: true };
  },

  // Forum
  async getForumPosts(): Promise<ForumPost[]> {
    try {
      const res = await fetch('/api/forum/posts');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) return normalizeLegacyAssets(data);
      }
    } catch {}
    try {
      const saved = localStorage.getItem('nptteamstore_community_posts_x_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return normalizeLegacyAssets(parsed);
      }
    } catch {}
    return INITIAL_POSTS;
  },

  async createForumPost(post: Partial<ForumPost>): Promise<ForumPost> {
    const fullPost: ForumPost = {
      id: post.id || ('fp_' + Date.now()),
      title: post.title || post.content?.slice(0, 60) || '',
      author: post.author || 'Rider Collector',
      handle: post.handle || '@rider_collector',
      authorAvatar: post.authorAvatar || '/icons/c01.png',
      authorBadge: post.authorBadge || 'VIP Collector',
      isVerified: post.isVerified ?? true,
      era: post.era || 'Reiwa',
      category: post.category || 'Khoe Bộ Sưu Tập',
      content: post.content || '',
      images: post.images,
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
      commentsCount: 0,
      commentsList: [],
      createdAt: 'Vừa xong'
    };
    try {
      const res = await fetch('/api/forum/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(post)
      });
      if (res.ok) return await res.json();
    } catch {}
    return fullPost;
  },

  async likeForumPost(postId: string): Promise<{ likesCount: number }> {
    try {
      const res = await fetch(`/api/forum/posts/${postId}/like`, {
        method: 'POST'
      });
      if (res.ok) return await res.json();
    } catch {}
    return { likesCount: 1 };
  },

  async addForumComment(postId: string, comment: { authorName: string; authorHandle?: string; authorAvatar?: string; content: string }): Promise<{ comment: any; post: ForumPost }> {
    const newComment = {
      id: 'c_' + Date.now(),
      author: comment.authorName,
      authorAvatar: comment.authorAvatar || '/icons/c01.png',
      content: comment.content,
      createdAt: 'Vừa xong'
    };
    try {
      const res = await fetch(`/api/forum/posts/${postId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(comment)
      });
      if (res.ok) return await res.json();
    } catch {}
    const posts = await this.getForumPosts();
    const found = posts.find(p => p.id === postId) || posts[0];
    const updatedPost = {
      ...found,
      commentsCount: (found.commentsCount || 0) + 1,
      commentsList: [...(found.commentsList || []), newComment]
    };
    return { comment: newComment, post: updatedPost };
  },

  // Customer Feedback & Reviews
  async getFeedbacks(): Promise<CustomerFeedback[]> {
    try {
      const res = await fetch('/api/feedbacks');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) return normalizeLegacyAssets(data);
      }
    } catch {}
    try {
      const saved = localStorage.getItem('nptteamstore_customer_feedbacks_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return normalizeLegacyAssets(parsed);
      }
    } catch {}
    return INITIAL_FEEDBACKS;
  },

  async createFeedback(fb: Partial<CustomerFeedback>): Promise<CustomerFeedback> {
    const newFeedback: CustomerFeedback = {
      id: fb.id || ('fb-' + Date.now()),
      customerName: fb.customerName || 'Khách Hàng Rider',
      customerLocation: fb.customerLocation || 'Việt Nam',
      customerAvatar: fb.customerAvatar || '/icons/c01.png',
      rating: fb.rating || 5,
      category: fb.category || 'Chất lượng sản phẩm',
      productId: fb.productId,
      productName: fb.productName,
      productImage: fb.productImage,
      comment: fb.comment || '',
      images: fb.images,
      verifiedPurchase: fb.verifiedPurchase ?? true,
      date: fb.date || new Date().toLocaleDateString('vi-VN'),
      helpfulCount: 0,
      userLiked: false,
      adminReply: fb.adminReply
    };

    try {
      const res = await fetch('/api/feedbacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newFeedback)
      });
      if (res.ok) {
        const data = await res.json();
        return data;
      }
    } catch {}

    try {
      const list = await this.getFeedbacks();
      const updated = [newFeedback, ...list];
      localStorage.setItem('nptteamstore_customer_feedbacks_v1', JSON.stringify(updated));
    } catch {}

    return newFeedback;
  },

  async likeFeedback(feedbackId: string): Promise<{ helpfulCount: number }> {
    try {
      const res = await fetch(`/api/feedbacks/${feedbackId}/like`, { method: 'POST' });
      if (res.ok) return await res.json();
    } catch {}
    return { helpfulCount: 1 };
  },

  // Hall of Fame - Customers with >= 20 products purchased (strictly filtered)
  async getTributeCustomers(): Promise<TributeCustomer[]> {
    try {
      const res = await fetch('/api/tribute/customers');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          // Strictly enforce >= 20 products purchased condition
          return data.filter((c: TributeCustomer) => (c.totalProductsPurchased || 0) >= 20);
        }
      }
    } catch {}
    return CERTIFIED_TOP_CUSTOMERS.filter(c => c.totalProductsPurchased >= 20);
  },

  // Warranties
  async registerWarranty(ticket: Partial<WarrantyTicket>): Promise<WarrantyTicket> {
    const fullTicket: WarrantyTicket = {
      id: ticket.id || ('WR-' + Math.floor(100000 + Math.random() * 900000)),
      customerName: ticket.customerName || 'Khách Hàng',
      customerPhone: ticket.customerPhone || '',
      customerEmail: ticket.customerEmail || '',
      orderCode: ticket.orderCode || 'NPT-ORD',
      productSerial: ticket.productSerial || 'BANDAI-JP-SERIAL',
      productName: ticket.productName || 'DX Henshin Belt Gavv',
      issueType: ticket.issueType || 'Khác',
      description: ticket.description || '',
      status: 'Đang tiếp nhận',
      createdAt: new Date().toLocaleDateString('vi-VN')
    };
    try {
      const res = await fetch('/api/warranties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ticket)
      });
      if (res.ok) return await res.json();
    } catch {}
    return fullTicket;
  },

  // AI Chat Assistant
  async chatWithAi(message: string, history?: any[], image?: { data: string; mimeType?: string }) {
    if (!staticChatUnavailable) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2800);
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, history, image }),
          signal: controller.signal
        });
        const contentType = res.headers.get('content-type') || '';
        if (res.status === 404 || res.status === 405 || !contentType.includes('application/json')) {
          staticChatUnavailable = true;
        } else if (res.ok) {
          const data = await res.json();
          if (data && data.reply) return data;
        }
      } catch {} finally {
        clearTimeout(timer);
      }
    }
    // Client-side instant catalog-aware AI inference fallback (0ms on Vercel / offline)
    const reply = generateOfflineAiResponse(message, Boolean(image));
    return { reply };
  }
};

