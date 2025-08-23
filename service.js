/**
 * EMA crossover bot (LONG+SHORT) with Mongo Atlas (native driver) + Express APIs
 * - GOLDEN cross (EMA_FAST above EMA_SLOW): if SHORT open -> close SHORT & open LONG; if flat -> open LONG
 * - DEATH cross  (EMA_FAST below EMA_SLOW): if LONG  open -> close LONG  & open SHORT; if flat -> open SHORT
 *
 * Install:
 *   npm i axios technicalindicators express cors dotenv mongodb
 *
 * .env example:
 *   MONGO_URI=mongodb+srv://<user>:<pass>@<cluster>/   # your Atlas URI (no dbName in URI)
 *   DB_NAME=btcbotema
 *   SYMBOL=BTCUSDT
 *   INTERVAL=1m
 *   EMA_FAST=7
 *   EMA_SLOW=10
 *   DRY_RUN=false
 *   PORT=4000
 */

import axios from "axios";
import { EMA } from "technicalindicators";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

/* ========= Config ========= */
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const INTERVAL = process.env.INTERVAL || "1m";
const EMA_FAST = Number(process.env.EMA_FAST || 20);
const EMA_SLOW = Number(process.env.EMA_SLOW || 200);
if (EMA_FAST >= EMA_SLOW) {
  console.warn("[WARN] EMA_FAST should be < EMA_SLOW for traditional crossovers.");
}
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 4444);

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://ArvindETH:Arvind2001@tracktohack.2rudkmv.mongodb.net/?retryWrites=true&w=majority&appName=TrackToHack";
const DB_NAME = process.env.DB_NAME || "btcbotema";

const API_URL = "https://api.binance.com/api/v3/klines";

/* ========= Mongo (native driver) ========= */
let mongoClient;
let db;
let positionsCol; // collection: positions

async function connectMongo() {
  if (DRY_RUN) return; // skip connecting in DRY_RUN
  if (mongoClient) return;

  mongoClient = new MongoClient(MONGO_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  });
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  positionsCol = db.collection("positions");

  // helpful indexes
  await positionsCol.createIndex({ status: 1, symbol: 1, createdAt: -1 });
  await positionsCol.createIndex({ symbol: 1, positionType: 1, createdAt: -1 });

  console.log(`[${ts()}] ✅ Mongo connected (db=${DB_NAME})`);
}

/* ========= State ========= */
let isTickRunning = false;
let openPosition = null; // { _id, positionType: "LONG"|"SHORT", ... }
let cached = {
  price: null,
  emaFast: null,
  emaSlow: null,
  signal: "NONE", // GOLDEN | DEATH | NONE
  lastTickAt: null,
};

/* ========= Utils ========= */
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function detectCross(prevFast, prevSlow, fast, slow) {
  if (prevFast < prevSlow && fast > slow) return "GOLDEN";
  if (prevFast > prevSlow && fast < slow) return "DEATH";
  return "NONE";
}

async function restoreOpenPosition() {
  if (DRY_RUN) return;
  const doc = await positionsCol
    .find({ symbol: SYMBOL, status: "OPEN" })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  openPosition = doc[0] || null;
}

