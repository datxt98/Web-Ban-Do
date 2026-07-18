import { listBandoState } from "@/lib/bando-storage";

export async function GET() {
  try {
    return Response.json(await listBandoState());
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lỗi tải lịch sử bán đồ.";
}
