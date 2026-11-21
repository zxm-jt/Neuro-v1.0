# 表情触发词总表

> 本文件由 `node tools/gen_expression_doc.js` 从 `js/expression-map.js`（表情目录）自动生成，**不要手改**。
> 改表情请改目录，然后重新生成。

## 一、标签 = 控制指令，不是台词

方括号标签只驱动 Live2D 的脸和身体：
- **不会被念出来**（TTS 文本在 `js/tts-processor.js` 的 `stripEmotionTags()` 里被剥掉）
- **不会出现在字幕里**（字幕与 TTS 同源，用的是剥完标签的正文）
- 情绪本身通过 SSE 的独立事件 `{"type":"emotion"}` 下发，与正文分开

## 二、表情目录（26 个）

| 标签 | 预期表情 | 典型用法 | 动作组 | 保持(ms) |
|---|---|---|---|---|
| `[neutral]` | 中性放松 | 回到默认状态；没有情绪可说的时候 | Gentle | 2600 |
| `[happy]` | 开心的笑容 | 快乐和积极反应 | Cheer | 3200 |
| `[blush]` | 脸颊泛红 | 受到夸奖、被戳穿、有点不好意思 | Gentle | 3200 |
| `[look_down]` | 视线向下 | 害羞、尴尬、被说中不想让你看 | Gentle | 3000 |
| `[starry_eyes]` | 闪闪发光的星星眼 | 兴奋、着迷、被你展示的东西击中 | Cheer | 3200 |
| `[gentle_smile]` | 温柔、令人安心的微笑 | 安慰用户、缓和气氛、说软话 | Gentle | 3600 |
| `[thoughtful]` | 若有所思的表情 | 哲学和学术讨论、在琢磨你的话 | Think | 3400 |
| `[curious]` | 感兴趣、好奇的表情 | 提问、探索想法、想多知道一点 | Think | 3000 |
| `[concerned]` | 担忧的表情 | 回应痛苦、听到坏消息、担心你 | Think | 3400 |
| `[joy]` | 开心的笑容（更强烈） | 特别高兴、欢呼 | Cheer | 3200 |
| `[excited]` | 兴奋 | 激动、迫不及待 | Cheer | 3000 |
| `[smile]` | 微笑 | 普通的高兴/友好 | Cheer | 3000 |
| `[love]` | 喜欢、亲昵 | 表达喜欢、心软 | Gentle | 3600 |
| `[shy]` | 害羞（脸红 + 低头） | 害羞、不好意思、被夸奖又躲不开 | Gentle | 3200 |
| `[sad]` | 难过 | 失落、想他、道歉 | Sad | 4200 |
| `[cry]` | 哭 | 委屈、忍不住 | Sad | 4400 |
| `[confused]` | 困惑 | 没听懂、懵了 | Think | 3000 |
| `[thinking]` | 若有所思 | 思考、在权衡 | Think | 3400 |
| `[worried]` | 担忧 | 担心、紧张、不安 | Think | 3200 |
| `[shock]` | 震惊 | 惊到、说不出话 | Think | 2600 |
| `[surprised]` | 惊讶 | 意外、没想到 | Cheer | 2600 |
| `[angry]` | 生气 | 发火、不满 | Angry | 3000 |
| `[mad]` | 暴怒 | 真怒、气炸了 | Angry | 3000 |
| `[annoyed]` | 不耐烦 | 烦、嫌弃 | Angry | 2800 |
| `[jealous]` | 吃醋 | 酸了、有点在意别人 | Angry | 2800 |
| `[smug]` | 得意 | 傲娇、卖关子、"我早说了" | Gentle | 3000 |

## 三、各表情用了哪些模型参数

模型没有表情文件(Expressions)，全部靠写参数画出来。参数含义：

| 字段 | 模型参数 | 含义 |
|---|---|---|
| `bL` | ParamBrowLY / ParamBrowRY | 眉毛高低（正=上抬） |
| `bA` | ParamBrowLAngle / ParamBrowRAngle | 眉毛角度（正=内端下压/严肃，负=柔和） |
| `bF` | ParamBrowLForm / ParamBrowRForm | 眉形（负=尖锐/皱，正=平缓） |
| `eye` | ParamEyeLSmile / ParamEyeRSmile | 笑眼 |
| `eOpen` | ParamEyeLOpen / ParamEyeROpen | 睁眼程度（0=闭眼） |
| `ballX` | ParamEyeBallX | 视线左右 |
| `ballY` | ParamEyeBallY | 视线上下（EYE_BALL_Y_DOWN 负=向下） |
| `mouth` | ParamMouthForm | 嘴型（正=上翘微笑，负=下撇） |
| `cheek` | ParamCheek | 脸红 |
| `angleY` | ParamAngleY | 头俯仰（正=抬头） |
| `angleZ` | ParamAngleZ | 头歪斜 |
| `shoulder` | ParamShoulder | 耸肩 |
| `bodyX` | ParamBodyAngleX | 身体转 |

