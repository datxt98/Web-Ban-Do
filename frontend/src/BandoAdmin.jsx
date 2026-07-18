import {
  CheckCircle2,
  Bot,
  Coins,
  CreditCard,
  DatabaseZap,
  Edit3,
  ListChecks,
  MapPin,
  MessageSquareText,
  PackagePlus,
  RefreshCcw,
  Save,
  Search,
  Store,
  ToggleLeft,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatVnd } from "./utils/format.js";

const apiBaseUrl = import.meta.env.VITE_API_URL?.trim() || "";
const numberFormatter = new Intl.NumberFormat("vi-VN");
const gameOptionsDefault = ["Ninja Mobile", "Ninja 2D"];
const defaultGameName = "Ninja Mobile";

const emptyState = {
  items: [],
  orders: [],
  coinTrades: [],
  transactions: [],
  bankAccounts: [],
  events: [],
  storage: "memory",
};

const emptyBotConfig = {
  enabled: true,
  characterName: "ADMIN",
  webBaseUrl: "http://localhost:5001",
  botToken: "",
  gameName: defaultGameName,
  serverName: "nso-local",
  replyPrivate: true,
  inventorySyncMs: 15000,
  adminNames: [],
  stand: {
    enabled: false,
    mapId: -1,
    zoneId: -1,
    x: 300,
    y: 336,
    tolerance: 12,
    intervalMs: 1500,
  },
  autoChat: {
    enabled: false,
    text: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
    intervalMs: 60000,
    community: true,
    communityText: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
    communityIntervalMs: 60000,
    world: false,
    worldText: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
    worldIntervalMs: 60000,
  },
  coinTrade: {
    sell: {
      enabled: true,
      rate: 2.6,
    },
    importXu: {
      enabled: true,
      rate: 2.6,
    },
  },
  serverProfiles: [],
};

