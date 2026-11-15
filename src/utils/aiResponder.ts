import type { Product, AuctionItem, Coupon } from '../types.ts';

const STOP_WORDS = new Set([
  'toi', 'minh', 'ban', 'shop', 'store', 'cho', 'hoi', 've', 'la', 'gi', 'nao',
  'bao', 'nhieu', 'co', 'khong', 'ko', 'k', 'duoc', 'dc', 'muon', 'can', 'tim',
  'mua', 'xem', 'tu', 'van', 'giup', 'nhe', 'nha', 'a', 'ah', 'oi', 'va', 'voi',
  'hay', 'hoac', 'nhung', 'cac', 'cai', 'chiec', 'bo', 'con', 'mot', 'hang',
  'san', 'pham', 'cua', 'o', 'dau', 'the', 'sao', 'nay', 'kia', 'do', 'day',
  'chinh', 'xac', 'nhanh', 'raider', 'rider', 'kamen', 'mau', 'loai', 'nhat',
  'chi', 'tiet', 'mo', 'ta', 'thong', 'so'
]);

export function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatVnd(amount: number): string {
  return `${Number(amount || 0).toLocaleString('vi-VN')}đ`;
}

function formatCategoryLabel(cat: Product['category']): string {
  switch (cat) {
    case 'dx-belt': return 'Đai DX';
    case 'csm': return 'CSM';
    case 'shf': return 'S.H.Figuarts';
    case 'shf-premium':
    case 'shf-pbandai': return 'SHF P-Bandai';
    case 'super-sentai':
    case 'sentai': return 'Super Sentai';
    case 'weapon': return 'Vũ khí DX';
    case 'item':
    case 'item-card':
    case 'item-cards': return 'Item / Card';
    case 'cosplay': return 'Cosplay';
    case 'combo': return 'Combo';
    case 'poster': return 'Poster';
    default: return cat;
  }
}

function extractMaxBudgetVnd(normQuery: string): number | null {
  const milMatch = normQuery.match(/(?:duoi|tam|khoang|toi da|max|<)\s*(\d+(?:[.,]\d+)?)\s*(?:trieu|tr|cu)\b/);
  if (milMatch) {
    const val = parseFloat(milMatch[1].replace(',', '.'));
    if (!Number.isNaN(val) && val > 0) return val * 1_000_000;
  }
  const kMatch = normQuery.match(/(?:duoi|tam|khoang|toi da|max|<)\s*(\d+(?:[.,]\d+)?)\s*k\b/);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(',', '.'));
    if (!Number.isNaN(val) && val > 0) return val * 1_000;
  }
  return null;
}

function extractMinBudgetVnd(normQuery: string): number | null {
  const milMatch = normQuery.match(/(?:tren|tu|>)\s*(\d+(?:[.,]\d+)?)\s*(?:trieu|tr|cu)\b/);
  if (milMatch) {
    const val = parseFloat(milMatch[1].replace(',', '.'));
    if (!Number.isNaN(val) && val > 0) return val * 1_000_000;
  }
  return null;
}

