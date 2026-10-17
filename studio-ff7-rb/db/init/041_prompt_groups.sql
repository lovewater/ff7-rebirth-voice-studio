-- 一个用途组通常包含system+user；改稿还会有追加反馈。同一key可被多个组共用。
-- 关联按prompt_key而非版本id，同key的新版本自动保留分组，不参与启用版本选择。
CREATE TABLE IF NOT EXISTS prompt_groups (
 key text PRIMARY KEY,
 name text NOT NULL,
 "desc" text NOT NULL DEFAULT '',
 category text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS prompt_group_members (
 group_key text NOT NULL REFERENCES prompt_groups(key) ON DELETE CASCADE,
 prompt_key text NOT NULL,
 position integer NOT NULL DEFAULT 0,
 PRIMARY KEY (group_key,prompt_key)
);
CREATE INDEX IF NOT EXISTS prompt_group_members_prompt_idx ON prompt_group_members(prompt_key);
COMMENT ON COLUMN prompt_group_members.prompt_key IS '对应prompt_templates.key全部历史版本；key非唯一版本列，不绑定某个id';
INSERT INTO prompt_groups(key,name,"desc",category) VALUES
 ('rewrite.duration','实测偏短后改稿','校字通过但发声明显偏短后，以实际时长引导改稿；拍数比仅参考。','台词改写'),
 ('rewrite.normal','普通台词改稿','普通场景五稿改写。自动和手动共用基础指令、上下文及上一稿反馈。','台词改写'),
 ('rewrite.short','日文短句改稿','日文正文不足6字时的独立改稿提示。','台词改写'),
 ('rewrite.slow','日文慢表达改稿','日文净语速低于每秒3拍时的独立改稿提示。','台词改写'),
 ('rewrite.manual','手动改稿择优','详情页手动改稿及候选选择；与普通自动改稿共用基础模板。','台词改写'),
 ('fallback-rewrite','整句降级改稿','切分或分类不可靠等情况的独立降级线路，第2、3轮按实测长度改稿。','台词改写'),
 ('text-review','中文TTS校字','对照实际朗读稿与ASR，检查漏字、额外字和读音疑点。','语音检查'),
 ('rhythm-pick','音频节奏择优','合格候选中根据日中ASR字轴选择最合适的断句节奏。','语音检查'),
 ('onomatopoeia-plan','正文与拟声分类','识别日文正文及需保留原声的拟声，程序负责波形切口。','拟声与分流'),
 ('missing-fragment','唯一缺口补救','判断唯一未覆盖声音与唯一缺失字幕能否对应。','拟声与分流'),
 ('missing-jp-subtitle','无日文字幕分流','判断保留全拟声原声，还是转整句降级TTS。','拟声与分流'),
 ('subtitle-quotes','最终字幕补引号','音频选定后，仅补回日文引用对应的中文引号。','字幕整理'),
 ('subtitle-layout','长字幕语义断行','无可用标点的长单行字幕按语义分成两行。','字幕整理')
ON CONFLICT(key) DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position)
SELECT g.key,p.key,CASE WHEN p.role='system' THEN 0 WHEN p.key LIKE '%.context' OR p.key LIKE '%.input' THEN 10 ELSE 20 END
FROM prompt_groups g JOIN (SELECT DISTINCT key,role FROM prompt_templates) p ON p.key LIKE g.key||'.%'
ON CONFLICT DO NOTHING;
INSERT INTO prompt_group_members(group_key,prompt_key,position) VALUES
 ('rewrite.duration','rewrite.audio-feedback',30),
 ('rewrite.normal','rewrite.audio-feedback',30),
 ('rewrite.short','rewrite.audio-feedback',30),
 ('rewrite.slow','rewrite.audio-feedback',30),
 ('rewrite.manual','rewrite.normal.system',0),
 ('rewrite.manual','rewrite.normal.context',10),
 ('rewrite.manual','rewrite.normal.feedback',20),
 ('rewrite.manual','rewrite.manual-selection',30)
ON CONFLICT DO NOTHING;
