import { authorizeBandoBot, confirmBandoDelivery } from "@/lib/bando-storage";

export async function POST(request: Request) {
  const unauthorized = await authorizeBandoBot(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body = (await request.json()) as {
      orderCode?: string;
      botName?: string;
    };
    const result = await confirmBandoDelivery({
      orderCode: body.orderCode ?? "",
      botName: body.botName,
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }

    return Response.json(result);
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lỗi xác nhận giao hàng bán đồ.";
}