async function jsonFetch(url, init) {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const response = await fetch(`${apiBaseUrl}${url}`, {
    ...init,
    headers,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Yêu cầu thất bại.");
  }
  return payload;
}

function statusLabel(status) {
  if (status === "awaiting_payment") return "Chờ tiền";
  if (status === "paid") return "Chờ giao";
  if (status === "completed") return "Đã giao";
  return "Đã hủy";
}

function coinTradeTypeLabel(type) {
  if (type === "buy_xu") return "Khách mua xu";
  if (type === "sell_xu") return "Khách bán xu";
  return type || "-";
}

function coinTradeStatusLabel(status, type) {
  if (status === "awaiting_payment") return "Chờ thanh toán";
  if (status === "paid") return "Chờ BOT giao xu";
  if (status === "awaiting_trade") return "Chờ khách giao xu";
  if (status === "awaiting_payout_info") return "Chờ khách gửi STK";
  if (status === "completed") return type === "sell_xu" ? "Chờ duyệt trả tiền" : "Hoàn tất";
  if (status === "payout_completed") return "Đã trả tiền";
  if (status === "payout_info_cancelled") return "Đã hủy STK";
  return status || "-";
}

function storageLabel(storage) {
  if (storage === "mysql") return "MySQL bando";
  return "Dữ liệu tạm";
}

function toAliasText(item) {
  return item.aliases.join(", ");
}

function defaultBuyName(item) {
  if (item.buyName && item.buyName !== item.code) return item.buyName;
  if (item.itemId != null) return `vp${item.itemId}`;
  return item.code;
}

function itemCodeFor(item, itemIdDraft, buyNameDraft) {
  const itemIdText = itemIdDraft.trim();
  if (itemIdText) {
    const itemId = Number(itemIdText);
    if (Number.isInteger(itemId) && itemId >= 0) return `item-${itemId}`;
  }
  if (item?.code) return item.code;
  return buyNameDraft.trim().toLowerCase().replace(/\s+/g, "-");
}

function mergeBotConfig(config) {
  const merged = {
    ...emptyBotConfig,
    ...(config ?? {}),
    stand: {
      ...emptyBotConfig.stand,
      ...(config?.stand ?? {}),
    },
    autoChat: {
      ...emptyBotConfig.autoChat,
      ...(config?.autoChat ?? {}),
    },
    coinTrade: {
      ...emptyBotConfig.coinTrade,
      ...(config?.coinTrade ?? {}),
      sell: {
        ...emptyBotConfig.coinTrade.sell,
        ...(config?.coinTrade?.sell ?? {}),
      },
      importXu: {
        ...emptyBotConfig.coinTrade.importXu,
        ...(config?.coinTrade?.importXu ?? {}),
      },
    },
    serverProfiles: [],
  };
  merged.serverProfiles = normalizeServerProfiles(config);
  return merged;
}

function normalizeServerProfiles(config) {
  const rawProfiles = Array.isArray(config?.serverProfiles) ? config.serverProfiles : [];
  const seen = new Set();
  const profiles = [];
  for (const profile of rawProfiles) {
    if (!profile || typeof profile !== "object") continue;
    const normalized = {
      ...emptyBotConfig,
      ...profile,
      stand: {
        ...emptyBotConfig.stand,
        ...(profile.stand ?? {}),
      },
      autoChat: {
        ...emptyBotConfig.autoChat,
        ...(profile.autoChat ?? {}),
      },
      coinTrade: {
        ...emptyBotConfig.coinTrade,
        ...(profile.coinTrade ?? {}),
        sell: {
          ...emptyBotConfig.coinTrade.sell,
          ...(profile.coinTrade?.sell ?? {}),
        },
        importXu: {
          ...emptyBotConfig.coinTrade.importXu,
          ...(profile.coinTrade?.importXu ?? {}),
        },
      },
      serverProfiles: [],
    };
    normalized.serverName = String(normalized.serverName || "").trim();
    normalized.gameName = String(normalized.gameName || defaultGameName).trim() || defaultGameName;
    if (!normalized.serverName) continue;
    const key = profileKey(normalized.gameName, normalized.serverName);
    if (seen.has(key)) continue;
    seen.add(key);
    profiles.push(normalized);
  }
  return profiles;
}

function serverKey(serverName) {
  return String(serverName || "").trim().toLowerCase();
}

function gameKey(gameName) {
  return String(gameName || defaultGameName).trim().toLowerCase();
}

function normalizeGameName(gameName) {
  return String(gameName || defaultGameName).trim() || defaultGameName;
}

function profileKey(gameName, serverName) {
  return `${gameKey(gameName)}|${serverKey(serverName)}`;
}

function serverQuery(gameName, serverName) {
  const params = new URLSearchParams();
  const game = normalizeGameName(gameName);
  const name = String(serverName || "").trim();
  if (game) params.set("gameName", game);
  if (name) params.set("serverName", name);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function configForServer(config, gameName, serverName) {
  const normalized = mergeBotConfig(config);
  const key = profileKey(gameName || normalized.gameName, serverName || normalized.serverName);
  const profile = normalized.serverProfiles.find((entry) => profileKey(entry.gameName, entry.serverName) === key);
  if (!profile) {
    return mergeBotConfig({
      ...normalized,
      gameName: normalizeGameName(gameName || normalized.gameName),
      serverName: String(serverName || normalized.serverName || emptyBotConfig.serverName).trim(),
    });
  }
  return mergeBotConfig({
    ...normalized,
    ...profile,
    serverProfiles: normalized.serverProfiles,
  });
}

function hasServerConfig(config, gameName, serverName) {
  if (!serverKey(serverName)) return false;
  const key = profileKey(gameName, serverName);
  const normalized = mergeBotConfig(config);
  return (
    profileKey(normalized.gameName, normalized.serverName) === key ||
    normalized.serverProfiles.some((profile) => profileKey(profile.gameName, profile.serverName) === key)
  );
}

function upsertServerProfile(baseConfig, profileConfig, previousGameName = "", previousServerName = "") {
  const body = {
    ...profileConfig,
    gameName: normalizeGameName(profileConfig.gameName),
    serverProfiles: [],
  };
  const nextKey = profileKey(body.gameName, body.serverName);
  const previousKey = previousServerName ? profileKey(previousGameName || body.gameName, previousServerName) : "";
  const profiles = (baseConfig.serverProfiles ?? []).filter((profile) => {
    const key = profileKey(profile.gameName, profile.serverName);
    return key && key !== nextKey && key !== previousKey;
  });
  return {
    ...body,
    serverProfiles: [...profiles, body],
  };
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatXu(amount) {
  return `${numberFormatter.format(Math.max(0, Math.round(Number(amount) || 0)))} xu`;
}

function maskSecret(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= 6) return "*".repeat(text.length);
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function coinAmountForRate(rate) {
  return numberValue(rate, 2.6) * 100000;
}

export default function BandoAdmin() {
  const [state, setState] = useState(emptyState);
  const [botConfig, setBotConfig] = useState(emptyBotConfig);
  const [configDraft, setConfigDraft] = useState(emptyBotConfig);
  const [activeGameName, setActiveGameName] = useState(() => {
    try {
      return localStorage.getItem("bando.activeGameName") || defaultGameName;
    } catch {
      return defaultGameName;
    }
  });
  const [activeServerName, setActiveServerName] = useState(() => {
    try {
      return localStorage.getItem("bando.activeServerName") || emptyBotConfig.serverName;
    } catch {
      return emptyBotConfig.serverName;
    }
  });
  const activeGameRef = useRef(activeGameName);
  const activeServerRef = useRef(activeServerName);
  const [activeView, setActiveView] = useState("shop");
  const [selectedItem, setSelectedItem] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [itemIdDraft, setItemIdDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [buyNameDraft, setBuyNameDraft] = useState("");
  const [aliasesDraft, setAliasesDraft] = useState("");
  const [unitDraft, setUnitDraft] = useState("cái");
  const [priceDraft, setPriceDraft] = useState("");
  const [stockDraft, setStockDraft] = useState("0");
  const [activeDraft, setActiveDraft] = useState(true);
  const [selectedBankAccount, setSelectedBankAccount] = useState(null);
  const [bankNameDraft, setBankNameDraft] = useState("");
  const [bankCodeDraft, setBankCodeDraft] = useState("");
  const [accountNumberDraft, setAccountNumberDraft] = useState("");
  const [accountNameDraft, setAccountNameDraft] = useState("");
  const [paymentPrefixDraft, setPaymentPrefixDraft] = useState("");
  const [callbackSignatureDraft, setCallbackSignatureDraft] = useState("");
  const [bankActiveDraft, setBankActiveDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const sellingItems = useMemo(
    () =>
      state.items
        .filter((item) => item.active && item.sellPrice > 0)
        .sort((a, b) => (a.itemId ?? 999999) - (b.itemId ?? 999999) || a.name.localeCompare(b.name)),
    [state.items],
  );

  const itemOrders = useMemo(
    () => state.orders.filter((order) => order.itemCode !== "coin-xu"),
    [state.orders],
  );

  const gameOptions = useMemo(() => {
    const options = new Map(gameOptionsDefault.map((name) => [gameKey(name), name]));
    const addOption = (profile) => {
      const name = normalizeGameName(profile?.gameName);
      options.set(gameKey(name), name);
    };
    addOption(botConfig);
    (botConfig.serverProfiles ?? []).forEach(addOption);
    addOption(configDraft);
    return Array.from(options.values());
  }, [botConfig, configDraft]);

  const serverOptions = useMemo(() => {
    const options = new Map();
    const addOption = (profile) => {
      if (gameKey(profile?.gameName) !== gameKey(activeGameName)) return;
      const name = String(profile?.serverName || "").trim();
      if (!name) return;
      options.set(profileKey(profile.gameName, name), {
        gameName: normalizeGameName(profile?.gameName),
        serverName: name,
        characterName: String(profile?.characterName || "").trim(),
      });
    };
    addOption(botConfig);
    (botConfig.serverProfiles ?? []).forEach(addOption);
    addOption(configDraft);
    if (activeServerName) addOption({ gameName: activeGameName, serverName: activeServerName });
    return Array.from(options.values()).sort((a, b) => a.serverName.localeCompare(b.serverName));
  }, [activeGameName, activeServerName, botConfig, configDraft]);

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

  function firstServerForGame(config, gameName) {
    const normalized = mergeBotConfig(config);
    const profiles = [normalized, ...(normalized.serverProfiles ?? [])].filter((profile) => gameKey(profile.gameName) === gameKey(gameName));
    return profiles.find((profile) => String(profile.serverName || "").trim())?.serverName || "";
  }

  async function loadState(
    gameNameOverride = activeGameRef.current || activeGameName,
    serverNameOverride = activeServerRef.current || activeServerName,
  ) {
    const configPayload = await jsonFetch("/api/bando/bot/config");
    const nextConfig = mergeBotConfig(configPayload.config);
    const selectedGameName = normalizeGameName(gameNameOverride || nextConfig.gameName || defaultGameName);
    let selectedServerName = String(serverNameOverride || "").trim();
    if (!hasServerConfig(nextConfig, selectedGameName, selectedServerName)) {
      selectedServerName = firstServerForGame(nextConfig, selectedGameName) || nextConfig.serverName || emptyBotConfig.serverName;
    }
    rememberActiveSelection(selectedGameName, selectedServerName);
    const nextState = await jsonFetch(`/api/bando/history${serverQuery(selectedGameName, selectedServerName)}`);
    setState(nextState);
    setBotConfig(nextConfig);
    setConfigDraft(configForServer(nextConfig, selectedGameName, selectedServerName));
  }

  async function runAction(action) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      await loadState(activeGameRef.current || activeGameName, activeServerRef.current || activeServerName);
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

  function selectItem(item) {
    setSelectedItem(item);
    setItemIdDraft(item.itemId == null ? "" : String(item.itemId));
    setNameDraft(item.name);
    setBuyNameDraft(defaultBuyName(item));
    setAliasesDraft(toAliasText(item));
    setUnitDraft(item.unit || "cái");
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
    setUnitDraft("cái");
    setPriceDraft("");
    setStockDraft("0");
    setActiveDraft(true);
  }

  function selectBankAccount(account) {
    setSelectedBankAccount(account);
    setBankNameDraft(account.bankName);
    setBankCodeDraft(account.bankCode || "");
    setAccountNumberDraft(account.accountNumber);
    setAccountNameDraft(account.accountName);
    setPaymentPrefixDraft(account.paymentPrefix || "");
    setCallbackSignatureDraft(account.callbackSignature || "");
    setBankActiveDraft(account.active);
  }

  function resetBankDrafts() {
    setSelectedBankAccount(null);
    setBankNameDraft("");
    setBankCodeDraft("");
    setAccountNumberDraft("");
    setAccountNameDraft("");
    setPaymentPrefixDraft("");
    setCallbackSignatureDraft("");
    setBankActiveDraft(true);
  }

  function bankAccountBody() {
    return {
      bankName: bankNameDraft.trim(),
      bankCode: bankCodeDraft.trim(),
      accountNumber: accountNumberDraft.trim(),
      accountName: accountNameDraft.trim(),
      paymentPrefix: paymentPrefixDraft.trim(),
      callbackSignature: callbackSignatureDraft.trim(),
      active: bankActiveDraft,
    };
  }

  function openAddItem(item) {
    setActiveView("add");
    if (item) {
      selectItem(item);
    } else {
      resetDrafts();
    }
  }

  function patchItemBody(active) {
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
      unit: unitDraft || "cái",
      sellPrice: Number(priceDraft),
      stock: Number(stockDraft),
      active,
    };
  }

  function updateConfig(partial) {
    setConfigDraft((current) => mergeBotConfig({ ...current, ...partial }));
  }

  function selectGame(gameName) {
    const selectedGameName = normalizeGameName(gameName);
    const selectedServerName = firstServerForGame(botConfig, selectedGameName) || activeServerName || emptyBotConfig.serverName;
    rememberActiveSelection(selectedGameName, selectedServerName);
    setConfigDraft(configForServer(botConfig, selectedGameName, selectedServerName));
    void loadState(selectedGameName, selectedServerName).catch((error) => {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Không tải được dữ liệu bán đồ.",
      });
    });
  }

  function selectServer(serverName) {
    const selectedServerName = String(serverName || "").trim() || emptyBotConfig.serverName;
    rememberActiveSelection(activeGameName, selectedServerName);
    setConfigDraft(configForServer(botConfig, activeGameName, selectedServerName));
    void loadState(activeGameName, selectedServerName).catch((error) => {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Không tải được dữ liệu bán đồ.",
      });
    });
  }

  function rememberActiveSelection(gameName, serverName) {
    const selectedGameName = normalizeGameName(gameName);
    const selectedServerName = String(serverName || "").trim() || emptyBotConfig.serverName;
    activeGameRef.current = selectedGameName;
    activeServerRef.current = selectedServerName;
    setActiveGameName(selectedGameName);
    setActiveServerName(selectedServerName);
    try {
      localStorage.setItem("bando.activeGameName", selectedGameName);
      localStorage.setItem("bando.activeServerName", selectedServerName);
    } catch {
      // Local storage can be unavailable in private browser contexts.
    }
    return { gameName: selectedGameName, serverName: selectedServerName };
  }

  function startNewServerProfile() {
    const nextIndex = (botConfig.serverProfiles ?? []).filter((profile) => gameKey(profile.gameName) === gameKey(activeGameName)).length + 1;
    const nextServerName = `server-${nextIndex}`;
    const nextDraft = mergeBotConfig({
      ...configDraft,
      gameName: activeGameName,
      serverName: nextServerName,
      characterName: "",
      enabled: true,
      serverProfiles: botConfig.serverProfiles ?? [],
    });
    rememberActiveSelection(activeGameName, nextServerName);
    setConfigDraft(nextDraft);
    setActiveView("bot");
    setMessage({ tone: "ok", text: "Đã tạo bản nháp server mới. Nhập đúng server name và tên nhân vật BOT rồi lưu cấu hình." });
  }

  function updateStand(partial) {
    setConfigDraft((current) =>
      mergeBotConfig({
        ...current,
        stand: {
          ...current.stand,
          ...partial,
        },
      }),
    );
  }

  function updateAutoChat(partial) {
    setConfigDraft((current) =>
      mergeBotConfig({
        ...current,
        autoChat: {
          ...current.autoChat,
          ...partial,
        },
      }),
    );
  }

  function updateCoinTrade(side, partial) {
    setConfigDraft((current) =>
      mergeBotConfig({
        ...current,
        coinTrade: {
          ...current.coinTrade,
          [side]: {
            ...current.coinTrade[side],
            ...partial,
          },
        },
      }),
    );
  }

  function botConfigBody() {
    const body = {
      ...configDraft,
      characterName: configDraft.characterName.trim(),
      webBaseUrl: configDraft.webBaseUrl.trim(),
      botToken: configDraft.botToken.trim(),
      gameName: normalizeGameName(configDraft.gameName),
      serverName: configDraft.serverName.trim(),
      inventorySyncMs: numberValue(configDraft.inventorySyncMs, 15000),
      adminNames: Array.isArray(configDraft.adminNames) ? configDraft.adminNames : [],
      stand: {
        ...configDraft.stand,
        mapId: numberValue(configDraft.stand.mapId, -1),
        zoneId: numberValue(configDraft.stand.zoneId, -1),
        x: numberValue(configDraft.stand.x, 300),
        y: numberValue(configDraft.stand.y, 336),
        tolerance: numberValue(configDraft.stand.tolerance, 12),
        intervalMs: numberValue(configDraft.stand.intervalMs, 1500),
      },
      autoChat: {
        ...configDraft.autoChat,
        text: configDraft.autoChat.text.trim(),
        intervalMs: numberValue(configDraft.autoChat.intervalMs, 60000),
        communityText: configDraft.autoChat.communityText.trim(),
        communityIntervalMs: numberValue(configDraft.autoChat.communityIntervalMs, 60000),
        worldText: configDraft.autoChat.worldText.trim(),
        worldIntervalMs: numberValue(configDraft.autoChat.worldIntervalMs, 60000),
      },
      coinTrade: {
        sell: {
          enabled: Boolean(configDraft.coinTrade.sell.enabled),
          rate: numberValue(configDraft.coinTrade.sell.rate, 2.6),
        },
        importXu: {
          enabled: Boolean(configDraft.coinTrade.importXu.enabled),
          rate: numberValue(configDraft.coinTrade.importXu.rate, 2.6),
        },
      },
    };
    return upsertServerProfile(botConfig, body, activeGameName, activeServerName);
  }

  useEffect(() => {
    void loadState(activeGameName, activeServerName).catch((error) => {
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
          <label className="serverSelect">
            <span>Game</span>
            <select value={activeGameName} onChange={(event) => selectGame(event.target.value)}>
              {gameOptions.map((gameName) => (
                <option key={gameName} value={gameName}>
                  {gameName}
                </option>
              ))}
            </select>
          </label>
          <label className="serverSelect">
            <span>Server</span>
            <select value={activeServerName} onChange={(event) => selectServer(event.target.value)}>
              {serverOptions.map((server) => (
                <option key={`${server.gameName}-${server.serverName}`} value={server.serverName}>
                  {server.serverName}{server.characterName ? ` - ${server.characterName}` : ""}
                </option>
              ))}
            </select>
          </label>
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
        <button className={activeView === "bot" ? "tab active" : "tab"} onClick={() => setActiveView("bot")}>
          <Bot size={17} />
          Cấu hình BOT
        </button>
        <button className={activeView === "bank" ? "tab active" : "tab"} onClick={() => setActiveView("bank")}>
          <CreditCard size={17} />
          Tài khoản
        </button>
        <button className={activeView === "xu" ? "tab active" : "tab"} onClick={() => setActiveView("xu")}>
          <Coins size={17} />
          Bán/Nhập Xu
        </button>
        <button className={activeView === "coinHistory" ? "tab active" : "tab"} onClick={() => setActiveView("coinHistory")}>
          <ListChecks size={17} />
          Lịch sử Xu
        </button>
        <button className={activeView === "orders" ? "tab active" : "tab"} onClick={() => setActiveView("orders")}>
          <ListChecks size={17} />
          Đơn hàng
        </button>
      </nav>

      <section className="statsRow">
        <div className="statBox">
          <span>Game đang chọn</span>
          <strong>{activeGameName || configDraft.gameName}</strong>
        </div>
        <div className="statBox">
          <span>Server đang chọn</span>
          <strong>{activeServerName || configDraft.serverName}</strong>
        </div>
        <div className="statBox">
          <span>Item đang bán</span>
          <strong>{sellingItems.length}</strong>
        </div>
        <div className="statBox">
          <span>Nhân vật BOT</span>
          <strong>{configDraft.characterName || "Chưa nhập"}</strong>
        </div>
        <div className="statBox">
          <span>Đơn chờ tiền</span>
          <strong>{itemOrders.filter((order) => order.status === "awaiting_payment").length}</strong>
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
                  <th>Số lượng trong hành trang/rương</th>
                  <th>Ma QR</th>
                  <th>Prefix</th>
                  <th>Signature</th>
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
                    <td className="monoCell">{account.bankCode || "-"}</td>
                    <td className="monoCell">{account.paymentPrefix || "-"}</td>
                    <td className="monoCell">{maskSecret(account.callbackSignature) || "-"}</td>
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
                    const result = await jsonFetch("/api/bando/items/import-server", {
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
                  <span>Số lượng từ hành trang/rương BOT</span>
                  <input value={stockDraft} readOnly />
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

      {activeView === "bot" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Điều khiển trong game</span>
              <h2>Cấu hình BOT</h2>
            </div>
            <button className="toolButton" disabled={busy} onClick={startNewServerProfile}>
              <PackagePlus size={17} />
              Thêm server
            </button>
            <button
              className="primaryButton"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const body = botConfigBody();
                  rememberActiveSelection(body.gameName, body.serverName);
                  await jsonFetch("/api/bando/bot/config", {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  });
                  return "Đã lưu cấu hình BOT. Vào game bấm BANDO để BOT lấy cấu hình mới.";
                })
              }
            >
              <Save size={17} />
              Lưu cấu hình BOT
            </button>
          </div>

          <div className="configGrid">
            <div className="subPanel">
              <h3>
                <Bot size={18} />
                Nhân vật tự động
              </h3>
              <div className="formGrid two">
                <label className="checkLine">
                  <input type="checkbox" checked={configDraft.enabled} onChange={(event) => updateConfig({ enabled: event.target.checked })} />
                  Cho phép BOT hoạt động
                </label>
                <label>
                  <span>Tên nhân vật BOT</span>
                  <input value={configDraft.characterName} onChange={(event) => updateConfig({ characterName: event.target.value })} />
                </label>
                <label>
                  <span>Web API</span>
                  <input value={configDraft.webBaseUrl} onChange={(event) => updateConfig({ webBaseUrl: event.target.value })} />
                </label>
                <label>
                  <span>Game</span>
                  <select value={configDraft.gameName || defaultGameName} onChange={(event) => updateConfig({ gameName: event.target.value })}>
                    {gameOptions.map((gameName) => (
                      <option key={gameName} value={gameName}>
                        {gameName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Server name</span>
                  <input value={configDraft.serverName} onChange={(event) => updateConfig({ serverName: event.target.value })} />
                </label>
                <label>
                  <span>Bot token</span>
                  <input value={configDraft.botToken} onChange={(event) => updateConfig({ botToken: event.target.value })} />
                </label>
                <label>
                  <span>Đồng bộ hành trang mỗi ms</span>
                  <input
                    value={configDraft.inventorySyncMs}
                    onChange={(event) => updateConfig({ inventorySyncMs: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
              </div>
              <div className="serverProfileList">
                {serverOptions.map((server) => (
                  <button
                    className={profileKey(server.gameName, server.serverName) === profileKey(activeGameName, activeServerName) ? "miniButton active" : "miniButton"}
                    key={`${server.gameName}-${server.serverName}`}
                    onClick={() => selectServer(server.serverName)}
                  >
                    {server.serverName}{server.characterName ? ` - ${server.characterName}` : ""}
                  </button>
                ))}
              </div>
              <p className="hintText">
                Trong game chỉ cần đăng nhập đúng nhân vật này rồi bấm BANDO. Nếu tên nhân vật khác với cấu hình web, BOT sẽ không bật.
              </p>
            </div>

            <div className="subPanel">
              <h3>
                <MapPin size={18} />
                Vị trí đứng cố định
              </h3>
              <div className="formGrid four">
                <label className="checkLine spanAll">
                  <input
                    type="checkbox"
                    checked={configDraft.stand.enabled}
                    onChange={(event) => updateStand({ enabled: event.target.checked })}
                  />
                  Bật đứng cố định và tự về vị trí khi bấm BANDO
                </label>
                <label>
                  <span>Map</span>
                  <input value={configDraft.stand.mapId} onChange={(event) => updateStand({ mapId: event.target.value })} inputMode="numeric" />
                </label>
                <label>
                  <span>Khu</span>
                  <input value={configDraft.stand.zoneId} onChange={(event) => updateStand({ zoneId: event.target.value })} inputMode="numeric" />
                </label>
                <label>
                  <span>X</span>
                  <input value={configDraft.stand.x} onChange={(event) => updateStand({ x: event.target.value })} inputMode="numeric" />
                </label>
                <label>
                  <span>Y</span>
                  <input value={configDraft.stand.y} onChange={(event) => updateStand({ y: event.target.value })} inputMode="numeric" />
                </label>
                <label>
                  <span>Sai lệch</span>
                  <input
                    value={configDraft.stand.tolerance}
                    onChange={(event) => updateStand({ tolerance: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
                <label>
                  <span>Chu kỳ kiểm tra ms</span>
                  <input
                    value={configDraft.stand.intervalMs}
                    onChange={(event) => updateStand({ intervalMs: event.target.value })}
                    inputMode="numeric"
                  />
                </label>
              </div>
            </div>

            <div className="subPanel">
              <h3>
                <MessageSquareText size={18} />
                Auto chat
              </h3>
              <div className="formGrid two">
                <label className="checkLine">
                  <input
                    type="checkbox"
                    checked={configDraft.autoChat.enabled}
                    onChange={(event) => updateAutoChat({ enabled: event.target.checked })}
                  />
                  Bật auto chat
                </label>
                <div className="autoChatChannels spanAll">
                  <div className="channelBox">
                    <label className="checkLine">
                      <input
                        type="checkbox"
                        checked={configDraft.autoChat.community}
                        onChange={(event) => updateAutoChat({ community: event.target.checked })}
                      />
                      Chat kênh cộng đồng
                    </label>
                    <label>
                      <span>Giãn cách cộng đồng ms</span>
                      <input
                        value={configDraft.autoChat.communityIntervalMs}
                        onChange={(event) => updateAutoChat({ communityIntervalMs: event.target.value })}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      <span>Nội dung cộng đồng</span>
                      <input
                        value={configDraft.autoChat.communityText}
                        onChange={(event) => updateAutoChat({ communityText: event.target.value })}
                      />
                    </label>
                  </div>

                  <div className="channelBox">
                    <label className="checkLine">
                      <input
                        type="checkbox"
                        checked={configDraft.autoChat.world}
                        onChange={(event) => updateAutoChat({ world: event.target.checked })}
                      />
                      Chat kênh thế giới
                    </label>
                    <label>
                      <span>Giãn cách thế giới ms</span>
                      <input
                        value={configDraft.autoChat.worldIntervalMs}
                        onChange={(event) => updateAutoChat({ worldIntervalMs: event.target.value })}
                        inputMode="numeric"
                      />
                    </label>
                    <label>
                      <span>Nội dung thế giới</span>
                      <input
                        value={configDraft.autoChat.worldText}
                        onChange={(event) => updateAutoChat({ worldText: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeView === "xu" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Giao dịch xu</span>
              <h2>Bán/Nhập Xu</h2>
            </div>
            <button
              className="primaryButton"
              disabled={busy}
              onClick={() =>
                void runAction(async () => {
                  const body = botConfigBody();
                  rememberActiveSelection(body.gameName, body.serverName);
                  await jsonFetch("/api/bando/bot/config", {
                    method: "PATCH",
                    body: JSON.stringify(body),
                  });
                  return "Đã lưu cấu hình tỷ giá xu. BOT sẽ nhận tỷ giá mới khi đồng bộ web.";
                })
              }
            >
              <Save size={17} />
              Lưu tỷ giá xu
            </button>
          </div>

          <div className="coinTradeGrid">
            <div className="coinTradeBox">
              <h3>
                <Coins size={18} />
                Bán xu
              </h3>
              <label className="checkLine">
                <input
                  type="checkbox"
                  checked={configDraft.coinTrade.sell.enabled}
                  onChange={(event) => updateCoinTrade("sell", { enabled: event.target.checked })}
                />
                Bật bán xu
              </label>
              <label>
                <span>Tỷ giá bán</span>
                <input
                  value={configDraft.coinTrade.sell.rate}
                  onChange={(event) => updateCoinTrade("sell", { rate: event.target.value })}
                  inputMode="decimal"
                />
              </label>
              <div className="ratePreview">
                <span>Quy đổi</span>
                <strong>{formatVnd(1000)} = {formatXu(coinAmountForRate(configDraft.coinTrade.sell.rate))}</strong>
              </div>
            </div>

            <div className="coinTradeBox">
              <h3>
                <Coins size={18} />
                Nhập xu
              </h3>
              <label className="checkLine">
                <input
                  type="checkbox"
                  checked={configDraft.coinTrade.importXu.enabled}
                  onChange={(event) => updateCoinTrade("importXu", { enabled: event.target.checked })}
                />
                Bật nhập xu
              </label>
              <label>
                <span>Tỷ giá nhập</span>
                <input
                  value={configDraft.coinTrade.importXu.rate}
                  onChange={(event) => updateCoinTrade("importXu", { rate: event.target.value })}
                  inputMode="decimal"
                />
              </label>
              <div className="ratePreview">
                <span>Quy đổi</span>
                <strong>{formatVnd(1000)} = {formatXu(coinAmountForRate(configDraft.coinTrade.importXu.rate))}</strong>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeView === "bank" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Thanh toán</span>
              <h2>Tài khoản nhận tiền</h2>
            </div>
            <button className="toolButton" onClick={resetBankDrafts}>
              <CreditCard size={17} />
              Thêm tài khoản
            </button>
          </div>

          <div className="formGrid four bankForm">
            <label>
              <span>Ngân hàng</span>
              <input value={bankNameDraft} onChange={(event) => setBankNameDraft(event.target.value)} placeholder="VD: Vietcombank" />
            </label>
            <label>
              <span>Ma ngan hang QR</span>
              <input value={bankCodeDraft} onChange={(event) => setBankCodeDraft(event.target.value)} placeholder="VD: MB" />
            </label>
            <label>
              <span>Số tài khoản</span>
              <input value={accountNumberDraft} onChange={(event) => setAccountNumberDraft(event.target.value)} placeholder="VD: 0123456789" />
            </label>
            <label>
              <span>Chủ tài khoản</span>
              <input value={accountNameDraft} onChange={(event) => setAccountNameDraft(event.target.value)} placeholder="VD: NGUYEN VAN A" />
            </label>
            <label>
              <span>Prefix noi dung</span>
              <input value={paymentPrefixDraft} onChange={(event) => setPaymentPrefixDraft(event.target.value)} placeholder="VD: MBN" />
            </label>
            <label>
              <span>Signature callback</span>
              <input value={callbackSignatureDraft} onChange={(event) => setCallbackSignatureDraft(event.target.value)} placeholder="Dan signature tu cong bank" />
            </label>
            <label className="checkLine bankActive">
              <input type="checkbox" checked={bankActiveDraft} onChange={(event) => setBankActiveDraft(event.target.checked)} />
              Dùng cho BOT
            </label>
            <div className="spanAll bankActions">
              <button
                className="primaryButton"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    const url = selectedBankAccount
                      ? `/api/bando/bank-accounts/${selectedBankAccount.id}`
                      : "/api/bando/bank-accounts";
                    await jsonFetch(url, {
                      method: selectedBankAccount ? "PATCH" : "POST",
                      body: JSON.stringify(bankAccountBody()),
                    });
                    resetBankDrafts();
                    return "Đã lưu tài khoản nhận tiền.";
                  })
                }
              >
                <Save size={17} />
                {selectedBankAccount ? "Lưu thay đổi" : "Thêm tài khoản"}
              </button>
              {selectedBankAccount && (
                <button className="toolButton" onClick={resetBankDrafts}>
                  Bỏ chọn
                </button>
              )}
            </div>
          </div>

          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Ngân hàng</th>
                  <th>Số tài khoản</th>
                  <th>Chủ tài khoản</th>
                  <th>Trạng thái</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {state.bankAccounts.map((account) => (
                  <tr key={account.id}>
                    <td>{account.bankName}</td>
                    <td className="monoCell">{account.accountNumber}</td>
                    <td>{account.accountName}</td>
                    <td>
                      <span className={account.active ? "status paid" : "status cancelled"}>
                        {account.active ? "Đang dùng" : "Tắt"}
                      </span>
                    </td>
                    <td className="rowActions">
                      <button className="miniButton" onClick={() => selectBankAccount(account)}>
                        <Edit3 size={15} />
                        Sửa
                      </button>
                      {!account.active && (
                        <button
                          className="miniButton"
                          disabled={busy}
                          onClick={() =>
                            void runAction(async () => {
                              await jsonFetch(`/api/bando/bank-accounts/${account.id}`, {
                                method: "PATCH",
                                body: JSON.stringify({ ...account, active: true }),
                              });
                              return `Đã bật tài khoản ${account.accountNumber}.`;
                            })
                          }
                        >
                          <CheckCircle2 size={15} />
                          Dùng
                        </button>
                      )}
                      <button
                        className="miniButton muted"
                        disabled={busy}
                        onClick={() =>
                          void runAction(async () => {
                            await jsonFetch(`/api/bando/bank-accounts/${account.id}`, {
                              method: "DELETE",
                              body: JSON.stringify({}),
                            });
                            if (selectedBankAccount?.id === account.id) resetBankDrafts();
                            return `Đã xóa tài khoản ${account.accountNumber}.`;
                          })
                        }
                      >
                        <Trash2 size={15} />
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))}
                {state.bankAccounts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="emptyCell">
                      Chưa có tài khoản nhận tiền. Thêm một tài khoản để BOT gửi thông tin chuyển khoản khi tạo đơn.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeView === "coinHistory" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Lịch sử mua bán xu</span>
              <h2>Lịch sử Xu</h2>
            </div>
          </div>

          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Mã phiếu</th>
                  <th>Nhân vật</th>
                  <th>Loại</th>
                  <th>Số xu</th>
                  <th>Tỷ giá</th>
                  <th>Số tiền</th>
                  <th>Trạng thái</th>
                  <th>Thông tin nhận tiền</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(state.coinTrades ?? []).map((trade) => (
                  <tr key={trade.orderCode}>
                    <td>{trade.orderCode}</td>
                    <td>{trade.characterName}</td>
                    <td>{coinTradeTypeLabel(trade.type)}</td>
                    <td>{formatXu(trade.receivedCoinAmount || trade.coinAmount)}</td>
                    <td>{formatVnd(1000)} = {formatXu(coinAmountForRate(trade.rate))}</td>
                    <td>{formatVnd(trade.totalAmount)}</td>
                    <td>
                      <span className={`status ${trade.status}`}>{coinTradeStatusLabel(trade.status, trade.type)}</span>
                    </td>
                    <td>
                      {trade.bankName || trade.accountNumber || trade.accountName
                        ? `${trade.bankName} - ${trade.accountNumber} - ${trade.accountName}`
                        : "-"}
                    </td>
                    <td className="rowActions">
                      {trade.type === "buy_xu" && trade.status === "awaiting_payment" && (
                        <button
                          className="miniButton"
                          disabled={busy}
                          onClick={() =>
                            void runAction(async () => {
                              await jsonFetch(`/api/bando/orders/${trade.orderCode}/approve`, {
                                method: "POST",
                                body: JSON.stringify({ note: "Admin duyệt mua xu trên web" }),
                              });
                              return `Đã duyệt mua xu ${trade.orderCode}. BOT sẽ giao xu khi khách mời giao dịch.`;
                            })
                          }
                        >
                          <CheckCircle2 size={15} />
                          Duyệt mua
                        </button>
                      )}
                      {trade.type === "sell_xu" && trade.status === "completed" && (
                        <button
                          className="miniButton"
                          disabled={busy || !trade.bankName || !trade.accountNumber || !trade.accountName}
                          onClick={() =>
                            void runAction(async () => {
                              await jsonFetch(`/api/bando/coin-trades/${trade.orderCode}/payout/approve`, {
                                method: "POST",
                                body: JSON.stringify({ note: "Admin duyệt trả tiền bán xu trên web" }),
                              });
                              return `Đã duyệt trả tiền phiếu ${trade.orderCode}.`;
                            })
                          }
                        >
                          <CheckCircle2 size={15} />
                          {trade.bankName && trade.accountNumber && trade.accountName ? "Duyệt trả tiền" : "Thiếu STK"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {(state.coinTrades ?? []).length === 0 && (
                  <tr>
                    <td colSpan={9} className="emptyCell">
                      Chưa có lịch sử mua bán xu.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {itemOrders.map((order) => (
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
                    <td className="rowActions">
                      {order.status === "awaiting_payment" && (
                        <button
                          className="miniButton"
                          disabled={busy}
                          onClick={() =>
                            void runAction(async () => {
                              await jsonFetch(`/api/bando/orders/${order.orderCode}/approve`, {
                                method: "POST",
                                body: JSON.stringify({ note: "Admin duyệt tay trên web" }),
                              });
                              return `Đã duyệt tay đơn ${order.orderCode}. BOT sẽ nhắn người mua giao dịch để nhận vật phẩm.`;
                            })
                          }
                        >
                          <CheckCircle2 size={15} />
                          Duyệt tay
                        </button>
                      )}
                      {order.status === "paid" && <span className="hintText inline">Chờ BOT giao</span>}
                    </td>
                  </tr>
                ))}
                {itemOrders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="emptyCell">
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