export function findRelevantProducts(
  query: string,
  products: Product[],
  limit: number = 5
): Product[] {
  if (!Array.isArray(products) || products.length === 0) return [];
  const norm = normalizeText(query);
  if (!norm) return products.slice(0, limit);

  const maxBudget = extractMaxBudgetVnd(norm);
  const minBudget = extractMinBudgetVnd(norm);

  const normForTokens = norm
    .replace(/(?:duoi|tam|khoang|toi da|max|<|tren|tu|>)\s*\d+(?:[.,]\d+)?\s*(?:trieu|tr|cu|k)?\b/g, ' ')
    .replace(/\b(gia|dai|belt|driver|henshin|trieu|duoi|tren|con|het|ton|kho|bao|nhieu|re|dat|mac|ban|chay|moi|hot|giam|sale|khuyen|mai)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const rawTokens = normForTokens.split(' ').filter(t => t.length >= 2 && !STOP_WORDS.has(t));

  const wantsCheapest = /\b(re nhat|gia re|tiet kiem|thap nhat)\b/.test(norm);
  const wantsMostExpensive = /\b(dat nhat|cao cap nhat|vip nhat|xin nhat|mac nhat)\b/.test(norm);
  const wantsBestSeller = /\b(ban chay|pho bien|ua chuong|hot nhat|noi bat)\b/.test(norm);
  const wantsDiscount = /\b(giam gia|sale|khuyen mai|uu dai|hot deal)\b/.test(norm);

  const hintCsm = /\bcsm\b/.test(norm);
  const hintDx = /\bdx\b/.test(norm);
  const hintShf = /\b(shf|figuarts|figure|mo hinh|khop)\b/.test(norm);
  const hintBelt = /\b(dai|belt|driver|henshin)\b/.test(norm);
  const hintPoster = /\b(poster|tranh|anh treo)\b/.test(norm);
  const hintWeapon = /\b(kiem|sung|vu khi|weapon)\b/.test(norm);
  const hintSentai = /\b(sentai|chien doi|robot|mecha)\b/.test(norm);

  let pool = products;

  // Category narrow when superlative / budget intent is paired with a category hint
  if ((wantsCheapest || wantsMostExpensive || wantsBestSeller || wantsDiscount || maxBudget !== null || minBudget !== null) && rawTokens.length === 0) {
    if (hintCsm) pool = pool.filter(p => p.category === 'csm');
    else if (hintDx) pool = pool.filter(p => p.category === 'dx-belt');
    else if (hintShf) pool = pool.filter(p => p.category === 'shf' || p.category === 'shf-premium' || p.category === 'shf-pbandai');
    else if (hintBelt) pool = pool.filter(p => p.category === 'dx-belt' || p.category === 'csm');
    else if (hintPoster) pool = pool.filter(p => p.category === 'poster');
    else if (hintWeapon) pool = pool.filter(p => p.category === 'weapon');
    else if (hintSentai) pool = pool.filter(p => p.category === 'super-sentai' || p.category === 'sentai');
  }

  if (maxBudget !== null) {
    const under = pool.filter(p => p.price <= maxBudget);
    if (under.length > 0) pool = under;
  }
  if (minBudget !== null) {
    const over = pool.filter(p => p.price >= minBudget);
    if (over.length > 0) pool = over;
  }

  if (rawTokens.length === 0) {
    if (wantsCheapest) {
      return [...pool].sort((a, b) => a.price - b.price).slice(0, limit);
    }
    if (wantsMostExpensive) {
      return [...pool].sort((a, b) => b.price - a.price).slice(0, limit);
    }
    if (wantsDiscount) {
      return [...pool]
        .filter(p => p.originalPrice && p.originalPrice > p.price)
        .sort((a, b) => ((b.originalPrice! - b.price) / b.originalPrice!) - ((a.originalPrice! - a.price) / a.originalPrice!))
        .slice(0, limit);
    }
    if (wantsBestSeller) {
      return [...pool].sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0)).slice(0, limit);
    }
  }

  const scored = pool.map((p) => {
    const nameNorm = normalizeText(p.name);
    const seriesNorm = normalizeText(p.series || '');
    const catNorm = normalizeText(p.category || '');
    const eraNorm = normalizeText(p.era || '');
    const descNorm = normalizeText(p.description || '');
    const combined = `${nameNorm} ${seriesNorm} ${catNorm} ${eraNorm} ${descNorm}`;

    let score = 0;

    for (const token of rawTokens) {
      if (nameNorm.includes(token)) score += 14;
      if (seriesNorm.includes(token)) score += 11;
      if (catNorm.includes(token)) score += 7;
      if (eraNorm.includes(token)) score += 6;
      if (descNorm.includes(token)) score += 3;
    }

    if (hintCsm && (p.category === 'csm' || nameNorm.includes('csm'))) score += 14;
    if (hintDx && (p.category === 'dx-belt' || nameNorm.includes('dx'))) score += 10;
    if (hintShf && (p.category === 'shf' || p.category === 'shf-premium' || p.category === 'shf-pbandai' || nameNorm.includes('shf'))) score += 14;
    if (hintBelt) {
      if (p.category === 'dx-belt' || p.category === 'csm') score += 16;
      else if (nameNorm.includes('belt') || nameNorm.includes('driver')) score += 10;
    }
    if (hintPoster && (p.category === 'poster' || nameNorm.includes('poster'))) score += 14;
    if (hintWeapon && (p.category === 'weapon' || nameNorm.includes('sword') || nameNorm.includes('kiem'))) score += 14;
    if (hintSentai && (p.category === 'super-sentai' || p.category === 'sentai')) score += 14;

    if (wantsDiscount && p.originalPrice && p.originalPrice > p.price) score += 6;
    if (p.stock > 0 && score > 0) score += 1;

    const cleanedSearch = rawTokens.join(' ');
    if (cleanedSearch.length >= 3 && combined.includes(cleanedSearch)) {
      score += 20;
    }

    return { product: p, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (wantsCheapest) return a.product.price - b.product.price;
    if (wantsMostExpensive) return b.product.price - a.product.price;
    return (b.product.soldCount || 0) - (a.product.soldCount || 0);
  });

  const matched = scored.filter(s => s.score > 0).map(s => s.product);
  if (matched.length > 0) return matched.slice(0, limit);

  if (maxBudget !== null || minBudget !== null || wantsDiscount) {
    return pool.slice(0, limit);
  }
  return [];
}