## 四、同义触发词（别名表）

后端 `_EMO_ALIAS` 与前端 `js/emotion-keys.js` 的 ALIAS 必须一致。
下面是前端别名表按目标键归类的结果（后端同款）：

- **[angry]** ← anger、angrily、furious、fury、rage、irate、livid、cross、生气、愤怒、气死、气
- **[annoyed]** ← annoyance、annoying、irritated、irritating、grumpy、vexed、烦、烦人、受不了
- **[blush]** ← blush、blushing、blushingly、flushed、red、rosy、脸红、泛红、羞红
- **[concerned]** ← concerned、concern、caring、sympathetic、empathetic、worried_about_you、担忧、关切、心疼
- **[confused]** ← confuse、confusing、puzzled、puzzling、bewildered、lost、困惑、不懂、迷茫
- **[cry]** ← crying、tears、teary、sobbing、weep、哭、委屈、想哭
- **[curious]** ← curious、curiosity、inquisitive、intrigued、wondering、curiosity_pique、好奇、感兴趣、探究
- **[excited]** ← excitement、thrilling、hyped、stoked、pumped、eager、zest、兴奋、激动、冲
- **[gentle_smile]** ← gentle_smile、gentlesmile、gentle、soft_smile、warm_smile、soothing、reassuring、tender、温柔、微笑、安心
- **[happy]** ← cheerful、gladly、happiness、glad、delight、delighted、pleasing、pleased、开心、高兴、快乐、喜
- **[jealous]** ← jealousy、envy、envious、嫉妒、酸
- **[joy]** ← glee、gleeful、joyful、enjoy、enjoying
- **[look_down]** ← look_down、lookdown、look_down_eyes、downcast、averting、avoiding_eye_contact、低头、垂眸、移开视线
- **[love]** ← lovely、adore、adoring、loving、affection、fond、crush、喜欢、爱、可爱
- **[mad]** ← madly、madness
- **[neutral]** ← normal、calm、relaxed、default
- **[sad]** ← sadness、unhappy、down、gloomy、melancholy、blue、heartbroken、难过、伤心、不开心、低落
- **[shock]** ← shocking、shocked
- **[shy]** ← shyness、embarrassed、embarrassing、bashful、害羞、尴尬
- **[smile]** ← smiley、smiling、grin、grinning
- **[smug]** ← smugness、proud、conceited、arrogant、cheeky、smirking、得意、傲娇
- **[starry_eyes]** ← starry_eyes、starryeyes、starry、sparkling、sparkly、shiny_eyes、star_eyes、infatuated、mesmerized、星星眼、星星、闪闪发光
- **[surprised]** ← astonish、astonished、surprise、surprising、amazed、amazing、astounded、startle、startled、震惊、惊讶、居然
- **[thinking]** ← think、pondering、思考、想、琢磨
- **[thoughtful]** ← thoughtful、pensive、reflective、musing、contemplative、philosophical、reflect、若有所思、沉思
- **[worried]** ← worry、worrying、anxious、anxiety、nervous、scared、afraid、fear、fearful、uneasy、担心、害怕、紧张、怕

## 五、为什么以前"表情做不出来"

两个根因，都已修：

1. **参数写在渲染管线之外** → 被 motion 曲线覆盖。
   实测：模型 10 个 motion 每一个都动画了全部表情参数（眉毛/脸红/笑眼/嘴型/眼球/头角度）。
   pixi-live2d-display 的顺序是 motion 曲线 → saveParameters → 眼动/物理 → model.update（绘制）。
   在渲染外写参数，下一帧就被覆盖 → 表情从来没活到被画出来的那一刻。
   修法：`js/model-interaction.js` 的 `_installExpressionHook()` 挂在 `afterMotionUpdate` 上，每帧重写。
2. **情绪动作用 NORMAL(2) 优先级** → 库里的 `reserve()` 规定 NORMAL 打断不了 NORMAL，
   于是第一个情绪动作之后的所有动作一律被拒（模型 motion 是循环的，永远不停）。
   修法：改用 FORCE(3)。
