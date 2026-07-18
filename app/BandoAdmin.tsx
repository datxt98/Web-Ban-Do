"use client";

import {
  DatabaseZap,
  Edit3,
  ListChecks,
  PackagePlus,
  RefreshCcw,
  Save,
  Search,
  Store,
  ToggleLeft,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatVnd } from "@/lib/bando-command";
import type { BandoItem, BandoOrder, BandoState } from "@/lib/bando-types";

type ApiMessage = {
  tone: "ok" | "error";
  text: string;
};

type ViewMode = "shop" | "add" | "orders";

const emptyState: BandoState = {
  items: [],
  orders: [],
  transactions: [],
  events: [],
  storage: "memory",
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? "Yêu cầu thất bại.");
  }
  return payload;
}

function statusLabel(status: BandoOrder["status"]) {
  if (status === "awaiting_payment") return "Chờ tiền";
  if (status === "paid") return "Đã thanh toán";
  if (status === "completed") return "Đã giao";
  return "Đã hủy";
}

function storageLabel(storage: BandoState["storage"]) {
  if (storage === "mysql") return "MySQL bando";
  if (storage === "d1") return "D1 bando";
  return "Dữ liệu tạm";
}

function toAliasText(item: BandoItem) {
  return item.aliases.join(", ");
}

function defaultBuyName(item: BandoItem) {
  if (item.buyName && item.buyName !== item.code) return item.buyName;
  if (item.itemId != null) return `vp${item.itemId}`;
  return item.code;
}

function itemCodeFor(item: BandoItem | null, itemIdDraft: string, buyNameDraft: string) {
  const itemIdText = itemIdDraft.trim();
  if (itemIdText) {
    const itemId = Number(itemIdText);
    if (Number.isInteger(itemId) && itemId >= 0) return `item-${itemId}`;
  }
  if (item?.code) return item.code;
  return buyNameDraft.trim().toLowerCase().replace(/\s+/g, "-");
}

