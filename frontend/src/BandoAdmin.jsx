import {
  BarChart3,
  CheckCircle2,
  Bot,
  Coins,
  CreditCard,
  DatabaseZap,
  Edit3,
  ListChecks,
  LockKeyhole,
  LogIn,
  LogOut,
  MapPin,
  MessageSquareText,
  PackagePlus,
  RefreshCcw,
  Save,
  Search,
  Store,
  ToggleLeft,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatVnd } from "./utils/format.js";

const apiBaseUrl = import.meta.env.VITE_API_URL?.trim() || "";
const numberFormatter = new Intl.NumberFormat("vi-VN");
const gameOptionsDefault = ["Ninja Mobile", "Ninja 2D"];
const defaultGameName = "Ninja Mobile";
const authStorageKey = "bando.adminToken";
let authTokenMemory = readStoredAuthToken();
const defaultWebBaseUrl = getPublicBrowserOrigin() || "http://localhost:5001";

const emptyState = {
  items: [],
  orders: [],
  coinTrades: [],
  transactions: [],
  bankAccounts: [],
  gameServers: [],
  events: [],
  storage: "memory",
};

const emptyStatistics = {
  totals: {
    soldOrders: 0,
    soldXu: 0,
    soldMoney: 0,
    importedOrders: 0,
    importedXu: 0,
    importedMoney: 0,
    netIncome: 0,
    buffedXu: 0,
  },
  byServer: [],
  buffedEntries: [],
  buffedXuCanEdit: false,
  adjustment: {
    buffedXu: 0,
    updatedBy: "",
    updatedAt: "",
  },
  storage: "memory",
};