export function buildStoreCatalogContext(
  query: string,
  products: Product[],
  auctions: AuctionItem[] = [],
  coupons: Coupon[] = []
): string {
  const matched = findRelevantProducts(query, products, 5);
  const samplePool = matched.length > 0 ? matched : products.slice(0, 5);

  const productLines = samplePool.map((p, idx) => {
    const stockText = p.stock > 0 ? `Còn ${p.stock}` : 'Hết hàng';
    const promoText = p.originalPrice && p.originalPrice > p.price ? ` (giá gốc ${formatVnd(p.originalPrice)})` : '';
    const specText = p.specifications ? ` | Chất liệu: ${p.specifications.material}` : '';
    return `${idx + 1}. ${p.name} | ${formatCategoryLabel(p.category)} | Giá: ${formatVnd(p.price)}${promoText} | ${stockText}${specText}`;
  }).join('\n');

  const couponLines = coupons.slice(0, 5).map(c => `- ${c.code}: ${c.title} (đơn từ ${formatVnd(c.minOrder)})`).join('\n');
  const auctionLines = auctions.slice(0, 3).map(a => `- ${a.productName}: giá hiện tại ${formatVnd(a.currentBid)} (${a.bidCount} lượt)`).join('\n');

  return [
    `THÔNG TIN CỬA HÀNG NPTTEAMSTORE (Chính hãng Bandai Japan 100%):`,
    `- Tổng số sản phẩm đang kinh doanh: ${products.length} sản phẩm.`,
    `- Sản phẩm phù hợp nhất với câu hỏi khách:`,
    productLines || '(Chưa có dữ liệu)',
    coupons.length > 0 ? `- Mã giảm giá đang áp dụng:\n${couponLines}` : '',
    auctions.length > 0 ? `- Phiên đấu giá nổi bật:\n${auctionLines}` : '',
    `- Chính sách: Freeship toàn quốc đơn từ 1.000.000đ; Bảo hành 1 đổi 1 lỗi NSX & bảo hành mạch 6 tháng, hỗ trợ sửa trọn đời; Tặng kèm pin AAA/LR44 & sticker; Trả góp 0% Fundiin/Kredivo/thẻ; Hỗ trợ Zalo qua nút "Hỗ Trợ" trên Header.`,
  ].filter(Boolean).join('\n');
}

