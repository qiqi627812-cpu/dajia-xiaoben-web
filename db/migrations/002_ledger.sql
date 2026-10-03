-- 002: 账本身份与账目表
-- 金额一律整数最小货币单位（CNY/HKD/USD ×100；JPY ×1）
-- 成员改名/停用不影响历史：entries 保存 payer_name 与 splits[].name 快照

CREATE TABLE IF NOT EXISTS profile (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  nickname     TEXT NOT NULL,
  avatar       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  avatar     TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_self    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id            BIGSERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,            -- YYYY-MM-DD
  currency      TEXT NOT NULL,            -- CNY | HKD | USD | JPY
  total_minor   BIGINT NOT NULL CHECK (total_minor > 0),
  payer_id      BIGINT,
  payer_name    TEXT NOT NULL,            -- 付款人快照
  splits        JSONB NOT NULL,           -- [{"id":..,"name":..,"minor":..}]
  items         JSONB,                    -- [{"name":..,"minor":..}] 可选
  note          TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',   -- manual | ai
  ai_confidence REAL,
  ai_warnings   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries (date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_members_active ON members (active) WHERE active;
