# Bảng quản lý bán đồ

Web quản lý riêng cho BOT bán đồ Ninja School. Dự án tách thành 2 phần:

- `frontend`: giao diện quản trị bằng Vite React.
- `backend`: API xử lý logic, lưu dữ liệu vào MySQL DB `bando`.

## Chạy local

```powershell
cd C:\Users\PC\Desktop\Code\Web-bando
npm install
npm run dev
```

Địa chỉ sử dụng:

- Frontend: http://localhost:3001
- Backend API: http://localhost:5001

Khi chạy dev, frontend tự proxy `/api` sang backend. BOT có thể trỏ `Web API` về:

```text
http://localhost:3001
```

## Cấu hình BOT trên web

Vào tab `Cấu hình BOT` để quản lý các phần trước đây nằm trong bảng BANDO trong game:

- Tên nhân vật BOT được phép auto.
- Web API, server name, bot token.
- Map, khu, tọa độ X/Y, sai lệch và chu kỳ đứng cố định.
- Nội dung auto chat, thời gian giãn cách, chat cộng đồng hoặc thế giới.
- Chu kỳ đồng bộ hành trang lên web.

Trong game chỉ cần đăng nhập đúng nhân vật BOT rồi bấm `BANDO`. Game sẽ gọi web để kiểm tra tên nhân vật. Nếu đúng nhân vật đã cấu hình trên web, BOT tự bật và áp dụng cấu hình web.

## Dữ liệu

Backend đọc cấu hình MySQL từ:

```text
C:\Users\PC\Desktop\Code\nso-server\mysql.properties
```

Mặc định backend tạo/dùng DB:

```text
bando
```

Các bảng chính:

- `bando_items`: bảng giá vật phẩm.
- `bando_inventory`: số lượng vật phẩm lấy từ hành trang BOT trong game.
- `bando_orders`: đơn hàng tạo từ chat riêng trong game.
- `bando_transactions`: lịch sử khớp thanh toán.
- `bando_events`: nhật ký hệ thống.
- `bando_bot_config`: cấu hình BOT quản lý trên web.

## Đồng bộ vật phẩm server

Trên web vào `Thêm item bán`, bấm `Đồng bộ DB`. Backend sẽ đọc bảng `item` trong DB server game, lưu `item_id` và tên vật phẩm vào DB `bando`.

Sau đó admin cấu hình:

- `Tên mua trong game`: tên viết tắt người chơi dùng để mua.
- `Đơn giá`: giá cho 1 vật phẩm.
- `Số lượng từ hành trang BOT`: lấy tự động từ game sau khi BOT đồng bộ.
- `Bật bán trong gian hàng`: chỉ item bật bán mới hiện trong lệnh `xem`.

## Lệnh chat riêng với BOT

- `xem`: hiện vật phẩm đang bán.
- `mua ttd 10`: tạo đơn mua 10 vật phẩm có tên mua `ttd`.
- `ttd+10`: cú pháp rút gọn.
- Tin nhắn khác: BOT trả hướng dẫn lệnh.

## Duyệt tay và giao vật phẩm

Trong tab `Đơn hàng`, đơn ở trạng thái `Chờ tiền` sẽ có nút `Duyệt tay`.

Sau khi duyệt tay, hoặc sau khi API thanh toán tự động xác nhận đúng mã giao dịch/số tiền, đơn chuyển sang `Chờ giao`. BOT đang bật sẽ tự lấy danh sách đơn chờ giao, chat riêng cho người mua để mời giao dịch nhận vật phẩm.

Người mua cần đứng cùng map/khu với BOT và mời giao dịch đúng nhân vật BOT. BOT chỉ nhận giao dịch nếu tên nhân vật mời khớp với đơn đã duyệt. Khi trade mở, BOT rút vật phẩm từ rương/hành trang, tách đúng số lượng nếu cần, khóa giao dịch, đợi người mua xác nhận rồi hoàn tất đơn trên web.

## Telegram và VietQR trả tiền khách bán xu

Khi khách bán xu cho BOT và đã gửi đúng thông tin ngân hàng, Telegram sẽ nhận tin `KHÁCH ĐÃ GỬI THÔNG TIN NHẬN TIỀN`. Backend tạo thêm ảnh VietQR bằng Quick Link của VietQR.io và gửi vào nhóm để admin quét trả tiền nhanh.

Cấu hình tùy chọn trong `.env`:

```text
BANDO_VIETQR_ENABLED=1
BANDO_VIETQR_TEMPLATE=compact2
BANDO_VIETQR_FORMAT=png
```

QR dùng ngân hàng, số tài khoản, chủ tài khoản của khách; số tiền là số tiền shop cần trả cho phiếu bán xu; nội dung chuyển khoản là `TRA XU <MÃ_PHIẾU>`.

## Kiểm tra

```powershell
npm test
```
