# FF7 Remake 适配目录

共用程序位于../studio-common，网站8767；复用PostgreSQL服务，独立数据库studio_ff7_remake、角色ff7remake。真实配置只放本地.env。业务数据、音频、音色namespace、章节映射、备份和打包基线均不得与Rebirth混用。

本作没有原始中文配音，不把生成音频伪装为原中文。资源为legacy PAK与SAB；只读日英提取已验证，详见worker/AUDIO-EXTRACTION.md。adapter.py pack仍禁用，写回与Win11验证未完成。

日文已在独立条目存在、英文配对未确定的孤立EN条目可按用户指令设为skipped；不能谎称JP素材不存在，也不能跳过对应的独立JP条目。新生成仅按用户指定章节/批次执行，人工选择优先。

禁止提交.env、.private、数据库、游戏资源、音频、MOD、权重、缓存或日志。
