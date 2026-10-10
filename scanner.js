/*!
 * scanner.js — Bộ quét QR tối ưu cho mã nhỏ, dày đặc, hơi mờ (QR trên thẻ CCCD).
 * © 2026 Thanh Nguyen. Bảo lưu mọi quyền.
 *
 * Kỹ thuật:
 *  - Camera độ phân giải cao, lấy nét liên tục, zoom quang/số, đèn flash, chạm để lấy nét.
 *  - Chỉ cắt vùng khung ngắm ở ĐỘ PHÂN GIẢI GỐC của cảm biến (không thu nhỏ cả khung hình).
 *  - Tiền xử lý: chuyển xám, giãn tương phản, làm nét (unsharp mask), phóng to vùng nhỏ.
 *  - Ba bộ giải mã luân phiên: BarcodeDetector (gốc của máy, nếu có) → ZXing → jsQR.
 *  - Đo độ nét từng khung hình để nhắc người dùng và tự kích lại lấy nét khi ảnh mờ lâu.
 *  - Ảnh chụp: quét toàn ảnh rồi quét cửa sổ trượt nhiều cỡ để tìm mã nhỏ.
 */
(function (global) {
  'use strict';

  /* ================= Chẩn đoán ================= */
  const VERSION = '1.5.1';
  const UA = navigator.userAgent || '';
  const IS_IOS = /iP(hone|ad|od)/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const DIAG = { decoders: {}, camera: {}, live: { frames: 0, sharpSum: 0, sharpN: 0, wins: {} }, image: [], errors: [] };
  function derr(where, e) {
    const m = where + ': ' + (e && (e.name ? e.name + ' ' : '') + (e && e.message || e));
    if (DIAG.errors[DIAG.errors.length - 1] !== m) DIAG.errors.push(m);
    if (DIAG.errors.length > 15) DIAG.errors.shift();
  }

  /* ================= Bộ giải mã ================= */
  // zxing-wasm: lõi ZXing C++ (mạnh hơn nhiều so với ZXing JS), tải từ jsDelivr khi cần.
  // Quan trọng nhất trên iPhone vì WebKit không có BarcodeDetector.
  const ZW_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2/dist/iife/reader/index.js';
  let zw = null, zwReady = null;
  function loadZW(timeoutMs) {
    if (!zwReady) {
      DIAG.decoders.zxingWasm = 'đang tải…';
      zwReady = new Promise(res => {
        if (global.ZXingWASM) return res(global.ZXingWASM);
        const sc = document.createElement('script');
        sc.src = ZW_URL; sc.async = true; sc.crossOrigin = 'anonymous';
        sc.onload = () => res(global.ZXingWASM || null);
        sc.onerror = () => { DIAG.decoders.zxingWasm = 'lỗi tải script (mạng / CDN bị chặn)'; res(null); };
        document.head.appendChild(sc);
        setTimeout(() => res(global.ZXingWASM || null), 20000);
      }).then(async Z => {
        if (!Z) { if (DIAG.decoders.zxingWasm === 'đang tải…') DIAG.decoders.zxingWasm = 'không tải được'; return null; }
        try {
          const t0 = performance.now();
          await Z.prepareZXingModule({ fireImmediately: true });
          zw = Z; DIAG.decoders.zxingWasm = 'sẵn sàng (' + Math.round(performance.now() - t0) + ' ms)';
          return Z;
        } catch (e) { DIAG.decoders.zxingWasm = 'lỗi khởi tạo wasm: ' + (e && e.message || e); return null; }
      });
    }
    if (!timeoutMs) return zwReady;
    return Promise.race([zwReady, new Promise(r => setTimeout(() => r(zw), timeoutMs))]);
  }
  const utf8 = (() => { try { return new TextDecoder('utf-8', { fatal: true }); } catch (e) { return null; } })();
  async function tryZW(input, denoise) {
    if (!zw) return null;
    try {
      const r = await zw.readBarcodes(input, {
        formats: ['QRCode'], tryHarder: true, tryRotate: true, tryInvert: false,
        tryDownscale: true, tryDenoise: !!denoise, characterSet: 'UTF8', maxNumberOfSymbols: 1
      });
      const ok = r && r.find(x => x.isValid);
      if (!ok) return null;
      if (ok.bytes && ok.bytes.length && utf8) { try { return utf8.decode(ok.bytes); } catch (e) {} }
      return ok.text || null;
    } catch (e) { derr('zxing-wasm', e); return null; }
  }
  function imageDataOf(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  let bd = null, bdReady = null;
  function getBD() {
    if (bdReady) return bdReady;
    bdReady = (async () => {
      if (!('BarcodeDetector' in global)) { DIAG.decoders.barcodeDetector = 'không có (bình thường trên iPhone)'; return null; }
      try {
        const f = await global.BarcodeDetector.getSupportedFormats();
        if (f && f.includes('qr_code')) bd = new global.BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) { bd = null; }
      DIAG.decoders.barcodeDetector = bd ? 'có' : 'không có';
      return bd;
    })();
    return bdReady;
  }

  let zx = null;
  function getZX() {
    if (zx) return zx;
    if (typeof global.Html5Qrcode === 'undefined') return null;
    let host = document.getElementById('zx-host');
    if (!host) { host = document.createElement('div'); host.id = 'zx-host'; host.style.display = 'none'; document.body.appendChild(host); }
    try {
      const h = new global.Html5Qrcode('zx-host', {
        formatsToSupport: [global.Html5QrcodeSupportedFormats.QR_CODE],
        useBarCodeDetectorIfSupported: false,
        experimentalFeatures: { useBarCodeDetectorIfSupported: false },
        verbose: false
      });
      zx = h.qrcode; // Html5QrcodeShim → ZXing (HybridBinarizer)
      DIAG.decoders.zxingJs = 'sẵn sàng';
    } catch (e) { zx = null; DIAG.decoders.zxingJs = 'lỗi: ' + (e && e.message || e); }
    return zx;
  }

  // Sửa lỗi bộ giải mã đọc nhầm UTF-8 thành Latin-1 (ví dụ "Nguyá»…n")
  function fixEncoding(s) {
    if (!s || !/[ÃÂÄÅÆáºá»]/.test(s)) return s;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return s;
    try {
      const bytes = Uint8Array.from(s, c => c.charCodeAt(0));
      const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return out;
    } catch (e) { return s; }
  }

  async function tryBD(canvas) {
    const d = await getBD(); if (!d) return null;
    try { const r = await d.detect(canvas); return r && r.length ? r[0].rawValue : null; } catch (e) { return null; }
  }
  async function tryZX(canvas) {
    const z = getZX(); if (!z) return null;
    try { const r = await z.decodeAsync(canvas); return r && r.text ? r.text : null; } catch (e) { return null; }
  }
  function tryJsQR(canvas, invert) {
    if (typeof global.jsQR !== 'function') return null;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const r = global.jsQR(im.data, im.width, im.height, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
      return r && r.data ? r.data : null;
    } catch (e) { return null; }
  }

  /* ================= Xử lý ảnh ================= */
  function grayOf(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }
  // Giãn tương phản theo phân vị 1%–99% (chống ảnh xám nhạt / loá)
  function stretch(g) {
    const hist = new Uint32Array(256); for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const lo_t = g.length * 0.01, hi_t = g.length * 0.99;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lo_t) { lo = v; break; } }
    acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hi_t) { hi = v; break; } }
    if (hi - lo < 16) return g;
    const k = 255 / (hi - lo), out = new Uint8ClampedArray(g.length);
    for (let i = 0; i < g.length; i++) out[i] = (g[i] - lo) * k;
    return out;
  }
  // Unsharp mask: out = g + amount * (g - blur3x3(g))
  function sharpen(g, w, h, amount) {
    const out = new Uint8ClampedArray(g.length);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const s = g[y0 * w + x0] + g[y0 * w + x] + g[y0 * w + x1] + g[y * w + x0] + g[y * w + x] + g[y * w + x1] +
                  g[y1 * w + x0] + g[y1 * w + x] + g[y1 * w + x1];
        const c = g[y * w + x];
        out[y * w + x] = c + amount * (c - s / 9);
      }
    }
    return out;
  }
  function putGray(canvas, g, w, h) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const im = ctx.createImageData(w, h), d = im.data;
    for (let i = 0, j = 0; j < g.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = g[j]; d[i + 3] = 255; }
    ctx.putImageData(im, 0, 0);
    return canvas;
  }
  // Độ nét (0–1): phân vị 98% độ dốc cạnh chia cho dải tương phản.
  // Cạnh nét → độ dốc gần bằng cả dải sáng-tối; ảnh mờ → cạnh thoải, điểm thấp. Ít nhạy với nhiễu.
  function sharpness(g, w, h) {
    const hist = new Uint32Array(256), gh = new Uint32Array(512); let n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; hist[g[i]]++;
      // trung bình 2 điểm để triệt nhiễu điểm ảnh
      const gx = Math.abs((g[i + 1] + g[i + 1 + w]) - (g[i - 1] + g[i - 1 + w])) >> 1;
      const gy = Math.abs((g[i + w] + g[i + w + 1]) - (g[i - w] + g[i - w + 1])) >> 1;
      gh[Math.min(511, gx + gy)]++; n++;
    }
    if (!n) return 0;
    const pct = (H, q) => { let acc = 0, t = n * q; for (let v = 0; v < H.length; v++) { acc += H[v]; if (acc >= t) return v; } return H.length - 1; };
    const range = pct(hist, 0.99) - pct(hist, 0.01);
    if (range < 24) return 0;
    return pct(gh, 0.98) / range;
  }
  const TMP = document.createElement('canvas');
  function enhanced(src, dst, amount, scale) {
    const sctx = src.getContext('2d', { willReadFrequently: true });
    let w = src.width, h = src.height, g = grayOf(sctx, w, h);
    if (scale && scale !== 1) {
      const tmp = putGray(TMP, g, w, h);
      const W = Math.round(w * scale), H = Math.round(h * scale);
      dst.width = W; dst.height = H;
      const c = dst.getContext('2d', { willReadFrequently: true });
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(tmp, 0, 0, W, H);
      w = W; h = H; g = grayOf(c, w, h);
    }
    g = stretch(g);
    if (amount) g = sharpen(g, w, h, amount);
    return putGray(dst, g, w, h);
  }

  /* ================= Quét trực tiếp từ camera ================= */
  const SHARP_MIN = 0.70; // dưới ngưỡng này coi là mờ (hiệu chỉnh bằng ảnh thử)
  const RES = { '1080': [1920, 1080], '1440': [2560, 1440], '2160': [3840, 2160] };

  class LiveScanner {
    constructor(opts) {
      this.video = opts.video;          // <video>
      this.guide = opts.guide;          // phần tử khung ngắm
      this.onResult = opts.onResult;
      this.onStatus = opts.onStatus || (() => {});
      this.onCaps = opts.onCaps || (() => {});
      this.crop = document.createElement('canvas');
      this.work = document.createElement('canvas');
      this.running = false; this.frame = 0; this.dzoom = 1;
      this.blurSince = 0; this.lastRefocus = 0;
      getBD(); getZX(); loadZW();
      DIAG.decoders.jsQR = typeof global.jsQR === 'function' ? 'sẵn sàng' : 'thiếu';
    }

    async start({ deviceId, res = '1440', zoom } = {}) {
      this.stop();
      const [W, H] = RES[res] || RES['1440'];
      const base = { width: { ideal: W }, height: { ideal: H }, frameRate: { ideal: 30 } };
      const tries = [
        deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } },
        { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        { facingMode: 'environment' }, true
      ];
      let err;
      for (const v of tries) {
        try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: v }); break; }
        catch (e) { err = e; if (e && e.name === 'NotAllowedError') break; }
      }
      if (!this.stream) { derr('getUserMedia', err); throw err || new Error('Không mở được camera'); }

      this.track = this.stream.getVideoTracks()[0];
      this.video.srcObject = this.stream;
      this.video.setAttribute('playsinline', ''); this.video.muted = true;
      await this.video.play().catch(() => {});
      await new Promise(r => { if (this.video.readyState >= 2) r(); else this.video.onloadeddata = () => r(); setTimeout(r, 2500); });

      // Năng lực phần cứng
      const caps = (this.track.getCapabilities && this.track.getCapabilities()) || {};
      this.caps = caps;
      const adv = {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
      if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
      if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
      if (Object.keys(adv).length) { try { await this.track.applyConstraints({ advanced: [adv] }); } catch (e) {} }

      this.hwZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
      const zr = this.zoomRange();
      const z0 = zoom != null ? zoom : Math.min(zr.max, this.hwZoom ? 2 : 1);
      await this.setZoom(z0);

      const st = this.track.getSettings ? this.track.getSettings() : {};
      DIAG.camera = {
        label: this.track.label, video: this.video.videoWidth + '×' + this.video.videoHeight,
        zoom: this.hwZoom ? `${this.hwZoom.min}–${this.hwZoom.max}` : 'không (dùng zoom số)',
        torch: !!caps.torch, focusModes: (caps.focusMode || []).join(',') || 'không báo',
        requested: res + (deviceId ? ' / chọn tay' : ' / mặc định')
      };
      // iPhone: camera ảo "Dual Wide / Triple" tự chuyển sang ống siêu rộng khi ở gần (macro) → lấy nét gần tốt hơn
      if (IS_IOS && !deviceId && !this._triedMacro) {
        this._triedMacro = true;
        const cams = await this.cameras();
        DIAG.camera.all = cams.map(c => c.label || '?').join(' | ');
        const macro = cams.find(c => /dual wide|triple|kép|bộ ba|ba ống/i.test(c.label || ''));
        if (macro && macro.label !== this.track.label) {
          DIAG.camera.autoMacro = macro.label;
          return this.start({ deviceId: macro.deviceId, res, zoom });
        }
      }
      this.onCaps({
        zoom: zr, zoomValue: this.zoomValue,
        torch: !!caps.torch, focus: !!(caps.focusMode && caps.focusMode.length),
        width: this.video.videoWidth || st.width, height: this.video.videoHeight || st.height,
        deviceId: st.deviceId, photo: 'ImageCapture' in global
      });

      this.running = true; this.frame = 0; this.blurSince = 0;
      this.loop();
    }

    stop() {
      this.running = false; clearTimeout(this.timer);
      if (this.stream) this.stream.getTracks().forEach(t => t.stop());
      this.stream = null; this.track = null; this.torchOn = false;
      if (this.video) { this.video.srcObject = null; this.video.style.transform = ''; }
    }

    zoomRange() {
      if (this.hwZoom) return { min: this.hwZoom.min, max: Math.min(this.hwZoom.max, 10), step: this.hwZoom.step || 0.1, hw: true };
      return { min: 1, max: 4, step: 0.1, hw: false };
    }
    async setZoom(v) {
      const r = this.zoomRange(); v = Math.max(r.min, Math.min(r.max, +v || 1));
      this.zoomValue = v;
      if (this.hwZoom) {
        try { await this.track.applyConstraints({ advanced: [{ zoom: v }] }); this.dzoom = 1; this.video.style.transform = ''; return v; }
        catch (e) { this.hwZoom = null; }
      }
      this.dzoom = v; this.video.style.transform = v > 1 ? `scale(${v})` : '';
      return v;
    }
    async setTorch(on) {
      if (!this.track || !this.caps || !this.caps.torch) return false;
      try { await this.track.applyConstraints({ advanced: [{ torch: !!on }] }); this.torchOn = !!on; } catch (e) {}
      return this.torchOn;
    }
    // Chạm để lấy nét (Android Chrome); nơi khác: kích lại lấy nét tự động
    async focusAt(nx, ny) {
      if (!this.track) return;
      const c = this.caps || {};
      try {
        const a = {};
        if (c.focusMode && c.focusMode.includes('single-shot')) a.focusMode = 'single-shot';
        a.pointsOfInterest = [{ x: nx, y: ny }];
        await this.track.applyConstraints({ advanced: [a] });
      } catch (e) {}
      await this.refocus(900);
    }
    async refocus(delay = 0) {
      const c = this.caps || {}; this.lastRefocus = performance.now();
      if (!c.focusMode || !this.track) return;
      const t = this.track;
      setTimeout(async () => {
        try {
          if (c.focusMode.includes('single-shot')) await t.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
          if (c.focusMode.includes('continuous')) await t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) {}
      }, delay);
    }

    // Vùng khung ngắm quy đổi sang toạ độ gốc của video (object-fit: cover + zoom số)
    roi() {
      const v = this.video, vw = v.videoWidth, vh = v.videoHeight;
      if (!vw || !vh) return null;
      const vr = v.getBoundingClientRect(), gr = this.guide.getBoundingClientRect();
      // getBoundingClientRect của video đã bao gồm transform scale → dùng kích thước bố cục gốc
      const cw = v.offsetWidth, ch = v.offsetHeight;
      const scale = Math.max(cw / vw, ch / vh) * this.dzoom;
      const cx = vr.left + vr.width / 2, cy = vr.top + vr.height / 2;
      const margin = 1.25; // lấy rộng hơn khung một chút
      const gw = gr.width * margin, gh = gr.height * margin;
      const gx = gr.left + gr.width / 2, gy = gr.top + gr.height / 2;
      let w = gw / scale, h = gh / scale;
      let x = vw / 2 + (gx - cx) / scale - w / 2, y = vh / 2 + (gy - cy) / scale - h / 2;
      x = Math.max(0, x); y = Math.max(0, y); w = Math.min(w, vw - x); h = Math.min(h, vh - y);
      return { x, y, w, h };
    }

    grab() {
      const r = this.roi(); if (!r || r.w < 20) return null;
      // Giữ nguyên độ phân giải gốc; phóng to nếu vùng quá nhỏ, thu nhỏ nếu quá lớn
      const maxSide = 1100, minSide = 640, side = Math.max(r.w, r.h);
      const k = side > maxSide ? maxSide / side : side < minSide ? minSide / side : 1;
      const W = Math.round(r.w * k), H = Math.round(r.h * k);
      const c = this.crop; c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = k > 1; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, W, H);
      return { canvas: c, native: side };
    }

    win(name) { DIAG.live.wins[name] = (DIAG.live.wins[name] || 0) + 1; DIAG.live.lastWin = name; DIAG.live.lastFrame = this.frame; }

    async loop() {
      if (!this.running) return;
      const t0 = performance.now();
      let text = null;
      if (!this.paused) { try { text = await this.tick(); DIAG.live.frames++; } catch (e) { derr('tick', e); } }
      if (!this.running) return;
      if (text) {
        if (DIAG.live.lastFrame !== this.frame) this.win(this._strat || '?');
        this.running = false; this.onResult(fixEncoding(text)); return;
      }
      this.timer = setTimeout(() => this.loop(), Math.max(0, 35 - (performance.now() - t0)));
    }

    async tick() {
      if (this.video.readyState < 2) return null;
      const g = this.grab(); if (!g) return null;
      const c = g.canvas, f = this.frame++; this._strat = null;

      // Độ nét (mỗi 3 khung) → trạng thái + tự kích lấy nét lại
      if (f % 3 === 0) {
        const sw = Math.min(320, c.width), sh = Math.round(c.height * sw / c.width);
        const small = this.work; small.width = sw; small.height = sh;
        const sctx = small.getContext('2d', { willReadFrequently: true }); sctx.drawImage(c, 0, 0, sw, sh);
        const s = sharpness(grayOf(sctx, sw, sh), sw, sh);
        DIAG.live.sharpSum += s; DIAG.live.sharpN++; DIAG.live.roi = c.width + '×' + c.height + ' (gốc ' + Math.round(g.native) + ' px)';
        const now = performance.now(), blurry = s < SHARP_MIN;
        if (blurry) { if (!this.blurSince) this.blurSince = now; } else this.blurSince = 0;
        this.onStatus(blurry ? (this.blurSince && now - this.blurSince > 1500 ? 'blur-long' : 'blur') : 'ok', { sharpness: s, native: g.native });
        if (blurry && this.blurSince && now - this.blurSince > 2500 && now - this.lastRefocus > 3000) this.refocus();
      }

      // Thỉnh thoảng dò mã trên TOÀN khung hình (khi người dùng ngắm lệch khung)
      if (f % 7 === 6) {
        this._strat = 'toàn khung';
        const v = this.video, W = v.videoWidth, H = v.videoHeight;
        const cand = textureCandidates(v, W, H).slice(0, 2);
        for (const c of cand) {
          const pad = c.s * 0.15, x = Math.max(0, c.x - pad), y = Math.max(0, c.y - pad);
          const sz = Math.min(c.s + 2 * pad, W - x, H - y);
          const t = await decodeRegion(v, x, y, sz, sz, 800, 0); if (t) return t;
        }
        return null;
      }

      // 1) Bộ giải mã gốc của máy — nhanh, chạy mọi khung
      const hasBD = !!(await getBD());
      let t = hasBD ? await tryBD(c) : null; if (t) { this.win('BarcodeDetector'); return t; }

      // 1b) zxing-wasm (C++) — chạy mọi khung khi không có BD; khử nhiễu ở khung lẻ
      if (zw && (!hasBD || f % 3 === 1)) {
        t = await tryZW(imageDataOf(c), f % 2 === 1); if (t) { this.win('zxing-wasm'); return t; }
        if (!hasBD && f % 2 === 0) return null; // nhường thời gian cho khung sau
      }

      // 2) Giải mã JS luân phiên chiến lược (mỗi khung một chiến lược, khi có BD thì cách khung)
      if (hasBD && f % 2) return null;
      const strategies = hasBD
        ? ['tight', 'bd-enh', 'zx-enh', 'tight2', 'jsqr-enh']
        : ['tight', 'zx-raw', 'tight2', 'zx-enh', 'tight', 'jsqr-enh', 'tight2', 'zx-up'];
      const s = strategies[Math.floor(f / (hasBD ? 2 : 1)) % strategies.length];
      this._strat = 'JS:' + s;
      const w = this.work;
      switch (s) {
        // Khoanh sát vùng có mật độ chi tiết cao nhất trong khung rồi phóng to → mỗi ô mã nhiều điểm ảnh hơn
        case 'tight': case 'tight2': {
          const cs = textureCandidates(c, c.width, c.height), pick = s === 'tight' ? cs.slice(0, 1) : cs.slice(1, 3);
          for (const q of pick) {
            const pad = q.s * 0.15, x = Math.max(0, q.x - pad), y = Math.max(0, q.y - pad);
            const sz = Math.min(q.s + 2 * pad, c.width - x, c.height - y);
            const t = await decodeRegion(c, x, y, sz, sz, 800, s === 'tight2' ? 1 : 0); if (t) return t;
          }
          return null;
        }
        case 'zx-raw':   return tryZX(c);
        case 'jsqr-raw': return tryJsQR(c, false);
        case 'zx-enh':   return tryZX(enhanced(c, w, 1.2));
        case 'zx-enh2':  return tryZX(enhanced(c, w, 2.2));
        case 'bd-enh':   return tryBD(enhanced(c, w, 1.5));
        case 'jsqr-enh': return tryJsQR(enhanced(c, w, 1.5), false);
        case 'zx-up':    return tryZX(enhanced(c, w, 1.0, c.width < 900 ? 1.5 : 1));
      }
      return null;
    }

    // Chụp ảnh tĩnh độ phân giải tối đa (Android Chrome) rồi quét kỹ
    async takePhoto(onProgress) {
      if (!this.track || !('ImageCapture' in global)) return null;
      const wasTorch = this.torchOn;
      this.paused = true;
      let blob;
      try {
        const ic = new global.ImageCapture(this.track);
        let opts = {};
        try { const pc = await ic.getPhotoCapabilities(); if (pc && pc.imageWidth) opts = { imageWidth: pc.imageWidth.max }; } catch (e) {}
        if (wasTorch) opts.fillLightMode = 'flash';
        blob = await ic.takePhoto(opts);
      } catch (e) { this.paused = false; return null; }
      if (wasTorch) this.setTorch(true);
      try { return await decodeImage(blob, onProgress); } finally { this.paused = false; }
    }

    async cameras() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        return list.filter(d => d.kind === 'videoinput');
      } catch (e) { return []; }
    }
  }

  /* ================= Quét ảnh tĩnh ================= */
  async function loadBitmap(src) {
    if (global.createImageBitmap) {
      try { return await createImageBitmap(src, { imageOrientation: 'from-image' }); } catch (e) {}
      try { return await createImageBitmap(src); } catch (e) {}
    }
    const url = URL.createObjectURL(src);
    try {
      const img = new Image(); img.src = url; await img.decode();
      return img;
    } catch (e) {
      const heic = /hei[cf]/i.test((src && src.type) || '') || /\.hei[cf]$/i.test((src && src.name) || '');
      const err = new Error(heic ? 'HEIC' : 'IMAGE');
      err.code = heic ? 'HEIC' : 'IMAGE';
      throw err;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  const sleep0 = () => new Promise(r => setTimeout(r, 0));
  const MAX_SIDE = 4096, MAX_AREA = 16000000;
  async function safe(fn) { try { return await fn(); } catch (e) { return null; } }
  const cA = document.createElement('canvas'), cB = document.createElement('canvas');

  // level 0: nhanh (BD + ZXing + ZXing làm nét); level 1: kỹ (thêm jsQR, làm nét mạnh)
  async function decodeRegion(img, x, y, w, h, target, level) {
    const k = target / Math.max(w, h);
    cA.width = Math.round(w * k); cA.height = Math.round(h * k);
    const ctx = cA.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h, 0, 0, cA.width, cA.height);
    let t = zw ? await tryZW(imageDataOf(cA), level > 0) : null; if (t) return t;
    t = await tryBD(cA); if (t) return t;
    t = await tryZX(cA); if (t) return t;
    enhanced(cA, cB, 1.5);
    t = await tryBD(cB); if (t) return t;
    t = await tryZX(cB); if (t) return t;
    t = tryJsQR(cB, !!level); if (t) return t;
    if (level) {
      t = await tryZX(enhanced(cA, cB, 2.5)); if (t) return t;
    }
    return null;
  }

  // Tìm các vùng có mật độ chi tiết cao (đặc trưng của mã QR) trên ảnh thu nhỏ
  function textureCandidates(img, W, H) {
    const k = Math.min(1, 480 / Math.max(W, H)), w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    cA.width = w; cA.height = h;
    const ctx = cA.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
    const g = grayOf(ctx, w, h);
    // ảnh tích phân của độ lớn gradient
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = x < w - 1 ? Math.abs(g[i + 1] - g[i]) : 0, gy = y < h - 1 ? Math.abs(g[i + w] - g[i]) : 0;
        row += gx + gy;
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    const sum = (x, y, s) => I[(y + s) * (w + 1) + x + s] - I[y * (w + 1) + x + s] - I[(y + s) * (w + 1) + x] + I[y * (w + 1) + x];
    const m = Math.min(w, h), out = [];
    for (const f of [0.5, 0.36, 0.26, 0.18, 0.12]) {
      const s = Math.max(6, Math.round(m * f)), step = Math.max(2, Math.round(s / 5)), cand = [];
      for (let y = 0; y + s <= h; y += step) for (let x = 0; x + s <= w; x += step) cand.push({ x, y, s, v: sum(x, y, s) / (s * s) });
      cand.sort((a, b) => b.v - a.v);
      const picked = [];
      for (const c of cand) {
        if (picked.length >= 3) break;
        if (picked.some(p => Math.abs(p.x - c.x) < s * 0.6 && Math.abs(p.y - c.y) < s * 0.6)) continue;
        picked.push(c);
      }
      picked.forEach((c, i) => out.push({ x: c.x / k, y: c.y / k, s: c.s / k, v: c.v, rank: i, f }));
    }
    // vùng mạnh nhất của từng cỡ trước, sau đó hạng 2, hạng 3
    out.sort((a, b) => a.rank - b.rank || b.v - a.v);
    return out;
  }

  async function decodeImage(src, onProgress, budgetMs) {
    let img;
    try { img = await loadBitmap(src); }
    catch (e) { DIAG.image.unshift({ file: (src && src.type) + ', ' + Math.round((src && src.size || 0) / 1024) + ' KB', result: 'lỗi mở ảnh: ' + (e.code || e.message) }); throw e; }
    const W = img.width || img.naturalWidth, H = img.height || img.naturalHeight;
    const p = onProgress || (() => {}), t0 = performance.now(), deadline = t0 + (budgetMs || 15000);
    const log = { file: (src && src.type || '?') + ', ' + Math.round((src && src.size || 0) / 1024) + ' KB', size: W + '×' + H, steps: [] };
    DIAG.image.unshift(log); if (DIAG.image.length > 3) DIAG.image.pop();
    const done = (t, how) => { log.result = how; log.ms = Math.round(performance.now() - t0); return fixEncoding(t); };
    let t;

    // 0) zxing-wasm trên ảnh thu về ≤ 3000 px (C++ tự dò nhiều tỉ lệ), rồi trên các vùng nghi là QR
    p(0.01);
    const Z = await loadZW(8000);
    log.steps.push('zxing-wasm: ' + (Z ? 'có' : (DIAG.decoders.zxingWasm || 'không')));
    if (Z) {
      const k = Math.min(1, 3000 / Math.max(W, H));
      cA.width = Math.round(W * k); cA.height = Math.round(H * k);
      const zctx = cA.getContext('2d', { willReadFrequently: true });
      if (zctx) {
        zctx.drawImage(img, 0, 0, cA.width, cA.height);
        t = await tryZW(imageDataOf(cA), false); if (t) return done(t, 'zxing-wasm toàn ảnh');
        t = await tryZW(imageDataOf(cA), true); if (t) return done(t, 'zxing-wasm toàn ảnh + khử nhiễu');
      } else log.steps.push('canvas toàn ảnh: lỗi');
      t = await safe(() => decodeRegion(img, 0, 0, W, H, Math.min(1600, Math.max(W, H)), 0)); if (t) return done(t, 'ZXing/jsQR toàn ảnh');
      const zc = (await safe(() => textureCandidates(img, W, H))) || [];
      for (let i = 0; i < Math.min(zc.length, 9) && performance.now() < deadline; i++) {
        const c = zc[i], pad = c.s * 0.2, x = Math.max(0, c.x - pad), y = Math.max(0, c.y - pad);
        const sz = Math.min(c.s + 2 * pad, W - x, H - y), kk = 1000 / sz;
        cA.width = Math.round(sz * kk); cA.height = Math.round(sz * kk);
        const cc = cA.getContext('2d', { willReadFrequently: true }); if (!cc) break;
        cc.imageSmoothingQuality = 'high'; cc.drawImage(img, x, y, sz, sz, 0, 0, cA.width, cA.height);
        p(0.02 + 0.2 * i / 9);
        t = await tryZW(imageDataOf(cA), i % 2 === 1); if (t) return done(t, 'zxing-wasm vùng #' + (i + 1));
      }
      log.steps.push('zxing-wasm: không đọc được');
    }

    // 1) Toàn ảnh
    p(0.02);
    // Safari iOS giới hạn canvas ~16,7 MP (ảnh iPhone 24/48 MP vượt mức) → luôn thu về tối đa 4096 px/cạnh
    log.steps.push('BarcodeDetector: ' + (bd ? 'có' : 'không'));
    if (await getBD()) {
      const k = Math.min(1, MAX_SIDE / Math.max(W, H), Math.sqrt(MAX_AREA / (W * H)));
      cA.width = Math.round(W * k); cA.height = Math.round(H * k);
      const fctx = cA.getContext('2d');
      if (fctx) { fctx.drawImage(img, 0, 0, cA.width, cA.height); t = await tryBD(cA); if (t) return done(t, 'BarcodeDetector toàn ảnh'); }
    }
    t = await safe(() => decodeRegion(img, 0, 0, W, H, Math.min(1600, Math.max(W, H)), 0)); if (t) return done(t, 'ZXing/jsQR toàn ảnh');

    // 2) Vùng nghi là QR (theo mật độ chi tiết), có lề 15%
    const cands = (await safe(() => textureCandidates(img, W, H))) || [];
    for (let i = 0; i < cands.length && performance.now() < deadline; i++) {
      const c = cands[i], pad = c.s * 0.15;
      const x = Math.max(0, c.x - pad), y = Math.max(0, c.y - pad);
      const s = Math.min(c.s + 2 * pad, W - x, H - y);
      p(0.05 + 0.6 * i / cands.length);
      t = await safe(() => decodeRegion(img, x, y, s, s, 900, 1)); if (t) return done(t, 'ZXing/jsQR vùng nghi QR');
      await sleep0();
    }

    // 3) Dự phòng: lưới cửa sổ trượt, giới hạn thời gian
    const m = Math.min(W, H), wins = [];
    for (const f of [0.55, 0.38, 0.27]) {
      const s = Math.round(m * f), step = Math.round(s / 2);
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        const xx = Math.max(0, Math.min(x, W - s)), yy = Math.max(0, Math.min(y, H - s));
        wins.push({ x: xx, y: yy, s, f, pri: Math.hypot((xx + s / 2) / W - 0.5, (yy + s / 2) / H - 0.5) });
      }
    }
    wins.sort((a, b) => b.f - a.f || a.pri - b.pri);
    const seen = new Set();
    for (let i = 0; i < wins.length && performance.now() < deadline; i++) {
      const w = wins[i], key = w.x + ',' + w.y + ',' + w.s; if (seen.has(key)) continue; seen.add(key);
      p(0.65 + 0.35 * i / wins.length);
      t = await safe(() => decodeRegion(img, w.x, w.y, w.s, w.s, 900, 0)); if (t) return done(t, 'ZXing/jsQR lưới');
      await sleep0();
    }
    if (img.close) try { img.close(); } catch (e) {}
    log.result = 'không tìm thấy'; log.ms = Math.round(performance.now() - t0);
    cA.width = cA.height = 1; cB.width = cB.height = 1; // giải phóng bộ nhớ canvas (quan trọng trên iOS)
    return null;
  }

  function report() {
    const L = DIAG.live, lines = [];
    lines.push('Phiên bản app: ' + VERSION);
    lines.push('Trình duyệt: ' + UA);
    lines.push('iOS: ' + (IS_IOS ? 'có' : 'không') + ' · Màn hình: ' + screen.width + '×' + screen.height + ' @' + (global.devicePixelRatio || 1));
    lines.push('— Bộ giải mã —');
    lines.push('  zxing-wasm: ' + (DIAG.decoders.zxingWasm || 'chưa tải'));
    lines.push('  BarcodeDetector: ' + (DIAG.decoders.barcodeDetector || '?'));
    lines.push('  ZXing JS: ' + (DIAG.decoders.zxingJs || '?') + ' · jsQR: ' + (typeof global.jsQR === 'function' ? 'sẵn sàng' : 'thiếu'));
    lines.push('— Camera —');
    const C = DIAG.camera;
    if (C.label) {
      lines.push('  Đang dùng: ' + C.label + ' · ' + C.video + ' · yêu cầu ' + C.requested);
      lines.push('  Zoom: ' + C.zoom + ' · Đèn: ' + (C.torch ? 'có' : 'không') + ' · Lấy nét: ' + C.focusModes);
      if (C.all) lines.push('  Các camera: ' + C.all);
      if (C.autoMacro) lines.push('  Tự chọn camera macro: ' + C.autoMacro);
      lines.push('  Khung đã xử lý: ' + L.frames + ' · Vùng quét: ' + (L.roi || '?') +
        ' · Độ nét TB: ' + (L.sharpN ? (L.sharpSum / L.sharpN).toFixed(2) : '?') + ' (≥ ' + SHARP_MIN + ' là nét)');
      lines.push('  Đọc được bằng: ' + (Object.keys(L.wins).length ? JSON.stringify(L.wins) : 'chưa lần nào'));
    } else lines.push('  Chưa bật camera trong lần mở app này');
    lines.push('— Quét ảnh gần đây —');
    if (!DIAG.image.length) lines.push('  Chưa quét ảnh nào');
    DIAG.image.forEach((x, i) => lines.push(`  #${i + 1}: ${x.file} · ${x.size || '?'} · ${x.result || 'đang chạy'}${x.ms != null ? ' · ' + x.ms + ' ms' : ''}` +
      (x.steps && x.steps.length ? '\n      ' + x.steps.join(' | ') : '')));
    if (DIAG.errors.length) { lines.push('— Lỗi —'); DIAG.errors.forEach(e => lines.push('  ' + e)); }
    return lines.join('\n');
  }

  global.QRScan = { LiveScanner, decodeImage, fixEncoding, report, loadZW, VERSION, IS_IOS, _test: { enhanced, sharpness } };
})(window);
