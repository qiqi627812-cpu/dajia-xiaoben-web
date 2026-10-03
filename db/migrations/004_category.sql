-- 004_category.sql — 账目分类（稳定 categoryId，不以显示名为关联键）
-- 旧记录无类别 → DEFAULT 'other' 兼容归入「其他」，不丢数据
ALTER TABLE entries ADD COLUMN IF NOT EXISTS category_id text NOT NULL DEFAULT 'other';

-- 未来还款类账目（type='repayment'）不计入消费统计；当前全部为 expense
ALTER TABLE entries ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'expense';
