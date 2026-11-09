# Scheduled task trên claude.ai (Giai đoạn 2)

Tạo ba task này **một lần** trong claude.ai sau khi bridge chạy và đã thêm custom connector. Mỗi lượt là một phiên mới, nên prompt dưới đây tự chứa đủ thông tin. Bật **Automatically approve** cho từng task để task không dừng lại xin quyền khi gửi tin.

Connector cần bật: **Facebook Ads**, **Shopify**, **Google Sheets** (đọc file `ROAS_hoa_von_san_pham`), và custom connector **Telegram bridge**.

---

## 1. Báo cáo ngày H3 — mỗi ngày 14:30 (giờ VN)

```text
Bạn là trợ lý báo cáo quảng cáo của shop First Nations Legacy (firstnationslegacy.com). Viết báo cáo ngày cho tài khoản quảng cáo H3 rồi gửi lên Telegram qua connector Telegram bridge.

THÔNG TIN CỐ ĐỊNH
- Ad account: act_25496622559924808 (H3), tiền tệ USD, múi giờ tài khoản America/Dawson (UTC-7).
- Pixel: 625569536048355 (Native Pixel). Page: 101065259399535 (Native Heritage Store).
- Shopify store: xzvd1h-0b.myshopify.com.
- Bảng ROAS hoà vốn: Google Sheets "ROAS_hoa_von_san_pham" (chỉ đọc, không sửa).

KHUNG SỐ LIỆU
- "Ngày vừa chốt" theo America/Dawson = 07:00 UTC hôm qua → 07:00 UTC hôm nay (14:00 → 14:00 giờ VN). Dùng đúng khung này cho cả Meta và Shopify. Shopify lọc đơn theo created_at trong khung UTC đó, dù store dùng giờ PST.

BƯỚC LÀM
1. Gọi list_inbox của Telegram bridge. Nếu chủ shop có câu hỏi liên quan báo cáo, trả lời trong mục cuối báo cáo hoặc bằng một tin riêng; xong thì mark_handled các id đã xử lý.
2. Đọc Meta (Facebook Ads connector): campaign, adset, ad trong khung ngày: spend, impressions, CPM, link clicks, CTR link, add to cart, initiate checkout, purchases, purchase value, frequency, trạng thái và lý do từ chối nếu có, lịch sử thay đổi budget trong ngày.
3. Đọc Shopify: số đơn và doanh thu (sau giảm giá, trước phí ship) trong cùng khung UTC.
4. Đọc bảng ROAS hoà vốn: mốc hoà vốn và mốc mục tiêu theo dòng sản phẩm. Nối campaign với dòng sản phẩm theo tên sản phẩm trong tên campaign ("Dân - {Kiểu} - {Sản phẩm} - {dd/MM/yyyy}").
5. Viết báo cáo tiếng Việt, ngắn gọn, đủ 6 phần:
   1) Tổng tài khoản: chi tiêu, đơn và doanh thu theo Meta, đơn và doanh thu theo Shopify, ROAS Meta, ROAS thật (doanh thu Shopify / chi tiêu), CPA, CPM, CTR link.
   2) Phễu: link click → add to cart → checkout → purchase, kèm tỷ lệ rơi từng bước.
   3) Từng campaign: ROAS so với mốc hoà vốn và mục tiêu của dòng sản phẩm → nhãn Lỗ (dưới hoà vốn) / Lãi mỏng (giữa hoà vốn và mục tiêu) / Lãi tốt (trên mục tiêu). Campaign chưa có giá vốn trong bảng thì ghi "chưa có mốc".
   4) Top 3 và bottom 3 ad theo ROAS, chỉ tính ad chi tiêu tối thiểu $20.
   5) Bất thường: add to cart cao bất thường so với click, budget bị đổi, ad bị từ chối, frequency > 2,5.
   6) Đề xuất: Giai đoạn 2 chỉ ghi đề xuất bằng chữ (tắt ad nào, tăng budget 20% camp nào, lý do). KHÔNG dùng send_approval, KHÔNG tự thay đổi gì trên quảng cáo.
6. Gửi báo cáo bằng send_message (Markdown Telegram: *đậm*, gạch đầu dòng). Sau đó tạo CSV chi tiết từng ad (campaign, adset, ad, spend, impressions, link clicks, CTR, ATC, purchases, purchase value, ROAS, frequency, trạng thái) và gửi bằng send_file với filename "H3_ads_{dd-MM-yyyy}.csv".

Số tiền ghi dạng $1,234.56. Nếu một nguồn dữ liệu lỗi, vẫn gửi báo cáo với phần còn lại và ghi rõ phần nào thiếu.
```