const emptyBotConfig = {
  enabled: true,
  characterName: "ADMIN",
  webBaseUrl: defaultWebBaseUrl,
  botToken: "",
  gameName: defaultGameName,
  serverName: "nso-local",
  custom: false,
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

function readStoredAuthToken() {
  try {
    return localStorage.getItem(authStorageKey) || "";
  } catch {
    return "";
  }
}

function setStoredAuthToken(token) {
  authTokenMemory = String(token || "");
  try {
    if (authTokenMemory) {
      localStorage.setItem(authStorageKey, authTokenMemory);
    } else {
      localStorage.removeItem(authStorageKey);
    }
  } catch {
    // Storage can be unavailable in some browser contexts.
  }
}

function getPublicBrowserOrigin() {
  if (typeof window === "undefined" || !window.location) return "";
  const origin = String(window.location.origin || "").trim();
  const hostname = String(window.location.hostname || "").trim().toLowerCase();
  if (!origin || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return "";
  return origin;
}

function isLocalWebBaseUrl(value) {
  const text = String(value || "").trim().toLowerCase();
  return (
    text.startsWith("http://localhost") ||
    text.startsWith("https://localhost") ||
    text.startsWith("http://127.0.0.1") ||
    text.startsWith("https://127.0.0.1")
  );
}

function normalizeWebBaseUrl(value) {
  const text = String(value || "").trim();
  const publicOrigin = getPublicBrowserOrigin();
  if (publicOrigin && (!text || isLocalWebBaseUrl(text))) return publicOrigin;
  return text || defaultWebBaseUrl;
}

async function jsonFetch(url, init = {}) {
  const { skipAuth, ...requestInit } = init;
  const headers = new Headers(requestInit?.headers);
  headers.set("content-type", "application/json");
  if (!skipAuth && authTokenMemory) {
    headers.set("authorization", `Bearer ${authTokenMemory}`);
  }
  const response = await fetch(`${apiBaseUrl}${url}`, {
    ...requestInit,
    headers,
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    throw new Error("API không trả JSON. Hãy kiểm tra backend đang chạy đúng port và đúng bản code.");
  }
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

function itemCodeFor(item, itemIdDraft, buyNameDraft, gameName, serverName) {
  if (item?.code) return item.code;
  const itemIdText = itemIdDraft.trim();
  if (itemIdText) {
    const itemId = Number(itemIdText);
    if (Number.isInteger(itemId) && itemId >= 0) return scopedItemCode(gameName, serverName, itemId);
  }
  return buyNameDraft.trim().toLowerCase().replace(/\s+/g, "-");
}

function scopedItemCode(gameName, serverName, itemId) {
  return `${slugPart(gameName, "game")}-${slugPart(serverName, "server")}-item-${itemId}`.slice(0, 96);
}

function slugPart(value, fallback) {
  const text = String(value || fallback)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (text || fallback).slice(0, 28);
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
  merged.webBaseUrl = normalizeWebBaseUrl(merged.webBaseUrl);
  merged.custom = Boolean(config?.custom);
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
      custom: Boolean(profile.custom),
    };
    normalized.webBaseUrl = normalizeWebBaseUrl(normalized.webBaseUrl);
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

function findServerProfile(config, gameName, serverName) {
  const normalized = mergeBotConfig(config);
  const key = profileKey(gameName || normalized.gameName, serverName || normalized.serverName);
  if (profileKey(normalized.gameName, normalized.serverName) === key) return normalized;
  return normalized.serverProfiles.find((entry) => profileKey(entry.gameName, entry.serverName) === key) || null;
}

function isGameServerConfigured(gameServers, gameName, serverName) {
  const key = profileKey(gameName, serverName);
  return (gameServers ?? []).some((server) => profileKey(server.gameName, server.name) === key);
}

function isKnownServer(config, gameServers, gameName, serverName) {
  if (!serverKey(serverName)) return false;
  if (isGameServerConfigured(gameServers, gameName, serverName)) return true;
  const profile = findServerProfile(config, gameName, serverName);
  return Boolean(profile?.custom);
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

function configForServer(config, gameName, serverName, gameServers = []) {
  const normalized = mergeBotConfig(config);
  const key = profileKey(gameName || normalized.gameName, serverName || normalized.serverName);
  const profile = normalized.serverProfiles.find((entry) => profileKey(entry.gameName, entry.serverName) === key);
  if (!profile) {
    const isRootProfile = profileKey(normalized.gameName, normalized.serverName) === key;
    return mergeBotConfig({
      ...normalized,
      gameName: normalizeGameName(gameName || normalized.gameName),
      serverName: String(serverName || normalized.serverName || emptyBotConfig.serverName).trim(),
      characterName: isRootProfile ? normalized.characterName : "",
      custom: !isGameServerConfigured(gameServers, gameName || normalized.gameName, serverName || normalized.serverName),
    });
  }
  return mergeBotConfig({
    ...normalized,
    ...profile,
    serverProfiles: normalized.serverProfiles,
  });
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

function todayDateInputValue() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function formatSignedVnd(amount) {
  const numeric = Math.trunc(Number(amount) || 0);
  const sign = numeric >= 0 ? "+" : "-";
  return `${sign}${formatVnd(Math.abs(numeric))}`;
}

function statisticsQuery(fromDate, toDate) {
  const params = new URLSearchParams();
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);
  return params.toString() ? `?${params.toString()}` : "";
}

export default function BandoAdmin() {
  const [state, setState] = useState(emptyState);
  const [authReady, setAuthReady] = useState(false);
  const [authUser, setAuthUser] = useState(null);
  const [authHasUsers, setAuthHasUsers] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [newAdminUsername, setNewAdminUsername] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
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
  const [statsFromDate, setStatsFromDate] = useState(todayDateInputValue());
  const [statsToDate, setStatsToDate] = useState(todayDateInputValue());
  const [statistics, setStatistics] = useState(emptyStatistics);
  const [buffedXuDraft, setBuffedXuDraft] = useState("");
  const [buffedXuDateDraft, setBuffedXuDateDraft] = useState(todayDateInputValue());
  const [buffedXuNoteDraft, setBuffedXuNoteDraft] = useState("");
  const [editingBuffedEntry, setEditingBuffedEntry] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
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

  const buyCoinTrades = useMemo(
    () => (state.coinTrades ?? []).filter((trade) => trade.type === "buy_xu"),
    [state.coinTrades],
  );

  const sellCoinTrades = useMemo(
    () => (state.coinTrades ?? []).filter((trade) => trade.type === "sell_xu"),
    [state.coinTrades],
  );

  const statsTotals = statistics?.totals ?? emptyStatistics.totals;
  const statsRows = statistics?.byServer ?? [];
  const statsBuffedEntries = statistics?.buffedEntries ?? [];

  const gameOptions = useMemo(() => {
    const options = new Map(gameOptionsDefault.map((name) => [gameKey(name), name]));
    const addOption = (profile) => {
      const name = normalizeGameName(profile?.gameName);
      options.set(gameKey(name), name);
    };
    addOption(botConfig);
    (botConfig.serverProfiles ?? []).forEach(addOption);
    addOption(configDraft);
    (state.gameServers ?? []).forEach(addOption);
    return Array.from(options.values());
  }, [botConfig, configDraft, state.gameServers]);

  const serverOptions = useMemo(() => {
    const options = new Map();
    const normalizedConfig = mergeBotConfig(botConfig);
    (state.gameServers ?? []).forEach((server) => {
      if (gameKey(server.gameName) !== gameKey(activeGameName)) return;
      const serverName = String(server.name || "").trim();
      if (!serverName) return;
      const profile = findServerProfile(normalizedConfig, server.gameName, serverName);
      options.set(profileKey(server.gameName, serverName), {
        gameName: normalizeGameName(server.gameName),
        serverName,
        characterName: profile ? String(profile.characterName || "").trim() : "",
        source: "db",
      });
    });
    (normalizedConfig.serverProfiles ?? []).forEach((profile) => {
      if (!profile.custom || gameKey(profile.gameName) !== gameKey(activeGameName)) return;
      const serverName = String(profile.serverName || "").trim();
      if (!serverName) return;
      const key = profileKey(profile.gameName, serverName);
      if (options.has(key)) return;
      options.set(key, {
        gameName: normalizeGameName(profile.gameName),
        serverName,
        characterName: String(profile.characterName || "").trim(),
        source: "custom",
      });
    });
    if (activeServerName && isKnownServer(normalizedConfig, state.gameServers, activeGameName, activeServerName)) {
      const key = profileKey(activeGameName, activeServerName);
      if (!options.has(key)) {
        const profile = findServerProfile(normalizedConfig, activeGameName, activeServerName);
        options.set(key, {
          gameName: activeGameName,
          serverName: activeServerName,
          characterName: profile ? String(profile.characterName || "").trim() : "",
          source: profile?.custom ? "custom" : "db",
        });
      }
    }
    return Array.from(options.values());
  }, [activeGameName, activeServerName, botConfig, configDraft, state.gameServers]);

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
    const dbServer = (state.gameServers ?? []).find((server) => gameKey(server.gameName) === gameKey(gameName))?.name || "";
    if (dbServer) return dbServer;
    const customProfile = (normalized.serverProfiles ?? []).find(
      (profile) => profile.custom && gameKey(profile.gameName) === gameKey(gameName) && String(profile.serverName || "").trim(),
    );
    if (customProfile) return customProfile.serverName;
    return profileKey(normalized.gameName, normalized.serverName) && gameKey(normalized.gameName) === gameKey(gameName) ? normalized.serverName : "";
  }

  async function loadState(
    gameNameOverride = activeGameRef.current || activeGameName,
    serverNameOverride = activeServerRef.current || activeServerName,
  ) {
    const configPayload = await jsonFetch("/api/bando/bot/config");
    const nextConfig = mergeBotConfig(configPayload.config);
    const selectedGameName = normalizeGameName(gameNameOverride || nextConfig.gameName || defaultGameName);
    let selectedServerName = String(serverNameOverride || "").trim();
    let nextState = await jsonFetch(`/api/bando/history${serverQuery(selectedGameName, selectedServerName)}`);
    if (!isKnownServer(nextConfig, nextState.gameServers, selectedGameName, selectedServerName)) {
      selectedServerName =
        (nextState.gameServers ?? []).find((server) => gameKey(server.gameName) === gameKey(selectedGameName))?.name ||
        firstServerForGame(nextConfig, selectedGameName) ||
        "";
      if (selectedServerName) {
        nextState = await jsonFetch(`/api/bando/history${serverQuery(selectedGameName, selectedServerName)}`);
      }
    }
    rememberActiveSelection(selectedGameName, selectedServerName);
    setState(nextState);
    setBotConfig(nextConfig);
    setConfigDraft(configForServer(nextConfig, selectedGameName, selectedServerName, nextState.gameServers));
  }

  async function loadStatistics(fromDate = statsFromDate, toDate = statsToDate) {
    setStatsLoading(true);
    try {
      const payload = await jsonFetch(`/api/bando/statistics${statisticsQuery(fromDate, toDate)}`);
      setStatistics(payload);
      setEditingBuffedEntry(null);
      setBuffedXuDraft("");
      setBuffedXuDateDraft(toDate || todayDateInputValue());
      setBuffedXuNoteDraft("");
      return payload;
    } finally {
      setStatsLoading(false);
    }
  }

  async function bootAuth() {
    try {
      const payload = await jsonFetch("/api/bando/auth/status", {});
      setAuthHasUsers(Boolean(payload.hasUsers));
      setAuthMode(payload.hasUsers ? "login" : "register");
      if (payload.user) {
        setAuthUser(payload.user);
        await loadState(activeGameRef.current || activeGameName, activeServerRef.current || activeServerName);
      } else {
        setState(emptyState);
      }
    } catch {
      setStoredAuthToken("");
      setAuthUser(null);
      setAuthMode("login");
      setState(emptyState);
    } finally {
      setAuthReady(true);
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const endpoint = authMode === "register" ? "/api/bando/auth/register" : "/api/bando/auth/login";
      const payload = await jsonFetch(endpoint, {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({
          username: authUsername,
          password: authPassword,
        }),
      });
      setStoredAuthToken(payload.token);
      setAuthUser(payload.user);
      setAuthHasUsers(true);
      setAuthPassword("");
      await loadState(activeGameRef.current || activeGameName, activeServerRef.current || activeServerName);
      setMessage({ tone: "ok", text: authMode === "register" ? "Đã tạo tài khoản quản trị." : "Đã đăng nhập." });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "Không đăng nhập được.",
      });
    } finally {
      setBusy(false);
    }
  }

  function logoutAdmin() {
    setStoredAuthToken("");
    setAuthUser(null);
    setState(emptyState);
    setMessage(null);
    setAuthMode("login");
  }

  function resetNewAdminDrafts() {
    setNewAdminUsername("");
    setNewAdminPassword("");
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

  async function runStatsAction(action) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await action();
      await loadStatistics();
      setMessage({ tone: "ok", text });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "CÃ³ lá»—i khÃ´ng xÃ¡c Ä‘á»‹nh.",
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

  function editBuffedEntry(entry) {
    setEditingBuffedEntry(entry);
    setBuffedXuDraft(String(entry.amount ?? 0));
    setBuffedXuDateDraft(entry.buffedDate || statsToDate || todayDateInputValue());
    setBuffedXuNoteDraft(entry.note || "");
  }

  function resetBuffedDraft() {
    setEditingBuffedEntry(null);
    setBuffedXuDraft("");
    setBuffedXuDateDraft(statsToDate || todayDateInputValue());
    setBuffedXuNoteDraft("");
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
    const code = itemCodeFor(selectedItem, itemIdDraft, buyNameDraft, activeGameName, activeServerName);
    return {
      code,
      gameName: activeGameName,
      serverName: activeServerName,
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
    setConfigDraft(configForServer(botConfig, selectedGameName, selectedServerName, state.gameServers));
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
    setConfigDraft(configForServer(botConfig, activeGameName, selectedServerName, state.gameServers));
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
      custom: true,
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
      webBaseUrl: normalizeWebBaseUrl(configDraft.webBaseUrl),
      botToken: configDraft.botToken.trim(),
      gameName: normalizeGameName(configDraft.gameName),
      serverName: configDraft.serverName.trim(),
      custom: !isGameServerConfigured(state.gameServers, configDraft.gameName, configDraft.serverName),
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

  function renderBuyCoinTradeRows(trades) {
    return (
      <>
        {trades.map((trade) => (
          <tr key={trade.orderCode}>
            <td>{trade.orderCode}</td>
            <td>{trade.characterName}</td>
            <td>{formatXu(trade.coinAmount)}</td>
            <td>{formatVnd(1000)} = {formatXu(coinAmountForRate(trade.rate))}</td>
            <td>{formatVnd(trade.totalAmount)}</td>
            <td>
              <span className={`status ${trade.status}`}>{coinTradeStatusLabel(trade.status, trade.type)}</span>
            </td>
            <td className="rowActions">
              {trade.status === "awaiting_payment" && (
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
            </td>
          </tr>
        ))}
        {trades.length === 0 && (
          <tr>
            <td colSpan={7} className="emptyCell">
              Chưa có lịch sử khách mua xu.
            </td>
          </tr>
        )}
      </>
    );
  }

  function renderSellCoinTradeRows(trades) {
    return (
      <>
        {trades.map((trade) => (
          <tr key={trade.orderCode}>
            <td>{trade.orderCode}</td>
            <td>{trade.characterName}</td>
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
              {trade.status === "completed" && (
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
        {trades.length === 0 && (
          <tr>
            <td colSpan={8} className="emptyCell">
              Chưa có lịch sử khách bán xu.
            </td>
          </tr>
        )}
      </>
    );
  }

  useEffect(() => {
    void bootAuth();
  }, []);

  useEffect(() => {
    if (!authUser || activeView !== "statistics") return;
    void loadStatistics().catch((error) => {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : "KhÃ´ng táº£i Ä‘Æ°á»£c thá»‘ng kÃª.",
      });
    });
  }, [authUser, activeView, statsFromDate, statsToDate]);

  if (!authReady) {
    return (
      <main className="adminShell authShell">
        <section className="authPanel">
          <LockKeyhole size={28} />
          <h1>Đang kiểm tra đăng nhập</h1>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="adminShell authShell">
        <section className="authPanel">
          <div className="authTitle">
            <LockKeyhole size={28} />
            <div>
              <span className="kicker">Bảo mật web bán đồ</span>
              <h1>{authMode === "register" ? "Tạo tài khoản quản trị" : "Đăng nhập quản trị"}</h1>
            </div>
          </div>
          <form className="authForm" onSubmit={submitAuth}>
            <label>
              <span>Tên đăng nhập</span>
              <input value={authUsername} onChange={(event) => setAuthUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              <span>Mật khẩu</span>
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                autoComplete={authMode === "register" ? "new-password" : "current-password"}
              />
            </label>
            <button className="primaryButton wide" disabled={busy} type="submit">
              {authMode === "register" ? <UserPlus size={17} /> : <LogIn size={17} />}
              {authMode === "register" ? "Tạo tài khoản" : "Đăng nhập"}
            </button>
          </form>
          <button
            className="toolButton wide"
            type="button"
            onClick={() => setAuthMode(authMode === "register" ? "login" : "register")}
          >
            {authMode === "register" ? "Tôi đã có tài khoản" : "Tạo tài khoản"}
          </button>
          {authHasUsers && authMode === "register" && (
            <p className="hintText">Nếu web đã có tài khoản quản trị, hãy đăng nhập trước để tạo thêm tài khoản.</p>
          )}
          {message && <div className={`notice ${message.tone}`}>{message.text}</div>}
        </section>
      </main>
    );
  }

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
          <span className="dbBadge">
            <LockKeyhole size={16} />
            {authUser.username}
          </span>
          <button className="toolButton" disabled={busy} onClick={() => void loadState()}>
            <RefreshCcw size={17} />
            Tải lại
          </button>
          <button className="toolButton" onClick={logoutAdmin}>
            <LogOut size={17} />
            Đăng xuất
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
        <button className={activeView === "admin" ? "tab active" : "tab"} onClick={() => setActiveView("admin")}>
          <UserPlus size={17} />
          Admin
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
        <button className={activeView === "statistics" ? "tab active" : "tab"} onClick={() => setActiveView("statistics")}>
          <BarChart3 size={17} />
          Thống kê
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
                            await jsonFetch("/api/bando/prices", {
                              method: "PATCH",
                              body: JSON.stringify({
                                code: item.code,
                                gameName: activeGameName,
                                serverName: activeServerName,
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
                      body: JSON.stringify({
                        gameName: activeGameName,
                        serverName: activeServerName,
                      }),
                    });
                    return `Đã đồng bộ ${result.imported} item từ DB của ${activeGameName} / ${activeServerName}.`;
                  })
                }
              >
                <RefreshCcw size={17} />
                Đồng bộ DB server
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
                  <small>{item.active && item.sellPrice > 0 ? "Đang bán" : "chưa bán"}</small>
                </button>
              ))}
              {searchResults.length === 0 && <div className="emptyBlock">Không tìm thấy item của game/server đang chọn trong DB bando.</div>}
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
                  <select value={configDraft.gameName || defaultGameName} onChange={(event) => selectGame(event.target.value)}>
                    {gameOptions.map((gameName) => (
                      <option key={gameName} value={gameName}>
                        {gameName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Server name</span>
                  {configDraft.custom ? (
                    <input value={configDraft.serverName} onChange={(event) => updateConfig({ serverName: event.target.value, custom: true })} />
                  ) : (
                    <select value={configDraft.serverName} onChange={(event) => selectServer(event.target.value)}>
                      {serverOptions.map((server) => (
                        <option key={`${server.gameName}-${server.serverName}`} value={server.serverName}>
                          {server.serverName}
                        </option>
                      ))}
                    </select>
                  )}
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

      {activeView === "admin" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Bảo mật</span>
              <h2>Tài khoản quản trị</h2>
            </div>
            <span className="dbBadge">
              <LockKeyhole size={16} />
              Đang đăng nhập: {authUser.username}
            </span>
          </div>

          <div className="formGrid two">
            <label>
              <span>Tên đăng nhập mới</span>
              <input
                value={newAdminUsername}
                onChange={(event) => setNewAdminUsername(event.target.value)}
                placeholder="VD: admin2"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Mật khẩu mới</span>
              <input
                type="password"
                value={newAdminPassword}
                onChange={(event) => setNewAdminPassword(event.target.value)}
                placeholder="Tối thiểu 4 ký tự"
                autoComplete="new-password"
              />
            </label>
            <div className="spanAll rowActions">
              <button
                className="primaryButton"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    const username = newAdminUsername.trim().toLowerCase();
                    await jsonFetch("/api/bando/auth/register", {
                      method: "POST",
                      body: JSON.stringify({
                        username: newAdminUsername,
                        password: newAdminPassword,
                      }),
                    });
                    resetNewAdminDrafts();
                    return `Đã tạo tài khoản quản trị ${username}.`;
                  })
                }
              >
                <UserPlus size={17} />
                Tạo tài khoản
              </button>
              <button className="toolButton" type="button" onClick={resetNewAdminDrafts}>
                Xóa nhập liệu
              </button>
            </div>
          </div>

          <p className="hintText">
            Chỉ tài khoản admin đang đăng nhập mới tạo thêm được tài khoản quản trị. Mật khẩu cần tối thiểu 4 ký tự.
          </p>
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

          <div className="historySplit">
            <div className="historyBlock">
              <div className="historyBlockHeader">
                <div>
                  <span className="kicker">BOT bán xu cho khách</span>
                  <h3>Khách mua xu</h3>
                </div>
                <span className="dbBadge">{buyCoinTrades.length} phiếu</span>
              </div>
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Mã phiếu</th>
                      <th>Nhân vật</th>
                      <th>Số xu mua</th>
                      <th>Tỷ giá</th>
                      <th>Khách trả</th>
                      <th>Trạng thái</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>{renderBuyCoinTradeRows(buyCoinTrades)}</tbody>
                </table>
              </div>
            </div>

            <div className="historyBlock">
              <div className="historyBlockHeader">
                <div>
                  <span className="kicker">BOT nhập xu từ khách</span>
                  <h3>Khách bán xu</h3>
                </div>
                <span className="dbBadge">{sellCoinTrades.length} phiếu</span>
              </div>
              <div className="dataTableWrap">
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Mã phiếu</th>
                      <th>Nhân vật</th>
                      <th>Số xu nhận</th>
                      <th>Tỷ giá</th>
                      <th>Phải trả khách</th>
                      <th>Trạng thái</th>
                      <th>Thông tin nhận tiền</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>{renderSellCoinTradeRows(sellCoinTrades)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}

      {activeView === "statistics" && (
        <section className="panel">
          <div className="panelHeader">
            <div>
              <span className="kicker">Toàn bộ game và server</span>
              <h2>Thống kê</h2>
            </div>
            <button
              className="toolButton"
              disabled={busy || statsLoading}
              onClick={() =>
                void loadStatistics().catch((error) => {
                  setMessage({
                    tone: "error",
                    text: error instanceof Error ? error.message : "Không tải được thống kê.",
                  });
                })
              }
            >
              <RefreshCcw size={17} />
              Tải thống kê
            </button>
          </div>

          <div className="formGrid four statsFilterGrid">
            <label>
              <span>Từ ngày</span>
              <input type="date" value={statsFromDate} onChange={(event) => setStatsFromDate(event.target.value)} />
            </label>
            <label>
              <span>Tới ngày</span>
              <input type="date" value={statsToDate} onChange={(event) => setStatsToDate(event.target.value)} />
            </label>
            <div className="statRangeNote">
              Dữ liệu được tính trên tất cả game/server trong khoảng ngày đã chọn.
            </div>
          </div>

          <div className="statsRow statisticsRow">
            <div className="statBox">
              <span>Số xu đã bán</span>
              <strong>{formatXu(statsTotals.soldXu)}</strong>
            </div>
            <div className="statBox">
              <span>Số tiền đã bán được</span>
              <strong>{formatVnd(statsTotals.soldMoney)}</strong>
            </div>
            <div className="statBox">
              <span>Số xu đã nhập</span>
              <strong>{formatXu(statsTotals.importedXu)}</strong>
            </div>
            <div className="statBox">
              <span>Số tiền đã nhập xu</span>
              <strong>{formatVnd(statsTotals.importedMoney)}</strong>
            </div>
            <div className="statBox">
              <span>Tổng thu nhập</span>
              <strong>{formatSignedVnd(statsTotals.netIncome)}</strong>
            </div>
            <div className="statBox">
              <span>Số xu đã buff</span>
              <strong>{formatXu(statsTotals.buffedXu)}</strong>
            </div>
          </div>

          <div className="subPanel statsBuffPanel">
            <h3>
              <BarChart3 size={18} />
              Xu đã buff thủ công
            </h3>
            <div className="formGrid three">
              <label>
                <span>Ngày buff</span>
                <input
                  type="date"
                  value={buffedXuDateDraft}
                  min={statsFromDate}
                  max={statsToDate}
                  onChange={(event) => setBuffedXuDateDraft(event.target.value)}
                  disabled={!statistics?.buffedXuCanEdit}
                />
              </label>
              <label>
                <span>Số xu cộng thêm</span>
                <input
                  value={buffedXuDraft}
                  onChange={(event) => setBuffedXuDraft(event.target.value)}
                  inputMode="numeric"
                  disabled={!statistics?.buffedXuCanEdit}
                  placeholder="VD: 1000000 hoặc 1.000.000"
                />
              </label>
              <label>
                <span>Ghi chú</span>
                <input
                  value={buffedXuNoteDraft}
                  onChange={(event) => setBuffedXuNoteDraft(event.target.value)}
                  disabled={!statistics?.buffedXuCanEdit}
                  placeholder="VD: Buff cho khách A"
                />
              </label>
              <div className="statRangeNote">
                {statistics?.buffedXuCanEdit
                  ? "Bạn có quyền sửa số xu buff cho khoảng ngày này."
                  : "Chỉ tài khoản datxt998 được sửa số xu đã buff."}
                {statistics?.adjustment?.updatedAt
                  ? ` Cập nhật gần nhất bởi ${statistics.adjustment.updatedBy || "-"} lúc ${statistics.adjustment.updatedAt}.`
                  : ""}
              </div>
              <button
                className="primaryButton"
                disabled={busy || statsLoading || !statistics?.buffedXuCanEdit}
                onClick={() =>
                  void runStatsAction(async () => {
                    await jsonFetch("/api/bando/statistics/buffed-xu", {
                      method: "PATCH",
                      body: JSON.stringify({
                        id: editingBuffedEntry?.id,
                        fromDate: statsFromDate,
                        toDate: statsToDate,
                        buffedDate: buffedXuDateDraft,
                        amount: buffedXuDraft,
                        note: buffedXuNoteDraft,
                      }),
                    });
                    return editingBuffedEntry ? "Đã lưu sửa dòng xu buff." : "Đã thêm lịch sử xu buff.";
                  })
                }
              >
                <Save size={17} />
                {editingBuffedEntry ? "Lưu sửa" : "Thêm lượt buff"}
              </button>
              {editingBuffedEntry && (
                <button className="toolButton" type="button" onClick={resetBuffedDraft}>
                  Hủy sửa
                </button>
              )}
            </div>
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Ngày</th>
                    <th>Số xu</th>
                    <th>Ghi chú</th>
                    <th>Người sửa</th>
                    <th>Cập nhật</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {statsBuffedEntries.map((entry) => (
                    <tr key={entry.id}>
                      <td>{entry.buffedDate}</td>
                      <td>{formatXu(entry.amount)}</td>
                      <td>{entry.note || "-"}</td>
                      <td>{entry.updatedBy || entry.createdBy || "-"}</td>
                      <td>{entry.updatedAt || entry.createdAt || "-"}</td>
                      <td className="rowActions">
                        <button
                          className="miniButton"
                          disabled={!statistics?.buffedXuCanEdit}
                          onClick={() => editBuffedEntry(entry)}
                        >
                          <Edit3 size={15} />
                          Sửa
                        </button>
                      </td>
                    </tr>
                  ))}
                  {statsBuffedEntries.length === 0 && (
                    <tr>
                      <td colSpan={6} className="emptyCell">
                        Chưa có lịch sử xu buff trong khoảng ngày này.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="dataTableWrap">
            <table className="dataTable">
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Server</th>
                  <th>Xu đã bán</th>
                  <th>Tiền đã bán</th>
                  <th>Xu đã nhập</th>
                  <th>Tiền đã nhập xu</th>
                  <th>Thu nhập</th>
                </tr>
              </thead>
              <tbody>
                {statsRows.map((row) => (
                  <tr key={`${row.gameName}-${row.serverName}`}>
                    <td>{row.gameName}</td>
                    <td>{row.serverName}</td>
                    <td>{formatXu(row.soldXu)}</td>
                    <td>{formatVnd(row.soldMoney)}</td>
                    <td>{formatXu(row.importedXu)}</td>
                    <td>{formatVnd(row.importedMoney)}</td>
                    <td>{formatSignedVnd(row.netIncome)}</td>
                  </tr>
                ))}
                {statsRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="emptyCell">
                      Chưa có dữ liệu thống kê trong khoảng ngày này.
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
                  <th>Nội dung CK</th>
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
