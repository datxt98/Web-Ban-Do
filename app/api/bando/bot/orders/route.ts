import { authorizeBandoBot, createBandoOrderFromChat } from "@/lib/bando-storage";

export async function POST(request: Request) {
  const unauthorized = await authorizeBandoBot(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body = (await request.json()) as {
      characterName?: string;
      privateMessage?: string;
      serverName?: string;
      inventory?: Array<{ itemId: number; name?: string; quantity: number }>;
    };
    const result = await createBandoOrderFromChat({
      characterName: body.characterName ?? "",
      privateMessage: body.privateMessage ?? "",
      serverName: body.serverName,
      inventory: body.inventory,
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }

    return Response.json(result, { status: 201 });
  } catch (error) {
    return Response.json({ error: toMessage(error) }, { status: 500 });
  }
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Lỗi tạo đơn bán đồ.";
}
