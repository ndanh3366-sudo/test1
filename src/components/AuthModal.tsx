import React, { useState, useEffect } from 'react';
import { User } from '../types.ts';
import {
  signInWithGoogle,
  loginWithGoogleAccountFallback,
  activeAuthProjectId,
  activeAuthDomain,
  isCustomAuthProject
} from '../utils/firebase.ts';
import { getRealClientPublicIp, registerOrUpdateCustomerCloud, checkClientBanStatusNow } from '../services/realtimeSync.ts';

interface AuthModalProps {
  isOpen: boolean;
  mode?: 'login' | 'register';
  required?: boolean;
  onClose: () => void;
  onLoginSuccess: (user: User) => void;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  mode = 'login',
  required = false,
  onClose,
  onLoginSuccess,
  showToast
}) => {
  const [tab, setTab] = useState<'login' | 'register' | 'forgot'>(mode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientIp, setClientIp] = useState<string>('Đang nhận diện...');
  const [isIpBlocked, setIsIpBlocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [unauthorizedDomain, setUnauthorizedDomain] = useState<string | null>(null);
  const [fallbackGoogleEmail, setFallbackGoogleEmail] = useState<string>('');
  const [showFallbackGoogle, setShowFallbackGoogle] = useState<boolean>(false);
  const [inlineStatus, setInlineStatus] = useState<{ type: 'error' | 'info' | 'success'; message: string } | null>(null);

  const formatBlockedMessage = (errMsg: string, fallbackIp: string) => {
    const parts = errMsg.split(':');
    const blockedIp = parts[1] || fallbackIp || clientIp;
    const reason = parts.slice(2).join(':') || 'Thiết bị hoặc địa chỉ IP này đã bị Quản Lý chặn truy cập.';
    return blockedIp && blockedIp !== 'Đang nhận diện...'
      ? `🚫 IP [${blockedIp}] đã bị Quản Lý chặn: ${reason}`
      : `🚫 Truy cập bị chặn: ${reason}`;
  };

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setTab(mode);
    setInlineStatus(null);
    setIsIpBlocked(false);

    (async () => {
      const ip = await getRealClientPublicIp(true);
      if (!active) return;
      setClientIp(ip || 'Không xác định');
      const ban = await checkClientBanStatusNow(ip);
      if (!active) return;
      if (ban.blocked) {
        setIsIpBlocked(true);
        setInlineStatus({
          type: 'error',
          message: `🚫 IP [${ban.ip || ip || 'hiện tại'}] đã bị Quản Lý chặn: ${ban.reason || 'Không được phép đăng nhập hoặc tạo tài khoản.'}`
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, mode]);

  if (!isOpen) return null;

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;

    if (isIpBlocked) {
      showToast('🚫 Địa chỉ IP của bạn đã bị Web Quản Lý chặn do vi phạm hoặc nghi vấn clone!', 'error');
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    const preBan = await checkClientBanStatusNow(undefined, undefined, cleanEmail);
    if (preBan.blocked) {
      const msg = `🚫 IP [${preBan.ip || clientIp}] hoặc tài khoản của bạn đã bị Quản Lý chặn: ${preBan.reason || 'Truy cập bị từ chối.'}`;
      setIsIpBlocked(true);
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
      return;
    }

    setIsSubmitting(true);

    try {
      if (tab === 'register') {
        const recorded = await registerOrUpdateCustomerCloud({
          name: name || email.split('@')[0],
          email,
          phone,
          role: 'user',
          riderPoints: 50,
          tierRank: 'Novice Rider'
        });

        const newUser: User = {
          id: recorded.id,
          name: recorded.name,
          email: recorded.email,
          phone: recorded.phone,
          role: 'user',
          riderPoints: 50,
          tierRank: 'Novice Rider',
          referralCode: 'RIDER-' + (recorded.id.slice(-5) || 'NEW').toUpperCase(),
          wishlist: []
        };

        onLoginSuccess(newUser);
        onClose();
        showToast(`🎉 Tạo tài khoản thành công! Dữ liệu & IP [${recorded.registeredIp || clientIp}] đã cập nhật Web Quản Lý.`, 'success');

      } else {
        const recorded = await registerOrUpdateCustomerCloud({
          name: name || email.split('@')[0],
          email,
          phone,
          role: email.includes('admin') ? 'admin' : 'user',
          riderPoints: 100,
          tierRank: 'Novice Rider'
        });

        const user: User = {
          id: recorded.id,
          name: recorded.name,
          email: recorded.email,
          phone: recorded.phone,
          role: recorded.role,
          riderPoints: recorded.riderPoints,
          tierRank: 'Novice Rider',
          referralCode: 'RIDER-' + (recorded.id.slice(-5) || 'NEW').toUpperCase(),
          wishlist: []
        };

        onLoginSuccess(user);
        onClose();
        showToast(`🎉 Chào mừng ${user.name} đã đăng nhập!`, 'success');
      }
    } catch (err: any) {
      const errMsg = String(err?.message || '');
      if (errMsg.startsWith('BLOCKED_IP:') || errMsg.startsWith('BLOCKED_ACCOUNT:')) {
        const msg = formatBlockedMessage(errMsg, clientIp);
        setIsIpBlocked(true);
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }

      // Network-only local fallback (only when NOT blocked)
      const recheck = await checkClientBanStatusNow(undefined, undefined, cleanEmail);
      if (recheck.blocked) {
        const msg = `🚫 IP [${recheck.ip || clientIp}] đã bị Quản Lý chặn!`;
        setIsIpBlocked(true);
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }

      const user: User = {
        id: 'u-' + Date.now(),
        name: name || email.split('@')[0] || 'Collector Rider',
        email: email,
        phone: phone,
        role: 'user',
        riderPoints: 50,
        tierRank: 'Novice Rider',
        referralCode: 'RIDER-NEW',
        wishlist: []
      };
      onLoginSuccess(user);
      onClose();
      showToast(`🎉 Đăng nhập thành công!`, 'success');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    if (isIpBlocked) {
      const msg = `🚫 Địa chỉ IP [${clientIp}] của bạn đã bị Web Quản Lý chặn!`;
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
      return;
    }

    setInlineStatus(null);
    setUnauthorizedDomain(null);
    setIsSubmitting(true);
    try {
      const { user } = await signInWithGoogle();

      // Sync customer profile with Real Public IP (rethrows BLOCKED_IP / BLOCKED_ACCOUNT immediately)
      await Promise.race([
        registerOrUpdateCustomerCloud({
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || '',
          role: user.role,
          riderPoints: user.riderPoints,
          tierRank: user.tierRank,
          avatar: user.avatar || ''
        }).catch((syncErr: any) => {
          const msg = String(syncErr?.message || '');
          if (msg.startsWith('BLOCKED_IP:') || msg.startsWith('BLOCKED_ACCOUNT:')) {
            throw syncErr;
          }
          return null;
        }),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);

      onLoginSuccess(user);
      onClose();
      showToast(`🎉 Đăng nhập Google thành công (${user.email})! Dữ liệu & IP đã đồng bộ lên Web Quản Lý.`, 'success');
    } catch (err: any) {
      const errCode = err?.code || '';
      const errMsg = String(err?.message || '');

      if (errMsg.startsWith('BLOCKED_IP:') || errMsg.startsWith('BLOCKED_ACCOUNT:')) {
        const msg = formatBlockedMessage(errMsg, clientIp);
        setIsIpBlocked(true);
        setShowFallbackGoogle(false);
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }

      if (
        errCode === 'auth/popup-closed-by-user' ||
        errCode === 'auth/cancelled-popup-request' ||
        errMsg === 'USER_CANCELLED_POPUP' ||
        errMsg.includes('popup-closed-by-user') ||
        errMsg.includes('cancelled-popup-request')
      ) {
        const msg = 'ℹ️ Bạn đã đóng cửa sổ đăng nhập Google. Vui lòng thử lại hoặc chọn đăng nhập nhanh bên dưới.';
        setInlineStatus({ type: 'info', message: msg });
        showToast(msg, 'info');
        return;
      }
      if (errCode === 'auth/popup-blocked') {
        setShowFallbackGoogle(true);
        const msg = '⚠️ Trình duyệt đang chặn cửa sổ popup Google. Hãy cho phép popup hoặc nhập Gmail bên dưới để vào ngay!';
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }
      if (
        errCode === 'auth/unauthorized-domain' ||
        errMsg.includes('unauthorized-domain')
      ) {
        setUnauthorizedDomain(window.location.hostname);
        setShowFallbackGoogle(true);
        const msg = `⚠️ Tên miền ${window.location.hostname} chưa nằm trong Authorized Domains của Firebase Project "${activeAuthProjectId}". Xem hướng dẫn bên dưới hoặc nhập Gmail để vào ngay!`;
        setInlineStatus({ type: 'info', message: msg });
        showToast(msg, 'info');
        return;
      }
      if (errCode === 'auth/operation-not-allowed') {
        setShowFallbackGoogle(true);
        const msg = `⚠️ Nhà cung cấp Google Sign-In chưa được bật trong Firebase Project "${activeAuthProjectId}". Bạn có thể bật trong Firebase Console hoặc nhập Gmail bên dưới!`;
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }
      console.error('Google Auth Error:', err);
      setShowFallbackGoogle(true);
      const msg = `❌ Lỗi đăng nhập Google (${errCode || 'unknown'}): ${errMsg || 'Thất bại'}`;
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFallbackGoogleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isIpBlocked) {
      const msg = `🚫 Địa chỉ IP [${clientIp}] của bạn đã bị Web Quản Lý chặn!`;
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
      return;
    }
    const clean = fallbackGoogleEmail.trim().toLowerCase();
    if (!clean || !clean.includes('@')) {
      const msg = '⚠️ Vui lòng nhập đúng định dạng địa chỉ Gmail (ví dụ: yourname@gmail.com)';
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
      return;
    }
    setInlineStatus(null);
    setIsSubmitting(true);
    try {
      const user = await loginWithGoogleAccountFallback(clean, clean.split('@')[0]);
      await Promise.race([
        registerOrUpdateCustomerCloud({
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || '',
          role: user.role,
          riderPoints: user.riderPoints,
          tierRank: user.tierRank,
          avatar: user.avatar || '/brand/l01.png'
        }).catch((syncErr: any) => {
          const msg = String(syncErr?.message || '');
          if (msg.startsWith('BLOCKED_IP:') || msg.startsWith('BLOCKED_ACCOUNT:')) {
            throw syncErr;
          }
          return null;
        }),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);
      onLoginSuccess(user);
      onClose();
      showToast(`🎉 Đăng nhập Google thành công (${user.email})! Dữ liệu & IP đã đồng bộ lên Web Quản Lý.`, 'success');
    } catch (e: any) {
      const errMsg = String(e?.message || '');
      if (errMsg.startsWith('BLOCKED_IP:') || errMsg.startsWith('BLOCKED_ACCOUNT:')) {
        const msg = formatBlockedMessage(errMsg, clientIp);
        setIsIpBlocked(true);
        setInlineStatus({ type: 'error', message: msg });
        showToast(msg, 'error');
        return;
      }
      const msg = `❌ Lỗi đăng nhập: ${errMsg || 'Thất bại'}`;
      setInlineStatus({ type: 'error', message: msg });
      showToast(msg, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-[#070B14]/92 backdrop-blur-xl">
      <div className="bg-[#101728] border border-cyan-500/40 rounded-3xl w-full max-w-md max-h-[92vh] overflow-y-auto p-6 relative shadow-2xl space-y-5 text-white ring-1 ring-cyan-400/20">
        {!required && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cửa sổ đăng nhập"
            className="absolute top-4 right-4 text-slate-400 hover:text-white cursor-pointer"
          >
            <i className="fa-solid fa-xmark text-base"></i>
          </button>
        )}

        {required && (
          <div className="bg-cyan-950/45 border border-cyan-500/30 rounded-xl p-3 text-center space-y-1">
            <p className="text-xs font-extrabold text-cyan-300 uppercase tracking-wide">
              Đăng Nhập / Đăng Ký Tài Khoản
            </p>
            <p className="text-[11px] text-slate-300">
              Vui lòng đăng nhập hoặc tạo tài khoản để tiếp tục truy cập cửa hàng.
            </p>
          </div>
        )}

        {/* Visible Inline Status / Error Banner */}
        {inlineStatus && (
          <div
            className={`rounded-xl p-3 text-xs font-medium border flex items-start gap-2 ${
              inlineStatus.type === 'error'
                ? 'bg-rose-950/70 border-rose-500/50 text-rose-200'
                : inlineStatus.type === 'success'
                ? 'bg-emerald-950/70 border-emerald-500/50 text-emerald-200'
                : 'bg-cyan-950/60 border-cyan-500/40 text-cyan-200'
            }`}
          >
            <i
              className={`fa-solid mt-0.5 shrink-0 ${
                inlineStatus.type === 'error'
                  ? 'fa-circle-exclamation text-rose-400'
                  : inlineStatus.type === 'success'
                  ? 'fa-circle-check text-emerald-400'
                  : 'fa-circle-info text-cyan-400'
              }`}
            ></i>
            <span className="leading-relaxed break-words">{inlineStatus.message}</span>
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-700 pb-3 gap-6 text-xs font-bold">
          <button 
            onClick={() => setTab('login')}
            className={`pb-1 transition cursor-pointer ${tab === 'login' ? 'text-cyan-400 border-b-2 border-cyan-400 font-black' : 'text-slate-400 hover:text-white'}`}
          >
            Đăng Nhập Khách
          </button>
          <button 
            onClick={() => setTab('register')}
            className={`pb-1 transition cursor-pointer ${tab === 'register' ? 'text-cyan-400 border-b-2 border-cyan-400 font-black' : 'text-slate-400 hover:text-white'}`}
          >
            Đăng Ký Tài Khoản Mới
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleLoginSubmit} className="space-y-3.5 text-xs">
          {tab === 'register' && (
            <>
              <div>
                <label className="block font-bold text-slate-300 uppercase text-[10px] mb-1">Họ và tên *</label>
                <input 
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ví dụ: Hoàng Long Rider..."
                  className="w-full bg-[#080d1a] border border-cyan-500/30 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-300 uppercase text-[10px] mb-1">Số điện thoại</label>
                <input 
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0912..."
                  className="w-full bg-[#080d1a] border border-cyan-500/30 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
            </>
          )}

          <div>
            <label className="block font-bold text-slate-300 uppercase text-[10px] mb-1">Email tài khoản *</label>
            <input 
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@vidu.com"
              className="w-full bg-[#080d1a] border border-cyan-500/30 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
            />
          </div>

          <div>
            <label className="block font-bold text-slate-300 uppercase text-[10px] mb-1">Mật khẩu *</label>
            <input 
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-[#080d1a] border border-cyan-500/30 rounded-xl px-3.5 py-2 text-xs text-white focus:outline-none focus:border-cyan-400"
            />
          </div>

          <button 
            type="submit"
            disabled={isSubmitting || isIpBlocked}
            className="w-full py-3 bg-gradient-to-r from-cyan-400 via-blue-500 to-indigo-600 text-black font-extrabold rounded-xl shadow-lg hover:brightness-110 transition cursor-pointer disabled:opacity-50"
          >
            {isSubmitting ? (
              <i className="fa-solid fa-spinner animate-spin"></i>
            ) : tab === 'login' ? (
              'Xác Nhận Đăng Nhập'
            ) : (
              'Tạo Tài Khoản & Gửi Dữ Liệu Về Quản Lý'
            )}
          </button>
        </form>

        {/* Social Auth Options */}
        <div className="space-y-3 pt-2 border-t border-slate-700 text-center">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider font-bold">Hoặc kết nối nhanh</p>
          <button 
            type="button"
            onClick={handleGoogleLogin}
            disabled={isSubmitting || isIpBlocked}
            className="w-full py-3 bg-[#080d1a] hover:bg-[#121c38] border border-cyan-500/50 hover:border-cyan-400 rounded-xl font-bold text-xs text-white flex items-center justify-center gap-2.5 transition cursor-pointer shadow-md hover:shadow-cyan-500/20 disabled:opacity-50"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2 text-cyan-300">
                <i className="fa-solid fa-spinner animate-spin"></i> Đang kết nối Google...
              </span>
            ) : (
              <>
                <i className="fa-brands fa-google text-red-400 text-sm"></i>
                <span>Đăng ký/đăng nhập Google</span>
              </>
            )}
          </button>

          {/* Domain Guide & Quick Google Fallback */}
          {(showFallbackGoogle || unauthorizedDomain) && (
            <div className="bg-[#080d1a] border border-cyan-500/40 rounded-2xl p-3.5 space-y-2.5 text-left">
              <div className="flex items-start gap-2">
                <i className="fa-solid fa-shield-halved text-cyan-400 text-sm mt-0.5"></i>
                <div className="text-[11px] space-y-1 text-slate-300">
                  <p className="font-bold text-white">
                    {unauthorizedDomain ? '🌐 Kích hoạt Google Auth cho domain web:' : '⚡ Đăng nhập Google tức thì:'}
                  </p>
                  {unauthorizedDomain && (
                    <div className="bg-[#050811] border border-cyan-500/20 rounded-lg p-2.5 text-[10px] space-y-1.5 font-mono">
                      <div className="flex items-center justify-between text-cyan-300">
                        <span>Domain hiện tại:</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(window.location.hostname);
                            setInlineStatus({ type: 'success', message: `📋 Đã sao chép tên miền ${window.location.hostname}` });
                            showToast('📋 Đã sao chép tên miền vào bộ nhớ tạm!', 'success');
                          }}
                          className="text-[9px] bg-cyan-900/60 hover:bg-cyan-800 text-cyan-200 px-2 py-0.5 rounded cursor-pointer transition"
                        >
                          Sao chép domain
                        </button>
                      </div>
                      <div className="text-white font-bold select-all">{unauthorizedDomain}</div>
                      <div className="text-[10px] text-amber-300/95 border-t border-slate-800 pt-1.5">
                        Firebase Auth đang dùng Project: <strong className="text-amber-200 select-all">{activeAuthProjectId}</strong>
                        <span className="block text-slate-400 text-[9px] mt-0.5">({activeAuthDomain})</span>
                      </div>
                      {!isCustomAuthProject ? (
                        <p className="text-slate-300 text-[10px] font-sans leading-relaxed">
                          ℹ️ Project mặc định <strong className="text-cyan-300">{activeAuthProjectId}</strong> do hệ thống AI Studio quản lý. Nếu bạn muốn dùng nút Google Popup trên Vercel với Firebase riêng của bạn (nơi bạn đã thêm <strong>{unauthorizedDomain}</strong>), hãy thêm 4 biến môi trường <code className="text-cyan-300">VITE_FIREBASE_AUTH_API_KEY</code>, <code className="text-cyan-300">VITE_FIREBASE_AUTH_DOMAIN</code>, <code className="text-cyan-300">VITE_FIREBASE_AUTH_PROJECT_ID</code>, <code className="text-cyan-300">VITE_FIREBASE_AUTH_APP_ID</code> trong Vercel Settings ➔ Environment Variables rồi Redeploy.
                        </p>
                      ) : (
                        <p className="text-slate-400 text-[9px] font-sans">
                          👉 Mở đúng Project <strong>{activeAuthProjectId}</strong> trong Firebase Console ➔ Authentication ➔ Settings ➔ Authorized Domains ➔ Add domain <strong>{unauthorizedDomain}</strong> (chỉ nhập tên miền, không có https://).
                        </p>
                      )}
                    </div>
                  )}
                  <p className="text-slate-300 text-[10px]">
                    Hoặc nhập địa chỉ Gmail bên dưới để vào tài khoản ngay lập tức:
                  </p>
                </div>
              </div>

              <form onSubmit={handleFallbackGoogleSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="email"
                    required
                    value={fallbackGoogleEmail}
                    onChange={(e) => setFallbackGoogleEmail(e.target.value)}
                    placeholder="ví dụ: ndanh3366@gmail.com"
                    className="w-full bg-[#0d1424] border border-cyan-500/40 rounded-xl px-3 py-2 text-xs text-white pl-8 focus:outline-none focus:border-cyan-400 placeholder:text-slate-500"
                  />
                  <i className="fa-brands fa-google absolute left-2.5 top-1/2 -translate-y-1/2 text-red-400 text-xs"></i>
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-3.5 py-2 bg-gradient-to-r from-cyan-400 to-blue-500 hover:brightness-110 text-black font-extrabold rounded-xl text-xs transition cursor-pointer shrink-0 disabled:opacity-50"
                >
                  {isSubmitting ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Vào Ngay'}
                </button>
              </form>
            </div>
          )}

          {!showFallbackGoogle && !unauthorizedDomain && (
            <button
              type="button"
              onClick={() => setShowFallbackGoogle(true)}
              className="text-[10px] text-cyan-400 hover:text-cyan-300 underline cursor-pointer transition block mx-auto pt-1"
            >
              ⚡ Đăng nhập nhanh bằng địa chỉ Gmail
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
