// index.mjs — FitCoach Advice Server (variety-focused)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ========== utils ==========
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);

// 安定した“日ごとのバリエーション”のため簡易シード乱数
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i); h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function pickN(rng, arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
function oneOf(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ざっくり食品換算（P/F/Cの補充・抑制の提案に利用）
const foodIdeas = {
  protein: [
    { label: "鶏むね100g", p: 22, kcal: 110 },
    { label: "ギリシャヨーグルト150g", p: 15, kcal: 120 },
    { label: "納豆1パック", p: 8, kcal: 100 },
    { label: "ツナ水煮1缶", p: 12, kcal: 70 },
    { label: "卵2個", p: 12, kcal: 150 },
  ],
  fatDownTips: [
    "揚げ→グリル/蒸しにチェンジ",
    "ドレッシングは『かける→和える』で量を1/2",
    "乳製品は“低脂肪/無脂肪”に置換",
  ],
  slowCarb: [
    "オートミール/玄米/全粒粉パンを小盛りで",
    "さつまいも100gを主食にスイッチ",
    "うどん→蕎麦に置換",
  ],
  fiberPicks: [
    "カットサラダ＋海藻を一握り",
    "冷凍ブロッコリーをレンチン",
    "りんご/バナナなど果物を1つ",
  ],
  konbini: [
    "セブン：ほぐしサラダチキン＋カットサラダ",
    "ファミマ：サラダフィッシュ＋味噌汁",
    "ローソン：ブランパン＋ゆで卵＋野菜ジュース(無加糖)",
  ],
  eatingOut: [
    "牛丼は“並＋サラダ＋味噌汁”で汁は控えめ",
    "定食は“ご飯少なめ＋刺身/焼き魚/生姜焼き”へ",
    "ラーメンは“半麺＋味玉＋海苔増し”で満足度キープ",
  ],
};

// ========== advice generators ==========
function buildModules(ctx, rng) {
  const { totals, goals } = ctx;
  const pGap = Math.round((goals.proteinTarget ?? 0) - (totals.p ?? 0));   // +なら不足
  const fOver = Math.round((totals.f ?? 0) - (goals.fatTarget ?? 0));      // +なら摂り過ぎ
  const kcalDelta = Math.round((totals.kcal ?? 0) - (goals.kcalTarget ?? 0)); // +ならオーバー
  const cShare = pct(totals.c ?? 0, (totals.p ?? 0) + (totals.f ?? 0) + (totals.c ?? 0));

  const modulo = {
    proteinUp: () => {
    if (pGap <= 6) return null;
      const picks = pickN(rng, foodIdeas.protein, 2).map(x => `${x.label}（P${x.p}g）`);
      return `タンパク質が少し足りないかも。あと${pGap}gほど、${picks.join(" / ")}のどれかをプラスしてみよう。`;
    },
    fatDown: () => {
      if (fOver <= 5) return null;
      const tip = oneOf(rng, foodIdeas.fatDownTips);
      return `脂質は今日ちょい多め（+${fOver}g想定）。${tip} で明日はバランス良く。`;
    },
    kcalTrim: () => {
      if (kcalDelta <= 80) return null;
      const ways = pickN(rng, ["間食の量を1/2", "主食を小盛りに", "夜の油ものを避ける"], 2).join(" / ");
      return `今日はカロリーが少し高め（+${kcalDelta}kcal）。${ways} のどれかで微調整しよう。`;
    },
    slowCarbTiming: () => {
      if (cShare >= 35 && cShare <= 55) return null; // おおむねOKなら出さない
      const pick = oneOf(rng, foodIdeas.slowCarb);
      return `炭水化物は“ゆっくり吸収”を意識。${pick} をトレ前後に寄せると安定するよ。`;
    },
    addFiber: () => {
      const pick = oneOf(rng, foodIdeas.fiberPicks);
      return `食物繊維が少なめかも。${pick} を1品足して満腹感と腸内環境をアップ。`;
    },
    hydration: () => {
      const target = clamp(Math.round(((totals.kcal ?? 1800) / 1000) * 1.2 * 10) / 10, 1.2, 3.0);
      return `水分はこまめに。目安は${target}L/日。食前コップ1杯で食べ過ぎも防げる。`;
    },
    sodium: () => {
      return `外食や加工品が多い日は“汁を残す・ソースは別添え”で塩分オフを意識しよう。`;
    },
    konbiniPack: () => {
      const pick = oneOf(rng, foodIdeas.konbini);
      return `コンビニなら：${pick} が手軽でP確保しやすいよ。`;
    },
    eatingOut: () => {
      const pick = oneOf(rng, foodIdeas.eatingOut);
      return `外食Tips：${pick}。満足感キープでPは落とさない。`;
    },
    dessertHandle: () => {
      return `甘い物欲は“食後”に小さめ1品へ。単体間食→血糖スパイクを避けやすい。`;
    },
    cookingSwap: () => {
      return `調理を“揚げ/バター→蒸し/焼き/レンチン”に変えるだけでFを自然に削れるよ。`;
    },
  };

  // その日の“雰囲気”を変えるスタイル（文体の彩り）
  const tones = [
    { prefix: "メンテ視点", flare: "🔧" },
    { prefix: "攻めの一手", flare: "⚡" },
    { prefix: "やさしめ",   flare: "🤝" },
    { prefix: "科学オタク", flare: "🧪" },
    { prefix: "シンプル志向", flare: "🎯" },
  ];
  const tone = oneOf(rng, tones);

  // 候補生成＆nullを除外
  const pool = Object.values(modulo).map(fn => fn()).filter(Boolean);

  // バリエーション量は少なめでOK：3〜5本だけ返す
  const count = 3 + Math.floor(rng() * 3); // 3〜5
  const picks = pickN(rng, pool.length ? pool : [
    "今日は全体バランス良さげ。明日はタンパク質だけ“先に食べる”を意識してみよう。",
    "体調が落ち気味なら睡眠優先で。Pは体重×1.6gくらいを目安に確保。",
    "炭酸水/お茶で“口寂しさ”対策。間食の量はいつもの半分でOK。",
  ], count);

  // 記号・見出しもバラす
  const bullets = ["・", "—", "▶", "✓", "◎"];
  const b = oneOf(rng, bullets);
  const introChoices = [
    `${tone.flare} ${tone.prefix}のミニアドバイス`,
    `${tone.flare} 今日のワンポイント`,
    `${tone.flare} さくっと要点`,
    "", // ときどき前口上ナシ
  ];
  const intro = oneOf(rng, introChoices);

  const lines = picks.map(x => `${b}${x}`);
  return (intro ? intro + "\n" : "") + lines.join("\n");
}

// ========== endpoints ==========
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});
app.post("/warmup", (req, res) => {
  // 将来的にモデルロード等を入れる想定。今はNO-OP
  return res.json({ ok: true });
});

app.post("/advice", (req, res) => {
  try {
    const { totals = {}, goals = {}, meals = [], template, variant, seed } = req.body || {};
    const dateSeed = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const seedStr = String(seed ?? variant ?? `${dateSeed}|${totals.kcal}|${totals.p}|${totals.f}|${totals.c}`);
    const rng = mulberry32(hashStr(seedStr));
    const ctx = { totals, goals, meals, template };

    const text = buildModules(ctx, rng);
    // クライアントは“生テキスト”前提
    return res.json({ advice: text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "advice-failed" });
  }
});

// ========== start ==========
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[fitcoach-ai-server] listening on ${PORT}`);
});
