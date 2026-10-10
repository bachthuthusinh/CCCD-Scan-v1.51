# Quét QR Căn cước (CCCD)

© 2026 **Thanh Nguyen**. Bảo lưu mọi quyền — xem [LICENSE](LICENSE).

Ứng dụng web chạy trên điện thoại/máy tính để quét mã QR trên thẻ Căn cước công dân / Căn cước, tách ra các trường thông tin, rồi:

- **Lưu vào Google Sheet** (qua Google Apps Script), hoặc
- **Copy trực tiếp** — copy từng trường, copy cả dòng (dán thẳng vào Google Sheet/Excel), copy chuỗi gốc.
- **Dán nội dung thủ công** (một hoặc nhiều dòng) để phân tích và lưu về Sheet.

Không cần cài đặt: mở link là dùng được. Có thể "Thêm vào màn hình chính" để dùng như app.

## Tính năng

| Tính năng | Ghi chú |
|---|---|
| Quét bằng camera | Tối ưu cho QR nhỏ, mờ trên CCCD (xem bên dưới), tự dừng khi đọc được mã |
| Chụp bằng camera máy | Mở app camera gốc (lấy nét tốt hơn), tự tìm mã trong ảnh |
| Quét từ ảnh | Chọn ảnh có sẵn; tự dò vùng chứa mã, kể cả mã rất nhỏ trong ảnh lớn |
| Dán tay | Dán chuỗi QR, nhiều dòng = nhiều người; nội dung khác vẫn lưu nguyên văn |
| Sửa trước khi lưu | Các trường kết quả có thể chỉnh trực tiếp |
| Copy | Từng trường, cả dòng (định dạng tab cho Sheet), văn bản, chuỗi gốc |
| Google Sheet | Ghi vào **một Sheet cố định** do quản trị cấu hình trong `config.js`; người dùng không đổi được. Lưu thủ công hoặc tự động |
| Lịch sử | Lưu trên máy, đánh dấu đã/chưa lưu, gửi lại, copy tất cả, tải CSV |
| Cảnh báo trùng | Báo khi quét lại số CCCD đã có trong lịch sử |

## Tối ưu quét QR nhỏ & mờ

- **Camera độ phân giải cao** (1080p / 1440p / 4K, chọn trong Cài đặt), lấy nét – phơi sáng liên tục.
- **Zoom** bằng thanh trượt, nút +/− hoặc chụm hai ngón (zoom quang nếu máy hỗ trợ, nếu không thì zoom số). Mẹo: giữ máy cách thẻ ~20 cm rồi zoom 2–3× — camera không lấy nét được khi áp sát.
- **Chạm để lấy nét**, **đèn flash**, **chọn camera** (máy nhiều ống kính).
- **Báo ảnh mờ**: khung chuyển vàng khi ảnh mờ; mờ lâu thì tự kích lấy nét lại.
- **Cắt vùng khung ngắm ở độ phân giải gốc**, tự khoanh sát vùng mã rồi phóng to, tăng tương phản và làm nét trước khi giải mã.
- **Bốn bộ giải mã**: BarcodeDetector của máy (Android Chrome) → **zxing-wasm** (lõi ZXing C++, tải từ jsDelivr khi mở app; quan trọng nhất trên iPhone vì Safari/Chrome iOS không có bộ đọc QR gốc) → ZXing JS → jsQR. Không tải được zxing-wasm thì tự dùng các bộ còn lại.
- **iPhone**: tự ưu tiên camera ảo “Dual Wide/Triple” (nếu trình duyệt liệt kê) để có lấy nét cận/macro.
- **Chẩn đoán** (tab Cài đặt): phiên bản app, bộ giải mã nào đang chạy, thông số camera, kết quả từng lần quét — bấm *Copy chẩn đoán* để gửi hỗ trợ.
- **Dò mã trên toàn khung hình** định kỳ — ngắm lệch khung vẫn đọc được.
- **Chụp nét** (Android Chrome): chụp ảnh tĩnh độ phân giải tối đa của cảm biến rồi quét kỹ.

Kiểm thử trên ảnh thẻ giả lập (QR 160–260 px trong khung 1920×1080, tương phản thấp, có nhiễu): bộ quét mới đọc được 7/12 mức mờ, bộ quét mặc định của html5-qrcode đọc 0/12.

