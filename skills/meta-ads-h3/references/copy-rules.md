# Quy tắc viết copy (tiếng Anh Mỹ)

## Ba kiểu viết lấy từ các ad đang chạy trên H3

| `style` | Dùng khi | Mẫu đang chạy |
| --- | --- | --- |
| `first_person_story` — người mặc kể chuyện | Áo mặc hằng ngày, video có người mặc thật | Hoodie: "People think I'm crazy for wearing my Native hoodie everywhere…" (camp ROAS cao nhất tuần 31/10–06/11) |
| `gift_giver` — góc người mua tặng quà | Mùa quà tặng, thiết kế con vật hoặc hoa lá, banner sản phẩm đơn | Jersey: "He says he doesn't need anything…", "For the Woman Who Notices Nature" |
| `product_detail` — bán hàng, emoji + gạch đầu dòng | Sản phẩm có tính năng cần liệt kê (cá nhân hoá, kích cỡ, combo) | Túi da: "100% Customized with your name!"; Ornament |

V1 theo kiểu hợp nhất với creative và sản phẩm, V2 theo kiểu thứ hai để A/B, V3 (tuỳ chọn) chỉ khi Ghi chú copy yêu cầu hướng khác. Mỗi phương án ghi `reason` (tiếng Việt, một câu) — giai đoạn sau dùng để chấm kiểu viết nào bán tốt.

## Cấu trúc mỗi phương án

- `headline`: 4–7 từ, nhắm vào một kiểu người cụ thể ("For the Man Drawn to the Wild"), tối đa 40 ký tự.
- `primary_text`: 3–6 dòng ngắn có xuống dòng; câu đầu là hook dưới 125 ký tự; tả màu sắc và con vật cụ thể; nhắc in 2 mặt khi sản phẩm in 2 mặt; câu cuối kêu gọi xem hoặc chọn size.
- `description`: một câu dưới 30 ký tự về chi tiết sản phẩm.
- Ưu đãi (ví dụ Buy 5 Get 2, free shipping, % off), số lượng còn lại, hạn chót: chỉ khi đọc được trên trang sản phẩm — không tự nghĩ ra.

## Bị cấm (nghệ sĩ không phải người bản địa — Indian Arts and Crafts Act)

- Không dùng: `authentic`, `genuine`, `Native-made`, `tribal-made`, `Indian-made`, "made / crafted / designed / painted… by Native (artists)", "Native artists / artisans / makers", "Native-owned", "from the reservation", "certified Native", "supports Native artists / communities".
- Không nêu tên bộ tộc cụ thể (Navajo, Cherokee, Lakota, Haida, Hopi, Apache, Cree, Ojibwe…; với Crow, Creek, Dakota, Chinook… thì cấm khi đi kèm nation / tribe / people / style / art).
- Được dùng: `Native-inspired`, `inspired by Native American art`, `Pacific Northwest–inspired`, `Indigenous-inspired`.
- Không hứa hẹn sức khoẻ hay tâm linh có tác dụng thật: heals, healing, protects you, wards off, brings good luck, blessed by, sacred powers…
- Không viết IN HOA cả câu; tối đa 3 emoji mỗi phương án.
- Trang sản phẩm ghi "handcrafted" / "handmade" (thường là nói về khâu sản xuất) — đừng lặp lại trong copy, dễ bị hiểu là đồ thủ công bản địa.

`scripts/check_copy.py` soát các quy tắc trên bằng code (cùng bộ quy tắc với bridge của shop). Riêng mục "handcrafted / handmade" là khuyến nghị, script không bắt — tự để ý.
