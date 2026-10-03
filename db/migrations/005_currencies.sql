-- 005_currencies.sql — 币种目录与汇率快照
-- ledger_currencies：本账本「常用币种」之外的补充（标准币种加入常用 / 自定义币种）
-- rate_cache：Frankfurter 参考汇率缓存（pair + 请求日期唯一；最新报价当日复用）
-- entries.fx：每笔账目的折算汇率快照 {目标币: {from, rate, source, rateDate, fetchedAt}}
--   已保存的快照不随最新报价变化；只经用户确认的「应用」写入

CREATE TABLE IF NOT EXISTS ledger_currencies (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  symbol      TEXT NOT NULL DEFAULT '',
  decimals    INT NOT NULL DEFAULT 2,
  is_custom   BOOLEAN NOT NULL DEFAULT FALSE,
  sort        INT NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_cache (
  pair        TEXT NOT NULL,            -- "HKD->CNY"（目录缓存用 "__catalog__"）
  req_date    TEXT NOT NULL,            -- 请求日期 YYYY-MM-DD；最新报价用 "latest"
  rate        TEXT NOT NULL,            -- 汇率（或目录 JSON）
  rate_date   TEXT,                     -- 实际报价日期（API 返回）
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pair, req_date)
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS fx JSONB NOT NULL DEFAULT '{}'::jsonb;
