# Mẫu brief

Dòng đầu là lệnh, các dòng sau dạng `Tên: giá trị`. Không phân biệt hoa thường / dấu, bỏ qua dòng trống.

## #NEW — test mẫu mới (tạo campaign mới)

```
#NEW
TK: H3
Kiểu chạy: Auto
Mức cap ($):
Sản phẩm: 3D Hoodie Raven
Link SP: https://firstnationslegacy.com/products/...
Creative: https://drive.google.com/...
Quốc gia: US
Budget/ngày ($): 50
Ngày chạy: hôm nay
Ghi chú copy:
```

## #ADD — thêm creative vào campaign đang chạy

```
#ADD
TK: H3
Camp: 120248209112780436
Adset: mới
Post ID:
Link SP: https://firstnationslegacy.com/products/...
Creative: https://drive.google.com/...
Ghi chú copy:
```

## Kiểm tra từng trường

| Trường | Bắt buộc | Hợp lệ | Sai thì |
| --- | --- | --- | --- |
| TK | Có | `H3` | Báo tên hợp lệ |
| Kiểu chạy | Có (#NEW) | `Auto`, `CC`, `BidCap` | Hỏi lại |
| Mức cap ($) | Khi CC / BidCap | Số dương (chấm hoặc phẩy) | Thiếu → hỏi lại; ngoài $5–150 → xác nhận |
| Sản phẩm | Có (#NEW) | Tên ngắn | > 40 ký tự → cắt, báo lại |
| Link SP | Có (trừ khi có Post ID) | `https://firstnationslegacy.com/products/<handle>` | Báo lỗi |
| Creative | Có (trừ khi có Post ID) | Link file hoặc thư mục Google Drive | Báo lỗi |
| Quốc gia | Có (#NEW) | Mã 2 chữ, cách nhau dấu phẩy (`US, CA`; `UK` → `GB`) | Hỏi lại |
| Budget/ngày ($) | Có (#NEW) | Số dương ≥ 1 | > $300 → xác nhận lần 2 |
| Ngày chạy | Không | `hôm nay` hoặc `dd/MM` (tối đa 90 ngày tới) | Ngày đã qua → báo lỗi; ngày tương lai → `start_time` 00:00 giờ America/Dawson |
| Camp | Có (#ADD) | ID hoặc một phần tên campaign | Nhiều kết quả → cho chọn |
| Adset | Không (#ADD) | trống / `mới` / ID adset | — |
| Post ID | Không (#ADD) | `101065259399535_<post_id>`, nhiều cái cách nhau dấu phẩy | Không thuộc Page → từ chối |
| Ghi chú copy | Không | Tự do | Đưa vào cách viết copy |

Thư mục Drive: mỗi video / ảnh thành một ad riêng, dùng chung bộ copy; tối đa 10 file (nhiều hơn → lấy 10 file đầu theo tên và báo lại).
