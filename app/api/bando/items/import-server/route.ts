import { importBandoItemsFromServer } from "@/lib/bando-storage";

export async function POST() {
  try {
    const result = await importBandoItemsFromServer();
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lỗi đồng bộ item từ DB server.";
}
