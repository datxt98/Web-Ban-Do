import { listBandoState, updateBandoPrice } from "@/lib/bando-storage";

export async function GET() {
  try {
    const state = await listBandoState();
    return Response.json({ items: state.items, storage: state.storage });
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as {
      code?: string;
      itemId?: number | null;
      name?: string;
      buyName?: string;
      aliases?: string[];
      unit?: string;
      sellPrice?: number;
      stock?: number;
      active?: boolean;
    };
    const result = await updateBandoPrice({
      code: body.code ?? "",
      itemId: body.itemId,
      name: body.name,
      buyName: body.buyName,
      aliases: body.aliases,
      unit: body.unit,
      sellPrice: Number(body.sellPrice),
      stock: Number(body.stock),
      active: body.active,
    });

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lỗi cập nhật bảng giá bán đồ.";
}
