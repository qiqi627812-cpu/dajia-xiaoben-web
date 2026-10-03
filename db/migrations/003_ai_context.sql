-- 003: AI 上下文所需字段
-- members.aliases：成员别名（昵称匹配忽略空格/大小写之外的第二匹配源）
-- profile.default_currency：账本默认币种（AI 未说明币种时的回退值）

ALTER TABLE members ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE profile ADD COLUMN IF NOT EXISTS default_currency TEXT NOT NULL DEFAULT 'CNY';
