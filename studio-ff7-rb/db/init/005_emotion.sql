-- Studio-only. Who gets emotion scoring, and the JP/CN scores.
-- Edit cast_members later (pgAdmin): INSERT/DELETE/UPDATE role. Not packed.

CREATE TABLE IF NOT EXISTS cast_members (
    speaker     TEXT PRIMARY KEY REFERENCES speakers(code) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('主角', '配角')),
    note        TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cast_members_role_idx ON cast_members (role);

INSERT INTO speakers (code, name_zh, source, updated_at)
SELECT x.code, x.name_zh, 'cast', now()
FROM (VALUES
    ('cld', '克劳德'), ('tif', '蒂法'), ('art', '爱丽丝'), ('blt', '巴雷特'),
    ('red', '赤红XIII（深嗓）'), ('nnk', '纳纳基（真声）'), ('yfi', '尤菲'), ('cat', '凯特西'), ('cid', '希德'),
    ('vin', '文森特'), ('sep', '萨菲罗斯'), ('zax', '扎克斯'),
    ('chd', '查德利'), ('jny', '乔尼'), ('bgh', '布根哈根'), ('csn', '西斯妮'),
    ('ruf', '路法斯'), ('tsu', '曾'), ('ren', '雷诺'), ('lud', '路德'),
    ('eln', '伊莉娜'), ('hjo', '宝条'), ('hyd', '海德格'), ('scr', '史卡蕾特'),
    ('plm', '帕尔默'), ('gil', '吉尔伽美什'), ('rch', '罗榭'),
    ('ttv', '季托夫'), ('grb', '格林葛林'), ('fcs', '佛卡斯'), ('kre', '琪里耶'),
    ('beg', '贝格'), ('big', '毕格斯'), ('jec', '杰西'), ('wed', '威吉'),
    ('mrn', '玛琳'), ('clm', '克劳蒂亚'), ('brn', '蒂法的父亲'),
    ('zam', '扎克斯的母亲'), ('zaf', '扎克斯的父亲'),
    ('dio', '迪欧'), ('ges', '孤狼盖斯'), ('ldn', '罗德娜'), ('prs', '普莉希拉'),
    ('che', '陆行鸟仙人'), ('dyn', '戴因'), ('leg', '蕾吉')
) AS x(code, name_zh)
ON CONFLICT (code) DO NOTHING;

INSERT INTO cast_members (speaker, role, note) VALUES
    ('cld', '主角', '克劳德'),
    ('tif', '主角', '蒂法'),
    ('art', '主角', '爱丽丝'),
    ('blt', '主角', '巴雷特'),
    ('red', '主角', '赤红伪装成熟嗓'),
    ('nnk', '主角', '赤红真声／星殒之后的纳纳基'),
    ('yfi', '主角', '尤菲'),
    ('cat', '主角', '凯特西'),
    ('cid', '主角', '希德'),
    ('vin', '主角', '文森特'),
    ('sep', '主角', '萨菲罗斯'),
    ('zax', '主角', '扎克斯'),
    ('chd', '配角', '查德利'),
    ('jny', '配角', '乔尼'),
    ('bgh', '配角', '布根哈根'),
    ('csn', '配角', '西斯妮'),
    ('ruf', '配角', '路法斯'),
    ('tsu', '配角', '曾'),
    ('ren', '配角', '雷诺'),
    ('lud', '配角', '路德'),
    ('eln', '配角', '伊莉娜'),
    ('hjo', '配角', '宝条'),
    ('hyd', '配角', '海德格'),
    ('scr', '配角', '史卡蕾特'),
    ('plm', '配角', '帕尔默'),
    ('gil', '配角', '吉尔伽美什'),
    ('rch', '配角', '罗榭'),
    ('ttv', '配角', '季托夫'),
    ('grb', '配角', '格林葛林'),
    ('fcs', '配角', '佛卡斯'),
    ('kre', '配角', '琪里耶'),
    ('beg', '配角', '贝格'),
    ('big', '配角', '毕格斯'),
    ('jec', '配角', '杰西'),
    ('wed', '配角', '威吉'),
    ('mrn', '配角', '玛琳'),
    ('clm', '配角', '克劳蒂亚'),
    ('brn', '配角', '蒂法的父亲'),
    ('zam', '配角', '扎克斯的母亲'),
    ('zaf', '配角', '扎克斯的父亲'),
    ('dio', '配角', '迪欧'),
    ('ges', '配角', '孤狼盖斯'),
    ('ldn', '配角', '罗德娜'),
    ('prs', '配角', '普莉希拉'),
    ('che', '配角', '陆行鸟仙人'),
    ('dyn', '配角', '戴因'),
    ('leg', '配角', '蕾吉')
ON CONFLICT (speaker) DO NOTHING;

ALTER TABLE line_meta
    ADD COLUMN IF NOT EXISTS jp_emo     TEXT,
    ADD COLUMN IF NOT EXISTS jp_emo_p   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS cn_emo     TEXT,
    ADD COLUMN IF NOT EXISTS cn_emo_p   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS jp_emo_vec JSONB,
    ADD COLUMN IF NOT EXISTS cn_emo_vec JSONB,
    ADD COLUMN IF NOT EXISTS emo_cos    DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS line_meta_jp_emo_idx ON line_meta (jp_emo);
CREATE INDEX IF NOT EXISTS line_meta_cn_emo_idx ON line_meta (cn_emo);
