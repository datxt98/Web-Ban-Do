import { confirmBandoPayment } from "@/lib/bando-storage";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      paymentCode?: string;
      amount?: number;
      note?: string;
    };
    const result = await confirmBandoPayment({
      paymentCode: body.paymentCode ?? "",
      amount: Number(body.amount),
      note: body.note,
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
  return error instanceof Error ? error.message : "Lỗi xác nhận thanh toán bán đồ.";
}