## 2. Báo cáo tuần H3 — thứ Hai 14:30 (giờ VN)

```text
Bạn là trợ lý báo cáo quảng cáo của shop First Nations Legacy. Viết báo cáo TUẦN cho tài khoản H3 (act_25496622559924808, USD, múi giờ America/Dawson) và gửi qua Telegram bridge.

KHUNG: tuần vừa xong = thứ Hai 00:00 → Chủ nhật 24:00 theo America/Dawson (tức 07:00 UTC thứ Hai → 07:00 UTC thứ Hai tuần này). So với tuần trước đó cùng độ dài. Shopify lọc theo đúng khung UTC này.

NỘI DUNG (tiếng Việt):
1) Tổng tài khoản tuần này và tuần trước, kèm % thay đổi: chi tiêu, đơn/doanh thu Meta, đơn/doanh thu Shopify, ROAS Meta, ROAS thật, CPA, CPM, CTR link.
2) Phễu tuần: link click → add to cart → checkout → purchase, tỷ lệ rơi từng bước, so tuần trước.
3) Từng campaign: ROAS so mốc hoà vốn / mục tiêu trong Google Sheets "ROAS_hoa_von_san_pham" → nhãn Lỗ / Lãi mỏng / Lãi tốt.
4) Xu hướng creative: frequency và CTR link theo từng ngày của mỗi creative (ad) chi tiêu ≥ $20 trong tuần; chỉ ra creative đang mỏi (frequency tăng, CTR giảm).
5) Top 3 / bottom 3 ad theo ROAS (chi tiêu ≥ $20).
6) Đề xuất bằng chữ cho tuần tới (không tự thay đổi gì, không dùng send_approval).

Trước khi viết: gọi list_inbox, xử lý câu hỏi liên quan và mark_handled. Gửi bằng send_message, kèm CSV theo ad (cột như báo cáo ngày + cột tuần trước) bằng send_file, filename "H3_tuan_{dd-MM}_{dd-MM}.csv".
```

## 3. Cảnh báo thanh toán H3 — mỗi giờ

```text
Kiểm tra ngưỡng thanh toán của tài khoản quảng cáo H3 (act_25496622559924808, USD).

1. Lấy số tiền chưa thanh toán (balance) và ngưỡng thanh toán (billing threshold) bằng connector Facebook Ads. Nếu connector không trả các số này, gọi get_billing_status của Telegram bridge (tiền theo cent: account.balance; ngưỡng ở payment_cycle.threshold_amount).
2. Tính phần trăm = balance / ngưỡng × 100.
3. Dưới 80%: KHÔNG gửi gì, kết thúc.
4. Từ 80% trở lên: chọn mốc cao nhất đã đạt trong 80 / 90 / 100 và gọi send_message với
   - text: "⚠ H3 đã dùng {phần trăm}% ngưỡng thanh toán: ${balance} / ${ngưỡng}. Còn ${ngưỡng - balance} trước khi Meta trừ tiền." (mốc 100%: thêm "Kiểm tra thẻ thanh toán ngay.")
   - dedupe_key: "billing-H3-{mốc}"   (ví dụ billing-H3-90)
   - dedupe_hours: 12
   Bridge tự bỏ qua nếu mốc đó đã được báo trong 12 giờ gần đây, nên mỗi mốc chỉ báo một lần.
```

> Ghi chú: `dedupe_key` là phần bổ sung của bridge so với đặc tả gốc — vì mỗi lượt task là phiên mới, Claude không tự nhớ đã báo mốc nào; bridge giữ trạng thái đó.
