import type { Metadata } from "next";
import BandoAdmin from "./BandoAdmin";

export const metadata: Metadata = {
  title: "Bảng quản lý bán đồ",
  description: "Bảng quản trị bán đồ Ninja School cho BOT giao dịch trong game.",
};

export default function Home() {
  return <BandoAdmin />;
}
