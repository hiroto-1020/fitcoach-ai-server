// index.mjs — adv engine v3（個別最適＋可変表現／任意の後段LLM整形）
// 必要: npm i express cors
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

/* ========== ユーティリティ ========== */
const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const todayISO = () => new Date().toISOString().slice(0, 10);

// 文字列→32bit seed
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function keyize(s){
  return String(s).toLowerCase()
    .replace(/[０-９]/g, d => String("０１２３４５６７８９".indexOf(d)))
    .replace(/[0-9+\-.,%kgmgh ]+/g, "")       // 数値や単位は無視
    .replace(/[^\p{L}\p{N}]+/gu, "")          // 記号を除去
    .slice(0, 32);
}
// シード乱数
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0xFFFFFFFF;
  };
}
const pick = (arr, r) => arr[Math.floor(r() * arr.length)];
function pickN(arr, n, r) {
  const a = [...arr];
  const out = [];
  for (let i = 0; i < n && a.length; i++) {
    const idx = Math.floor(r() * a.length);
    out.push(a[idx]);
    a.splice(idx, 1);
  }
  return out;
}

/* ========== 可変スタイル（口調の揺らぎ） ========== */
function renderWithStyle(lines, r) {
  const heads = ["今日のワンポイント👇", "サクッと要点👇", "コーチのひとこと👇", "無理なく整えるヒント👅", ""];
  const bullets = ["・", "—", "▶", "✓", "◎"];
  const head = pick(heads, r);
  const b = pick(bullets, r);

  const emoji = (ln) => {
    let s = ln;
    if (/(kcal|カロリー|摂取量)/i.test(s)) s += " 🔥";
    if (/タンパク|P\b/i.test(s)) s += " 🥩";
    if (/脂質|F\b/i.test(s)) s += " 🧈";
    if (/炭水化物|C\b|糖質/i.test(s)) s += " 🍚";
    if (/野菜|食物繊維|フルーツ|果物|発酵食品/i.test(s)) s += " 🥗";
    if (/水|水分|hydration|飲み物|塩分/i.test(s)) s += " 💧";
    return s;
  };

  const out = [];
  if (head) out.push(head);
  for (const ln of lines) {
    const line = /^[・—▶✓◎]/.test(ln) ? ln : `${b}${ln}`;
    out.push(emoji(line));
  }
  return out.join("\n");
}

