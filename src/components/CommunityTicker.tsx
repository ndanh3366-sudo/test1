import React, { useState, useEffect } from 'react';
import { Order } from '../types.ts';
import { generateCustomerAvatarSvgUrl } from '../utils/avatarGenerator.ts';

interface CommunityTickerProps {
  latestOrder?: Order | null;
}

export const CommunityTicker: React.FC<CommunityTickerProps> = ({ latestOrder }) => {
  const [currentOrder, setCurrentOrder] = useState<Order | null>(null);
  const [visible, setVisible] = useState(false);

  // Chỉ hiện thanh thông báo khi có người mua mới (mua trực tiếp, đồng bộ hoặc mỗi 30s 1 đơn)
  useEffect(() => {
    if (!latestOrder) return;

    setCurrentOrder(latestOrder);
    setVisible(true);

    // Hiển thị nổi bật trong 12 giây rồi tự ẩn chờ đơn tiếp theo
    const hideTimeout = setTimeout(() => {
      setVisible(false);
    }, 12000);

    return () => {
      clearTimeout(hideTimeout);
    };
  }, [latestOrder]);

  if (!currentOrder) return null;

  const firstItem = currentOrder.items?.[0];
  const productName = firstItem?.productName || 'Mô hình Kamen Rider Chính Hãng';
  const totalQty = currentOrder.items?.reduce((sum, it) => sum + (it.quantity || 1), 0) || 1;
  const priceFormatted = currentOrder.total.toLocaleString('vi-VN') + 'đ';
  const avatarUrl = currentOrder.customerAvatar || generateCustomerAvatarSvgUrl({
    maskId: 'geats-fox',
    colorId: 'crimson-ruby',
    initials: currentOrder.customerName.slice(0, 2).toUpperCase(),
    customerName: currentOrder.customerName
  });

  const paymentLabel =
    currentOrder.paymentMethod === 'BANK'
      ? 'Chuyển khoản'
      : currentOrder.paymentMethod === 'MOMO'
      ? 'Ví MoMo'
      : 'COD';

  return (
    <div 
      key={currentOrder.id}
      className={`fixed bottom-3 left-3 right-3 sm:right-auto sm:left-4 z-40 flex pointer-events-none transition-all duration-500 ease-out transform ${
        visible 
          ? 'translate-y-0 opacity-100 scale-100' 
          : 'translate-y-8 opacity-0 scale-95 pointer-events-none'
      }`}
    >
      <div 
        className="bg-[#0A0F1D]/95 border-2 border-[#00F2FE]/80 backdrop-blur-2xl p-2.5 sm:p-3 shadow-[0_12px_45px_rgba(0,0,0,0.95),0_0_30px_rgba(0,242,254,0.45)] flex items-center gap-3 w-full sm:max-w-md pointer-events-auto rounded-2xl ring-1 ring-cyan-400/30"
      >
        {/* Customer Avatar */}
        <div 
          className="w-12 h-12 sm:w-13 sm:h-13 border-2 border-[#00F2FE] overflow-hidden shrink-0 bg-[#050914] relative p-0.5 shadow-[0_0_15px_rgba(0,242,254,0.5)] rounded-xl"
        >
          <img 
            src={avatarUrl} 
            alt={currentOrder.customerName} 
            className="w-full h-full object-cover rounded-lg"
            onError={(e) => {
              e.currentTarget.src = '/icons/c01.png';
            }}
          />
          <span className="absolute bottom-0 right-0 text-[6px] px-1 uppercase rounded-tl bg-[#00F2FE] text-slate-950 font-black">
            RIDER VIP
          </span>
        </div>

        <div className="text-[11px] leading-tight min-w-0 flex-grow space-y-0.5">
          <div className="flex items-center gap-1.5 text-slate-200 font-medium truncate">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <strong className="text-white font-bold truncate">{currentOrder.customerName}</strong> 
            <span className="text-[#00F2FE] font-semibold shrink-0">vừa đặt mua thành công</span>
          </div>

          <div className="flex items-center gap-2 truncate">
            <p className="text-[#05FFD2] font-bold truncate text-xs flex-grow">
              {productName}{totalQty > 1 ? ` (x${totalQty})` : ''}
            </p>
            <span className="text-amber-400 font-mono font-black text-xs shrink-0">+{priceFormatted}</span>
          </div>

          <div className="text-[9px] text-[#E0F7FA]/75 font-mono flex items-center gap-1.5 pt-0.5">
            <i className="fa-solid fa-circle-check text-[#00F2FE] text-[8px]"></i>
            <span className="text-[#00F2FE] font-bold">Chính Hãng Bandai Japan</span>
            <span>•</span>
            <span className="text-amber-300 font-semibold">{paymentLabel}</span>
            <span>•</span>
            <span className="text-emerald-400 font-semibold">Vừa xong ({currentOrder.time})</span>
          </div>
        </div>

        <button 
          onClick={() => setVisible(false)}
          className="text-slate-400 hover:text-white text-xs ml-auto shrink-0 p-1 cursor-pointer w-6 h-6 flex items-center justify-center rounded-full hover:bg-white/10 transition"
          title="Ẩn thông báo"
        >
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  );
};