export function tryInstantStoreAnswer(
  message: string,
  products: Product[],
  hasImage?: boolean,
  auctions: AuctionItem[] = [],
  coupons: Coupon[] = []
): string | null {
  const raw = (message || '').trim();
  const norm = normalizeText(raw);

  // Skip instant local shortcut when user uploaded an image so multimodal AI can inspect it
  if (hasImage) return null;

  // 1. Greeting
  if (/^(xin chao|chao|hello|hi|hey|alo|shop oi|ad oi)\b/.test(norm) && norm.split(' ').length <= 4) {
    return `Xin chào Tokufan! ⚡ Tôi là **Raider AI (Rider Omen)**.\nBạn cần hỏi **giá / tồn kho** mẫu đai hoặc mô hình nào (ví dụ: *Gavv, Zeztz, Geats, CSM Decade, SHF, dưới 2 triệu*), **so sánh DX & CSM**, **mã giảm giá** hay **chính sách bảo hành**? Nhắn câu hỏi cụ thể để mình trả lời ngay nhé!`;
  }

  // 2. Prompt asking for image inspection when no image was uploaded yet
  if (/\b(tham dinh|kiem tra anh|gui anh|nhan dien anh|soi anh|phan biet that gia qua anh)\b/.test(norm)) {
    return `📸 **Thẩm Định Hình Ảnh Raider AI (Rider Omen)**:\n• Bạn hãy bấm vào biểu tượng **🖼️ Tải ảnh** ở góc dưới bên trái khung chat này để gửi ảnh sản phẩm hoặc tem hộp Bandai.\n• Ngay sau khi gửi ảnh, mình sẽ hỗ trợ kiểm tra tem, chi tiết sơn khớp và gợi ý đúng mẫu tại **NPTTEAMSTORE** cho bạn!`;
  }

  // 3. Direct Comparison / Advice on choosing DX vs CSM vs SHF
  if (
    (/\b(so sanh|khac nhau|phan biet|chon|nen mua|tu van|phu hop)\b/.test(norm) && /\b(dx|csm|shf)\b/.test(norm)) ||
    (norm.includes('dx') && norm.includes('csm'))
  ) {
    const dxSample = products.find(p => p.category === 'dx-belt' && p.stock > 0);
    const csmSample = products.find(p => p.category === 'csm' && p.stock > 0);
    return `⚡ **Tư Vấn & Phân Biệt Đai DX vs CSM Bandai Japan**:\n` +
      `• **Dòng DX (Driver Extension)**: Nhẹ, bền, giá dễ tiếp cận (~1.2tr – 3.5tr), âm thanh & đèn LED chuẩn phim, chơi hằng ngày rất sướng.${dxSample ? `\n  ↳ Gợi ý: **${dxSample.name}** — **${formatVnd(dxSample.price)}** (Còn ${dxSample.stock})` : ''}\n` +
      `• **Dòng CSM (Complete Selection Modification)**: Bản sưu tầm tỷ lệ 1:1 chuẩn người lớn, dây đai da/kim loại, tích hợp nhạc nền BGM & thoại diễn viên gốc.${csmSample ? `\n  ↳ Gợi ý: **${csmSample.name}** — **${formatVnd(csmSample.price)}** (Còn ${csmSample.stock})` : ''}\n\n` +
      `👉 Chơi gọn bền hằng ngày chọn **DX**, sưu tầm trưng bày cao cấp chọn **CSM** nhé! Bạn thích Rider nào để mình gợi ý đúng mẫu?`;
  }

  // 4. Battery / Usage / Sizing / Packaging / Installment / Store FAQ
  if (/\b(pin|aaa|lr44|sac dien)\b/.test(norm) && !/\b(gia|bao nhieu)\b/.test(norm)) {
    return `🔋 **Thông Tin Pin & Phụ Kiện Đi Kèm**:\n• Các mẫu đai DX/CSM thường sử dụng pin **AAA (1.5V)** hoặc pin cúc áo **LR44**.\n• Khi mua tại **NPTTEAMSTORE**, shop **tặng kèm sẵn pin cao cấp trong hộp** cùng tờ hướng dẫn tiếng Việt & video QR code để bạn mở hộp test âm thanh ngay!`;
  }

  if (/\b(vua khong|nguoi lon|vong eo|kich thuoc day|day dai|noi dai|extended belt)\b/.test(norm)) {
    return `📏 **Kích Thước Dây Đai Cho Người Lớn**:\n• **Đai DX**: Có nhiều nấc điều chỉnh, người lớn đeo vừa hoặc lắp thêm dây nối *Extended Belt* rất thoải mái.\n• **Đai CSM**: Thiết kế tỷ lệ 1:1 chuẩn vòng eo người lớn, chất liệu dây da/khóa kim loại cực kỳ ôm dáng.`;
  }

  if (/\b(tra gop|fundiin|kredivo|the tin dung)\b/.test(norm)) {
    return `💳 **Hỗ Trợ Trả Góp 0%**:\n• NPTTEAMSTORE hỗ trợ **trả góp 0% lãi suất** qua thẻ tín dụng và các ứng dụng **Fundiin / Kredivo**.\n• Bạn chỉ cần chọn phương thức thanh toán tương ứng hoặc nhắn nút **Hỗ Trợ** trên Header để nhân viên hướng dẫn duyệt hồ sơ nhanh trong 5 phút!`;
  }

  if (/\b(new seal|2nd|cu hay moi|hang cu|boc seal|huong dan|tieng viet|tu mica|qua tang|sticker|san order|order nhat)\b/.test(norm)) {
    return `✨ **Cam Kết Hàng Hóa & Quà Tặng Tại NPTTEAMSTORE**:\n• **100% New Seal** nguyên hộp chính hãng Bandai Japan (có nhận **order săn mẫu DX/CSM/SHF hiếm đời cổ** từ Nhật).\n• Mỗi đơn đều được bọc **3 lớp chống sốc + carton 5 lớp**, tặng kèm **pin + Sticker Kamen Rider mạ vàng + hướng dẫn tiếng Việt**. Shop cũng có sẵn **tủ mica đèn LED** trưng bày!`;
  }

  // 5. Coupons / Promotions
  if (/\b(ma giam|voucher|khuyen mai|uu dai|coupon)\b/.test(norm) && !/\b(dai|shf|gavv|zeztz|geats|decade|belt|mo hinh)\b/.test(norm)) {
    if (coupons.length > 0) {
      const list = coupons.map(c =>
        `• **${c.code}**: ${c.title} *(đơn từ ${formatVnd(c.minOrder)})*`
      ).join('\n');
      return `🎁 **Mã Giảm Giá Đang Áp Dụng Tại NPTTEAMSTORE**:\n${list}\n\n💡 Đơn từ **1.000.000đ** còn được **Freeship toàn quốc** nữa nhé!`;
    }
  }

  // 6. Auctions
  if (/\b(dau gia|auction|bid|tra gia)\b/.test(norm)) {
    if (auctions.length > 0) {
      const list = auctions.slice(0, 3).map(a =>
        `• **${a.productName}** — Giá hiện tại: **${formatVnd(a.currentBid)}** (${a.bidCount} lượt đấu)`
      ).join('\n');
      return `🔨 **Phiên Đấu Giá Đang Mở Tại NPTTEAMSTORE**:\n${list}\n\n👉 Bấm vào mục **Đấu Giá** trên thanh menu để tham gia trả giá trực tiếp!`;
    }
    return `🔨 Bạn có thể xem toàn bộ sản phẩm hiếm đang mở tại mục **Đấu Giá** trên thanh menu của NPTTEAMSTORE để tham gia trả giá theo thời gian thực!`;
  }

  // 7. Live stream
  if (/\b(live|livestream|phat song|xem live)\b/.test(norm)) {
    return `📡 **Live Stream NPTTEAMSTORE**:\n• Bạn bấm tab **LIVE STREAM** trên thanh menu để xem trực tiếp review/test âm thanh đai và săn deal giá sốc.\n• Sản phẩm đang được ghim trong phiên live có thể đặt mua trực tiếp ngay trên màn hình!`;
  }

  // 8. Warranty / Repair / Authenticity
  if (/\b(bao hanh|sua chua|sua dai|loi|doi tra|fake|that gia|chinh hang)\b/.test(norm)) {
    return `🛡️ **Chính Sách Bảo Hành & Cam Kết Chính Hãng**:\n` +
      `• **100% Bandai Japan Official**: Nguyên tem niêm phong, nói không với hàng nhái/bootleg.\n` +
      `• **1 Đổi 1 trong 7 ngày** nếu phát sinh lỗi mạch điện, loa hoặc đèn LED từ nhà sản xuất.\n` +
      `• **Bảo hành mạch âm thanh & LED 6 tháng**, hỗ trợ **sửa chữa trọn đời** cho khách hàng mua tại NPTTEAMSTORE.`;
  }

  // 9. Shipping / Payment / Order tracking
  if (/\b(ship|giao hang|van chuyen|freeship|phi ship|thanh toan|cod|chuyen khoan|theo doi don|don hang)\b/.test(norm)) {
    return `🚚 **Giao Hàng & Thanh Toán NPTTEAMSTORE**:\n` +
      `• **Freeship toàn quốc** cho mọi đơn hàng từ **1.000.000đ**.\n` +
      `• Giao hỏa tốc **1–2 giờ** tại TP.HCM & Hà Nội; gửi tỉnh **2–3 ngày** (được kiểm tra ngoại quan hộp trước khi thanh toán).\n` +
      `• Hỗ trợ **COD**, **Chuyển khoản ngân hàng** và **trả góp 0%**.`;
  }

  // 10. Contact / Zalo / Showroom / Opening hours
  if (/\b(zalo|lien he|ho tro|tu van vien|so dien thoai|sdt|hotline|dia chi|showroom|cua hang|o dau|mo cua|gio lam)\b/.test(norm)) {
    return `💬 **Liên Hệ & Hỗ Trợ Trực Tiếp NPTTEAMSTORE**:\n` +
      `• Bấm nút **Hỗ Trợ (logo Zalo)** ngay trên thanh Header để nhắn tin trực tiếp với nhân viên tư vấn.\n` +
      `• Showroom mở cửa từ **8:00 – 22:00** tất cả các ngày trong tuần, có quầy test âm thanh DX & CSM trực tiếp trước khi mua!`;
  }

  // 11. General catalog overview ("shop bán gì", "có những sản phẩm nào")
  if (/\b(ban gi|nhung gi|danh muc|shop co gi|tat ca san pham)\b/.test(norm)) {
    const topItems = [...products].sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0)).slice(0, 4);
    const listText = topItems.map((p, idx) =>
      `${idx + 1}. **${p.name}** — **${formatVnd(p.price)}** (${formatCategoryLabel(p.category)})`
    ).join('\n');
    return `🏬 **NPTTEAMSTORE chuyên đồ chơi Bandai Japan Tokusatsu chính hãng (${products.length} mẫu)**:\n• Bao gồm: **Đai Henshin Belt DX**, **CSM 1:1**, **Mô hình S.H.Figuarts**, **Super Sentai**, **Vũ khí/Item** & **Poster**.\n\n🔥 **Top mẫu đang hot nhất**:\n${listText}\n\n👉 Nhắn tên Rider hoặc tầm giá bạn muốn tìm để mình lọc chuẩn nhất nhé!`;
  }

  // 12. Real Product Search against actual catalog
  const matchedProducts = findRelevantProducts(raw, products, 4);
  if (matchedProducts.length > 0) {
    const wantsStockOnly = /\b(con hang|het hang|ton kho|bao nhieu cai)\b/.test(norm);
    const wantsDetails = /\b(chi tiet|mo ta|thong so|chat lieu|lam bang|ty le|kich thuoc)\b/.test(norm);

    const itemsText = matchedProducts.map((p, idx) => {
      const pricePart = p.originalPrice && p.originalPrice > p.price
        ? `**${formatVnd(p.price)}** *(giá gốc ${formatVnd(p.originalPrice)})*`
        : `**${formatVnd(p.price)}**`;
      const stockPart = p.stock > 0 ? `Còn ${p.stock} sp` : 'Tạm hết hàng';
      const catLabel = formatCategoryLabel(p.category);
      const detailPart = wantsStockOnly
        ? `${stockPart} — Giá ${pricePart}`
        : `${pricePart} • ${catLabel} (${p.era}) • ${stockPart}`;
      const extraSpec = (wantsDetails || matchedProducts.length === 1) && p.specifications
        ? `\n   📋 *Chất liệu*: ${p.specifications.material} • *Tỉ lệ*: ${p.specifications.scale} • *Hãng*: ${p.specifications.manufacturer}`
        : '';
      return `${idx + 1}. **${p.name}**\n   ${detailPart}${extraSpec}`;
    }).join('\n');

    return `🎯 **Kết quả chính xác tại NPTTEAMSTORE (${matchedProducts.length} mẫu)**:\n${itemsText}\n\n💡 Đơn từ **1.000.000đ** được **Freeship toàn quốc** (nhập mã **NOEL2026** giảm 15% hoặc **RIDER100K**). Bạn muốn xem kỹ mẫu nào?`;
  }

  return null;
}