/* ========== 可変テンプレ（重複回避しつつ毎日変わる） ========== */
function buildAdvice(payload) {
  const { totals = {}, goals = {}, meals = [], extraContext = {} } = payload || {};

  const t = { kcal: N(totals.kcal), p: N(totals.p), f: N(totals.f), c: N(totals.c) };
  const g = { kcal: N(goals.kcalTarget), p: N(goals.proteinTarget), f: N(goals.fatTarget), c: N(goals.carbsTarget) };

  const fiber  = N(extraContext?.nutritionExtras?.fiberTotal)  || meals.reduce((s,m)=>s+N(m.fiber),0);
  const sugar  = N(extraContext?.nutritionExtras?.sugarTotal)  || meals.reduce((s,m)=>s+N(m.sugar),0);
  const sodium = N(extraContext?.nutritionExtras?.sodiumTotal) || meals.reduce((s,m)=>s+N(m.sodium),0);

  const isTrainingDay = !!extraContext?.context?.isTrainingDay;
  const sleepAvg      = N(extraContext?.context?.sleepHoursAvg);
  const streakDays    = N(extraContext?.context?.streakDays);

  const latestWeight  = N(extraContext?.latestBody?.weight);
  const latestBodyFat = N(extraContext?.latestBody?.bodyFat);
  const weightGoal    = N(extraContext?.goals?.weightGoal);

  const gap = {
    kcal: g.kcal ? g.kcal - t.kcal : 0,
    p:    g.p    ? g.p    - t.p    : 0,
    f:    g.f    ? g.f    - t.f    : 0,
    c:    g.c    ? g.c    - t.c    : 0,
  };

  const FIBER_MIN=18, SUGAR_MAX=50, SODIUM_MAX=2400, PROTEIN_LO=0, PROTEIN_MID=20, KCAL_TOL=150;

  const pool = [];
  // kcal
  if (g.kcal) {
    if (gap.kcal > KCAL_TOL) pool.push(
      `まだ ${Math.round(gap.kcal)}kcal 余裕あり。夜は良質なP中心で軽く足そう`,
      `カロリーは不足ぎみ（＋${Math.round(gap.kcal)}kcal）。無理なく間食で調整を`,
      `今日は控えめ。あと${Math.round(gap.kcal)}kcalならP寄せでOK`
    );
    else if (gap.kcal < -KCAL_TOL) pool.push(
      `やや食べ過ぎ（−${Math.abs(Math.round(gap.kcal))}kcal）。次の食事は油と甘味を控えめに`,
      `カロリー超過。明日は脂質を5〜10g抑える作戦でリカバリー`,
      `今日は十分。寝る前の間食は控えて整えよう`
    );
    else pool.push(
      `kcalはちょうど良い帯に収束。Pの質だけ意識できれば満点`,
      `エネルギーバランス良好。明日は野菜/発酵食品をもう一皿`
    );
  }
  // P
  if (g.p) {
    if (gap.p > PROTEIN_MID) pool.push(
      `Pが足りない（あと${Math.round(gap.p)}g）。鶏むね/卵/ギリシャヨーグルトで補強`,
      `たんぱく不足。就寝前にプロテイン20g or 低脂肪乳`,
      `P追い足し推奨：ツナ缶/納豆/豆腐を一品追加`
    );
    else if (gap.p > PROTEIN_LO) pool.push(
      `Pはあと少し（${Math.round(gap.p)}g）。次の食事でメインをPに寄せよう`,
      `P微調整。サラダにサラダチキン/豆をトッピング`
    );
    else pool.push(
      `Pは合格。脂質が上振れしないよう部位/調理法を意識`,
      `十分なたんぱく摂取。吸収を助ける発酵食品も◎`
    );
  }
  // F
  if (g.f) {
    if (gap.f < -5) pool.push(`脂質がやや多め（${Math.abs(Math.round(gap.f))}g）。揚げ物とドレッシング量を見直し`,`F過多の気配。次回は焼く/茹でる調理で調整`);
    else if (gap.f > 5) pool.push(`脂質少なめ。オメガ3系（サバ/サーモン/亜麻仁）を少し足すと◎`,`Fが足りないならナッツ10〜15gで質を上げて満足度もUP`);
  }
  // C
  if (g.c) {
    if (gap.c > 20) pool.push(`C不足（＋${Math.round(gap.c)}g）。トレ前はおにぎり/バナナでパフォーマンス維持`,`炭水化物が控えめ。主食を拳1/2分だけ増やしてみよう`);
    else if (gap.c < -20) pool.push(`C過多（−${Math.abs(Math.round(gap.c))}g）。甘味・汁物の糖を軽く調整`,`主食がやや多い日。明日は野菜とPを優先でバランス取り`);
  }
  // 繊維・糖・塩
  if (fiber && fiber < FIBER_MIN) pool.push(`食物繊維が少なめ（${Math.round(fiber)}g）。海藻/きのこ/豆/皮つき野菜で＋5〜8gを狙おう`,`繊維UPのチャンス：味噌汁にわかめ＆豆腐、サラダに豆/ブロッコリー`);
  if (sugar && sugar > SUGAR_MAX) pool.push(`糖が多め（${Math.round(sugar)}g）。飲料の糖とデザート頻度を見直し`,`甘味コントロール：フルーツは食後の少量に寄せて血糖急上昇を抑制`);
  if (sodium && sodium > SODIUM_MAX) pool.push(`塩分が多い傾向（${Math.round(sodium)}mg）。汁物/加工肉/惣菜の頻度を控えめに`,`減塩テク：出汁の旨味を強めて醤油/塩を自然に減らす`);
  // トレ・睡眠・継続
  if (isTrainingDay) pool.push(`トレ日ならPは3回以上に分散。Cはトレ前後へ重点配分`,`ワークアウト後はP20〜30g＋ややCで回復を後押し`);
  if (sleepAvg) {
    if (sleepAvg < 6) pool.push(`睡眠短め（${sleepAvg}h）。夕食は消化の軽いP中心にして睡眠の質を上げよう`,`寝不足気味。カフェインは15時以降を控えめにして深部体温を整える`);
    else pool.push(`睡眠は十分（${sleepAvg}h）。朝はP＋水分で代謝スタートをスムーズに`,`休息が取れている日。摂取は目標の範囲でOK`);
  }
  if (streakDays) pool.push(`記録${streakDays}日継続中◎ 小さな一貫性が体を作る`,`継続は正義（${streakDays}日）。今日は「油の質」だけ意識してみよう`);
  if (weightGoal && latestWeight) {
    const diff = Math.round((latestWeight - weightGoal) * 10) / 10;
    if (diff > 0.5) pool.push(`目標体重まで −${diff}kg。まずは脂質を日あたり5〜10g抑えて様子見`,`体重は緩やかに。空腹時の間食はプロテイン/ゆで卵で質を担保`);
    else if (diff < -0.5) pool.push(`やせ過ぎ気味（${diff}kg）。kcalを＋150〜200でPは維持、Cを少し足す`,`体重が目標を下回り傾向。トレ後のCを確保して回復優先`);
    else pool.push(`体重は目標ライン付近。現状の型を続けつつ塩分/繊維で質を高めよう`,`狙い通りのペース。次はビタミン/ミネラル源（野菜/海藻）で微調整`);
  }
  if (latestBodyFat) pool.push(`体脂肪${latestBodyFat}%。Pは体重×1.6〜2.2g/日を目安に分散補給`,`体脂肪率に合わせて有酸素は短時間×高頻度のほうが継続しやすい`);

  // 重複回避（最近使ったキーを除外）
  const recentKeys = new Set((extraContext?.context?.recentTopics || []).map(String));
  const candidates = Array.from(new Set(pool));
  const filtered   = candidates.filter(l => !recentKeys.has(keyize(l)));
  const usable     = filtered.length >= 4 ? filtered : candidates;

  // シード：ユーザー×日×nonce で毎回変える
  const userId = String(extraContext?.user?.id || "anon");
  const nonce  = String(extraContext?.context?.nonce ?? Math.floor(Math.random()*1e9));
  const seed   = hash32(userId + ":" + todayISO() + ":" + nonce);
  const r      = rng(seed);

  const lines = pickN(usable, 4 + Math.floor(r()*3), r);
  const topicsUsed = lines.map(keyize);

  async function postEdit(text){ /* 既存のまま */ return null; }

  return { lines, r, postEdit, topicsUsed };
}


/* ========== エンドポイント ========== */
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post("/advice", async (req, res) => {
  try {
    const { lines, r, postEdit, topicsUsed } = buildAdvice(req.body || {});
    const styled = renderWithStyle(lines, r);
    const edited = await postEdit(styled);
    const text   = edited ? edited.trim() : styled.trim();
    res.json({ advice: text, topicsUsed });   // ← これを返す
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/warmup", (_req, res) => res.json({ ok: true, warmed: true }));

app.listen(PORT, () => {
  console.log(`AI advice server listening on :${PORT}`);
});
