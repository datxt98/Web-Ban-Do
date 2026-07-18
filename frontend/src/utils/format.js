export function formatVnd(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(Number(amount) || 0)} VND`;
}