export default function BandoAdmin() {
  const [state, setState] = useState<BandoState>(emptyState);
  const [activeView, setActiveView] = useState<ViewMode>("shop");
  const [selectedItem, setSelectedItem] = useState<BandoItem | null>(null);
  const [searchText, setSearchText] = useState("");
  const [itemIdDraft, setItemIdDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [buyNameDraft, setBuyNameDraft] = useState("");
  const [aliasesDraft, setAliasesDraft] = useState("");
  const [unitDraft, setUnitDraft] = useState("cai");
  const [priceDraft, setPriceDraft] = useState("");
  const [stockDraft, setStockDraft] = useState("0");
  const [activeDraft, setActiveDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ApiMessage | null>(null);

  const sellingItems = useMemo(
    () =>
      state.items
        .filter((item) => item.active && item.sellPrice > 0)
        .sort((a, b) => (a.itemId ?? 999999) - (b.itemId ?? 999999) || a.name.localeCompare(b.name)),
    [state.items],
  );

  const searchResults = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    const source = state.items.slice().sort((a, b) => (a.itemId ?? 999999) - (b.itemId ?? 999999));
    if (!query) return source.slice(0, 80);
    return source
      .filter((item) => {
        return (
          String(item.itemId ?? "").includes(query) ||
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.buyName.toLowerCase().includes(query)
        );
      })
      .slice(0, 80);
  }, [searchText, state.items]);

  const totalPaid = state.transactions
    .filter((transaction) => transaction.status === "matched")
    .reduce((sum, transaction) => sum + transaction.amount, 0);

  async function loadState() {
    const nextState = await jsonFetch<BandoState>("/api/bando/history");
    setState(nextState);
  }

  async function runAction(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      await loadState();
      setMessage({ tone: "ok", text });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Có lỗi không xác định.",
      });
    } finally {
      setBusy(false);
    }
  }

  function selectItem(item: BandoItem) {
    setSelectedItem(item);
    setItemIdDraft(item.itemId == null ? "" : String(item.itemId));
    setNameDraft(item.name);
    setBuyNameDraft(defaultBuyName(item));
    setAliasesDraft(toAliasText(item));
    setUnitDraft(item.unit || "cai");
    setPriceDraft(item.sellPrice > 0 ? String(item.sellPrice) : "");
    setStockDraft(String(item.stock ?? 0));
    setActiveDraft(true);
  }

  function resetDrafts() {
    setSelectedItem(null);
    setItemIdDraft("");
    setNameDraft("");
    setBuyNameDraft("");
    setAliasesDraft("");
    setUnitDraft("cai");
    setPriceDraft("");
    setStockDraft("0");
    setActiveDraft(true);
  }

  function openAddItem(item?: BandoItem) {
    setActiveView("add");
    if (item) {
      selectItem(item);
    } else {
      resetDrafts();
    }
  }

  function patchItemBody(active: boolean) {
    const code = itemCodeFor(selectedItem, itemIdDraft, buyNameDraft);
    return {
      code,
      itemId: itemIdDraft ? Number(itemIdDraft) : null,
      name: nameDraft || selectedItem?.name || code,
      buyName: buyNameDraft || code,
      aliases: aliasesDraft
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
      unit: unitDraft || "cai",
      sellPrice: Number(priceDraft),
      stock: Number(stockDraft),
      active,
    };
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadState().catch((error) => {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Không tải được dữ liệu bán đồ.",
      });
    });
  }, []);

  return (
    <main className="adminShell">
      <header className="topBar">
        <div>
          <span className="kicker">Quản trị bán đồ</span>
          <h1>Bảng quản lý bán đồ</h1>
        </div>
        <div className="topActions">
          <span className="dbBadge">
            <DatabaseZap size={16} />
            {storageLabel(state.storage)}
          </span>
          <button className="toolButton" disabled={busy} onClick={() => void loadState()}>
            <RefreshCcw size={17} />
            Tải lại
          </button>
        </div>
      </header>

      <nav className="tabBar">
        <button className={activeView === "shop" ? "tab active" : "tab"} onClick={() => setActiveView("shop")}>
          <Store size={17} />
          Gian hàng
        </button>
        <button className={activeView === "add" ? "tab active" : "tab"} onClick={() => openAddItem()}>
          <PackagePlus size={17} />
          Thêm item bán
        </button>
        <button className={activeView === "orders" ? "tab active" : "tab"} onClick={() => setActiveView("orders")}>
          <ListChecks size={17} />
          Đơn hàng
        </button>
      </nav>

      <section className="statsRow">
        <div className="statBox">
          <span>Item đang bán</span>
          <strong>{sellingItems.length}</strong>
        </div>
        <div className="statBox">
          <span>Tổng item DB</span>
          <strong>{state.items.length}</strong>
        </div>
        <div className="statBox">
          <span>Đơn chờ tiền</span>
          <strong>{state.orders.filter((order) => order.status === "awaiting_payment").length}</strong>
        </div>
        <div className="statBox">
          <span>Tiền đã khớp</span>
          <strong>{formatVnd(totalPaid)}</strong>
        </div>
      </section>

      {message && <div className={`notice ${message.tone}`}>{message.text}</div>}

      {activeView === "shop" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Bảng item bán</span>
              <h2>Gian hàng</h2>
            </div>
            <button className="primaryButton" onClick={() => openAddItem()}>
              <PackagePlus size={17} />
              Thêm item bán
            </button>
          </div>

          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>ID vật phẩm</th>
                  <th>Tên vật phẩm</th>
                  <th>Tên mua</th>
                  <th>Đơn giá</th>
                  <th>Số lượng còn lại</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sellingItems.map((item) => (
                  <tr key={item.code}>
                    <td>{item.itemId ?? "-"}</td>
                    <td>{item.name}</td>
                    <td>{item.buyName}</td>
                    <td>{formatVnd(item.sellPrice)}</td>
                    <td>
                      {item.stock} {item.unit}
                    </td>
                    <td className="rowActions">
                      <button className="miniButton" onClick={() => openAddItem(item)}>
                        <Edit3 size={15} />
                        Sửa
                      </button>
                      <button
                        className="miniButton muted"
                        disabled={busy}
                        onClick={() =>
                          void runAction(async () => {
                            setSelectedItem(item);
                            setItemIdDraft(item.itemId == null ? "" : String(item.itemId));
                            setNameDraft(item.name);
                            setBuyNameDraft(defaultBuyName(item));
                            setAliasesDraft(toAliasText(item));
                            setUnitDraft(item.unit);
                            setPriceDraft(String(Math.max(item.sellPrice, 1)));
                            setStockDraft(String(item.stock));
                            await jsonFetch("/api/bando/prices", {
                              method: "PATCH",
                              body: JSON.stringify({
                                code: item.code,
                                itemId: item.itemId,
                                name: item.name,
                                buyName: item.buyName,
                                aliases: item.aliases,
                                unit: item.unit,
                                sellPrice: Math.max(item.sellPrice, 1),
                                stock: item.stock,
                                active: false,
                              }),
                            });
                            return `Đã tắt bán ${item.name}.`;
                          })
                        }
                      >
                        <ToggleLeft size={15} />
                        Tắt bán
                      </button>
                    </td>
                  </tr>
                ))}
                {sellingItems.length === 0 && (
                  <tr>
                    <td colSpan={6} className="emptyCell">
                      Chưa có item đang bán. Bấm Thêm item bán để chọn item từ DB và đặt giá.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeView === "add" && (
        <section className="splitGrid">
          <div className="panel">
            <div className="panelHeader">
              <div>
                <span className="kicker">Dữ liệu DB</span>
                <h2>Tìm item</h2>
              </div>
              <button
                className="toolButton"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    const result = await jsonFetch<{ imported: number }>("/api/bando/items/import-server", {
                      method: "POST",
                      body: JSON.stringify({}),
                    });
                    return `Đã đồng bộ ${result.imported} item từ DB server.`;
                  })
                }
              >
                <RefreshCcw size={17} />
                Đồng bộ DB
              </button>
            </div>

            <label className="searchBox">
              <Search size={18} />
              <input
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Tìm theo ID hoặc tên vật phẩm"
              />
            </label>

            <div className="resultList">
              {searchResults.map((item) => (
                <button
                  className={selectedItem?.code === item.code ? "resultRow active" : "resultRow"}
                  key={item.code}
                  onClick={() => selectItem(item)}
                >
                  <span>{item.itemId ?? "-"}</span>
                  <strong>{item.name}</strong>
                  <small>{item.active && item.sellPrice > 0 ? "đang bán" : "chưa bán"}</small>
                </button>
              ))}
              {searchResults.length === 0 && <div className="emptyBlock">Không tìm thấy item trong DB bando.</div>}
            </div>
          </div>

          <div className="panel">
            <div className="panelHeader">
              <div>
                <span className="kicker">Đặt giá</span>
                <h2>Thêm item bán</h2>
              </div>
              <Save size={21} />
            </div>

            {!selectedItem && <div className="emptyBlock">Chọn một item ở khung tìm kiếm để đặt giá bán.</div>}

            {selectedItem && (
              <div className="priceForm">
                <div className="selectedItem">
                  <span>ID {selectedItem.itemId ?? "-"}</span>
                  <strong>{selectedItem.name}</strong>
                </div>

                <label>
                  <span>Tên mua trong game</span>
                  <input value={buyNameDraft} onChange={(event) => setBuyNameDraft(event.target.value)} />
                </label>
                <label>
                  <span>Alias phụ</span>
                  <input value={aliasesDraft} onChange={(event) => setAliasesDraft(event.target.value)} />
                </label>
                <label>
                  <span>Đơn giá / 1 item</span>
                  <input value={priceDraft} onChange={(event) => setPriceDraft(event.target.value)} inputMode="numeric" />
                </label>
                <label>
                  <span>Số lượng còn lại</span>
                  <input value={stockDraft} onChange={(event) => setStockDraft(event.target.value)} inputMode="numeric" />
                </label>
                <label>
                  <span>Đơn vị</span>
                  <input value={unitDraft} onChange={(event) => setUnitDraft(event.target.value)} />
                </label>
                <label className="checkLine">
                  <input type="checkbox" checked={activeDraft} onChange={(event) => setActiveDraft(event.target.checked)} />
                  Bật bán trong gian hàng
                </label>

                <button
                  className="primaryButton wide"
                  disabled={busy}
                  onClick={() =>
                    void runAction(async () => {
                      await jsonFetch("/api/bando/prices", {
                        method: "PATCH",
                        body: JSON.stringify(patchItemBody(activeDraft)),
                      });
                      setActiveView("shop");
                      return `Đã lưu ${nameDraft || selectedItem.name} vào gian hàng.`;
                    })
                  }
                >
                  <Save size={17} />
                  Lưu vào gian hàng
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {activeView === "orders" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Lịch sử giao dịch</span>
              <h2>Đơn hàng</h2>
            </div>
          </div>

          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Mã đơn</th>
                  <th>Nhân vật</th>
                  <th>Vật phẩm</th>
                  <th>Tổng tiền</th>
                  <th>Mã GD</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {state.orders.map((order) => (
                  <tr key={order.orderCode}>
                    <td>{order.orderCode}</td>
                    <td>{order.characterName}</td>
                    <td>
                      {order.itemName} x{order.quantity}
                    </td>
                    <td>{formatVnd(order.totalAmount)}</td>
                    <td>{order.paymentCode}</td>
                    <td>
                      <span className={`status ${order.status}`}>{statusLabel(order.status)}</span>
                    </td>
                  </tr>
                ))}
                {state.orders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="emptyCell">
                      Chưa có đơn hàng nào.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