async function fetchCloses(limit = EMA_SLOW + 50) {
  const url = `${API_URL}?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 12_000 });
  // close price at index 4
  return data.map((k) => Number(k[4]));
}

/* ========= Trade Ops (LONG + SHORT) ========= */
async function openTrade({ positionType, price, emaFast, emaSlow }) {
  const base = {
    symbol: SYMBOL,
    status: "OPEN",
    qty: 1,
    positionType, // LONG | SHORT
    entryPrice: price,
    entryTime: new Date(),
    entryEMAfast: emaFast,
    entryEMAslow: emaSlow,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (DRY_RUN) {
    openPosition = { _id: "dryrun", ...base };
    console.log(
      `[${ts()}] 🟢 OPEN ${positionType} (DRY_RUN) @ ${price.toFixed(2)}`
    );
    return;
  }
  const { insertedId } = await positionsCol.insertOne(base);
  openPosition = { _id: insertedId, ...base };
  console.log(
    `[${ts()}] 🟢 OPEN ${positionType} @ ${price.toFixed(2)} (id=${insertedId})`
  );
}

async function closeTrade({ price, emaFast, emaSlow }) {
  if (!openPosition) return;

  const qty = openPosition.qty || 1;
  const isLong = openPosition.positionType === "LONG";
  // LONG PnL = (exit - entry) * qty
  // SHORT PnL = (entry - exit) * qty
  const pnl = (isLong ? price - openPosition.entryPrice : openPosition.entryPrice - price) * qty;

  if (DRY_RUN) {
    console.log(
      `[${ts()}] 🔴 CLOSE ${openPosition.positionType} (DRY_RUN) @ ${price.toFixed(
        2
      )} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
    );
    openPosition = null;
    return;
  }

  const res = await positionsCol.findOneAndUpdate(
    { _id: openPosition._id, status: "OPEN" },
    {
      $set: {
        status: "CLOSED",
        exitPrice: price,
        exitTime: new Date(),
        exitEMAfast: emaFast,
        exitEMAslow: emaSlow,
        profitLoss: pnl,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (res?.value) {
    console.log(
      `[${ts()}] 🔴 CLOSE ${res.value.positionType} @ ${price.toFixed(
        2
      )} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (id=${res.value._id})`
    );
  } else {
    console.warn(`[${ts()}] ⚠️ No OPEN position found to close.`);
  }
  openPosition = null;
}

/* ========= Strategy Tick ========= */
async function tick() {
  if (isTickRunning) return;
  isTickRunning = true;
  try {
    const closes = await fetchCloses(EMA_SLOW + 50);
    if (!closes || closes.length < EMA_SLOW) {
      console.warn(`[${ts()}] ⚠️ Not enough candles (${closes?.length || 0})`);
      return;
    }

    const emaFastArr = EMA.calculate({ period: EMA_FAST, values: closes });
    const emaSlowArr = EMA.calculate({ period: EMA_SLOW, values: closes });
    if (emaFastArr.length < 2 || emaSlowArr.length < 2) {
      console.warn(`[${ts()}] ⚠️ Not enough EMA points yet`);
      return;
    }

    const fastPrev = emaFastArr[emaFastArr.length - 2];
    const slowPrev = emaSlowArr[emaSlowArr.length - 2];
    const fast = emaFastArr[emaFastArr.length - 1];
    const slow = emaSlowArr[emaSlowArr.length - 1];
    const price = closes[closes.length - 1];

    const signal = detectCross(fastPrev, slowPrev, fast, slow);

    cached = {
      price,
      emaFast: fast,
      emaSlow: slow,
      signal,
      lastTickAt: new Date(),
    };

    // Flip logic LONG<->SHORT
    if (signal === "GOLDEN") {
      if (!openPosition) {
        await openTrade({ positionType: "LONG", price, emaFast: fast, emaSlow: slow });
      } else if (openPosition.positionType === "SHORT") {
        await closeTrade({ price, emaFast: fast, emaSlow: slow });
        await openTrade({ positionType: "LONG", price, emaFast: fast, emaSlow: slow });
      }
    } else if (signal === "DEATH") {
      if (!openPosition) {
        await openTrade({ positionType: "SHORT", price, emaFast: fast, emaSlow: slow });
      } else if (openPosition.positionType === "LONG") {
        await closeTrade({ price, emaFast: fast, emaSlow: slow });
        await openTrade({ positionType: "SHORT", price, emaFast: fast, emaSlow: slow });
      }
    }

    const posTxt = openPosition
      ? `${openPosition.positionType} OPEN @ ${openPosition.entryPrice}`
      : "NONE";
    console.log(
      `[${ts()}] Price=${price.toFixed(2)} EMA${EMA_FAST}=${fast.toFixed(
        2
      )} EMA${EMA_SLOW}=${slow.toFixed(2)} Signal=${signal} Position=${posTxt}`
    );
  } catch (err) {
    console.error(`[${ts()}] ❌ Tick error:`, err.message);
  } finally {
    isTickRunning = false;
  }
}

/* ========= Express APIs ========= */
const app = express();
app.use(cors());

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    emaFast: EMA_FAST,
    emaSlow: EMA_SLOW,
    dryRun: DRY_RUN,
    db: DRY_RUN ? "SKIPPED" : (db ? DB_NAME : "DISCONNECTED"),
    position: openPosition
      ? { type: openPosition.positionType, entryPrice: openPosition.entryPrice, entryTime: openPosition.entryTime }
      : null,
    lastTickAt: cached.lastTickAt,
  });
});

app.get("/api/price", async (req, res) => {
  const stale =
    !cached.lastTickAt ||
    Date.now() - new Date(cached.lastTickAt).getTime() > 70_000;
  if (stale) await tick();
  res.json({
    symbol: SYMBOL,
    interval: INTERVAL,
    emaFast: EMA_FAST,
    emaSlow: EMA_SLOW,
    price: cached.price,
    emaFastVal: cached.emaFast,
    emaSlowVal: cached.emaSlow,
    signal: cached.signal,
    positionOpen: Boolean(openPosition),
    positionType: openPosition?.positionType || null,
    lastTickAt: cached.lastTickAt,
  });
});

/** Order history (all positions, newest first) */
app.get("/api/orders/history", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const rows = await positionsCol
      .find({ symbol: SYMBOL })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Total PnL (sum over CLOSED positions) */
app.get("/api/pnl/total", async (req, res) => {
  try {
    if (DRY_RUN) return res.json({ totalPnL: 0, count: 0 });
    const agg = await positionsCol
      .aggregate([
        { $match: { symbol: SYMBOL, status: "CLOSED" } },
        { $group: { _id: null, total: { $sum: "$profitLoss" }, count: { $sum: 1 } } },
      ])
      .toArray();
    const total = agg.length ? agg[0].total : 0;
    const count = agg.length ? agg[0].count : 0;
    res.json({ totalPnL: Number(total.toFixed(4)), count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Currently open position (if any) */
app.get("/api/positions/open", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    const rows = await positionsCol
      .find({ symbol: SYMBOL, status: "OPEN" })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ========= Bootstrap & Scheduler ========= */
async function bootstrap() {
  if (!DRY_RUN) {
    await connectMongo();
    await restoreOpenPosition();
  } else {
    console.log(`[${ts()}] 🧪 DRY_RUN enabled (no DB writes)`);
  }

  app.listen(PORT, () =>
    console.log(`[${ts()}] ✅ API server on http://0.0.0.0:${PORT}`)
  );

  // align to next full minute, then every 60s
  const now = Date.now();
  const msToMinute = 60_000 - (now % 60_000);
  setTimeout(() => {
    tick().catch(() => {});
    setInterval(() => tick().catch(() => {}), 60_000);
  }, msToMinute);

  // Manual tick for testing
  app.get("/api/tick", async (req, res) => {
    await tick();
    res.json({ ok: true, lastTickAt: cached.lastTickAt });
  });
}

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  try {
    if (mongoClient) await mongoClient.close();
  } finally {
    process.exit(0);
  }
});

bootstrap();