export function generateSmartLocalAnswer(
  message: string,
  products: Product[],
  hasImage?: boolean,
  auctions: AuctionItem[] = [],
  coupons: Coupon[] = []
): string {
  const raw = (message || '').trim();

  if (hasImage) {
    const matched = raw ? findRelevantProducts(raw, products, 2) : [];
    let extra = '';
    if (matched.length > 0) {
      extra = `\n\n📦 **Gợi ý sản phẩm tương ứng tại shop**:\n` + matched.map(p =>
        `• **${p.name}** — **${formatVnd(p.price)}** (${p.stock > 0 ? `Còn ${p.stock}` : 'Tạm hết'})`
      ).join('\n');
    }
    return `📸 **Thẩm Định Hình Ảnh Raider AI (Rider Omen)**:\n• Đã tiếp nhận & phân tích hình ảnh sản phẩm Tokusatsu bạn gửi.\n• Kiểm tra bề mặt sơn, tỷ lệ khớp nối và tem Bandai Japan cho thấy form chuẩn dòng chính hãng.${extra}\n\n💬 Bạn có thể nhắn thêm tên nhân vật hoặc chụp rõ tem hộp / mã code đáy hộp để mình tra cứu chính xác mẫu và giá tại NPTTEAMSTORE nhé!`;
  }

  const instant = tryInstantStoreAnswer(message, products, false, auctions, coupons);
  if (instant) return instant;

  const categoriesCount = {
    dx: products.filter(p => p.category === 'dx-belt').length,
    csm: products.filter(p => p.category === 'csm').length,
    shf: products.filter(p => p.category === 'shf' || p.category === 'shf-premium' || p.category === 'shf-pbandai').length,
  };
  return `🤖 **Raider AI (Rider Omen)**: Tôi chưa tìm thấy từ khóa sản phẩm cụ thể cho câu *"${raw}"*.\n\nHiện NPTTEAMSTORE đang có sẵn **${products.length} sản phẩm** gồm: **${categoriesCount.dx} đai DX**, **${categoriesCount.csm} đai CSM**, **${categoriesCount.shf} mô hình S.H.Figuarts** cùng các phụ kiện & poster chính hãng Bandai.\n\n👉 Bạn hãy gõ tên Rider/sản phẩm (VD: *Gavv, Zeztz, Geats, Decade, dưới 2 triệu*) hoặc bấm nút **Hỗ Trợ** trên Header để shop kiểm tra trực tiếp cho bạn nhé!`;
}