## Định dạng QR CCCD

```
Số CCCD|Số CMND cũ|Họ và tên|Ngày sinh(ddmmyyyy)|Giới tính|Nơi thường trú|Ngày cấp(ddmmyyyy)
```

Các trường thêm (nếu thẻ có) được ghi vào cột **Thông tin thêm**.

Cột trong Google Sheet: `Thời gian quét | Số CCCD | Số CMND cũ | Họ và tên | Ngày sinh | Giới tính | Nơi thường trú | Ngày cấp | Thông tin thêm | Dữ liệu gốc | Nguồn`

## Cấu hình Google Sheet (dành cho quản trị)

Ứng dụng chỉ ghi vào **một Google Sheet duy nhất** được khai báo trong `config.js`. Màn hình Cài đặt không còn ô nhập link, nên người dùng không thể nối sang Sheet khác.

1. Tạo Google Sheet → **Tiện ích mở rộng → Apps Script** → dán toàn bộ [`apps-script/Code.gs`](apps-script/Code.gs).
2. Sửa dòng `const TOKEN = '…'` thành một chuỗi bí mật **dài ≥ 16 ký tự** (bắt buộc) → **Lưu**.
3. **Triển khai → Tùy chọn triển khai mới → Ứng dụng web** — Thực thi với tư cách: **Tôi**; Người có quyền truy cập: **Bất kỳ ai** → cấp quyền → copy URL `…/exec`.
4. Mở `config.js` (trên GitHub: bấm vào file → biểu tượng ✏️) và điền:
   ```js
   SHEET_URL: 'https://script.google.com/macros/s/…/exec',
   SHEET_KEY: 'chuỗi bí mật giống TOKEN'
   ```
   → **Commit changes**.
5. Mở app → **Cài đặt** → **Kiểm tra kết nối** (chỉ kiểm tra, không ghi dòng nào vào Sheet).

Phía máy chủ (Apps Script) cố định tên trang `CCCD` và tiêu đề cột, bắt buộc mã bảo mật, tối đa 200 dòng/lần, cắt ô quá 1000 ký tự, chặn công thức.

> Mỗi lần sửa `Code.gs`: **Triển khai → Quản lý triển khai → ✏️ → Phiên bản mới**. URL giữ nguyên.

**Giới hạn cần biết:** trang web chạy hoàn toàn trên trình duyệt, nên URL và mã bảo mật trong `config.js` vẫn có thể bị người rành kỹ thuật đọc được từ mã nguồn trang. Cấu hình này ngăn người dùng nối app sang Sheet của họ, và ngăn người lạ ghi vào Sheet nếu không có mã. Nhưng nó không giấu được mã khỏi người cố tình xem mã nguồn. Nếu nghi bị lộ, đổi `TOKEN` + `SHEET_KEY` và triển khai phiên bản mới.

## Chạy cục bộ

Camera chỉ hoạt động trên HTTPS hoặc `localhost`:

```bash
python3 -m http.server 8080
# mở http://localhost:8080
```

## Bảo mật & dữ liệu cá nhân

- Ứng dụng không có máy chủ riêng; dữ liệu chỉ đi từ trình duyệt tới Google Sheet của bạn.
- Lịch sử lưu trong trình duyệt (localStorage) — xoá bằng nút **Xoá lịch sử**.
- Thông tin CCCD là dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP). Chỉ thu thập khi có sự đồng ý của chủ thẻ, giới hạn quyền truy cập Google Sheet, và đặt `TOKEN` dài, khó đoán để tránh người lạ ghi dữ liệu.

## Cấu trúc

```
index.html            Giao diện ứng dụng
config.js             Link Google Sheet cố định + mã bảo mật (quản trị điền)
scanner.js            Bộ quét QR tối ưu (camera, xử lý ảnh, giải mã)
apps-script/Code.gs   Mã Google Apps Script ghi vào Sheet
sw.js, manifest.webmanifest, icon.svg   Cài như app (PWA)
```

Thư viện giải mã đóng gói sẵn trong `vendor/`: [html5-qrcode](https://github.com/mebjas/html5-qrcode) v2.3.8 (ZXing, Apache-2.0) và [jsQR](https://github.com/cozmo/jsQR) (Apache-2.0).
