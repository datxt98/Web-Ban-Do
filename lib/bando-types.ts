export type BandoOrderStatus =
  | "awaiting_payment"
  | "paid"
  | "completed"
  | "cancelled";

export type BandoItem = {
  code: string;
  itemId: number | null;
  name: string;
  buyName: string;
  aliases: string[];
  unit: string;
  sellPrice: number;
  stock: number;
  active: boolean;
  updatedAt: string;
};

export type BandoOrder = {
  id?: number;
  orderCode: string;
  paymentCode: string;
  characterName: string;
  serverName: string;
  itemCode: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  status: BandoOrderStatus;
  privateMessage: string;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
};

export type BandoTransaction = {
  id?: number;
  orderCode: string | null;
  paymentCode: string;
  amount: number;
  status: "matched" | "rejected";
  note: string;
  createdAt: string;
};

export type BandoEvent = {
  id?: number;
  orderCode: string | null;
  type: string;
  message: string;
  createdAt: string;
};

export type BandoState = {
  items: BandoItem[];
  orders: BandoOrder[];
  transactions: BandoTransaction[];
  events: BandoEvent[];
  storage: "d1" | "mysql" | "memory";
};

export type BandoDeliveryJob = {
  type: "deliver_item";
  orderCode: string;
  paymentCode: string;
  characterName: string;
  serverName: string;
  itemCode: string;
  itemName: string;
  quantity: number;
};

export type BandoInventoryItem = {
  itemId: number;
  name?: string;
  quantity: number;
};
