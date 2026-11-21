# flybridge —— 果蝇连接组 ↔ Neuro 的桥（自包含）

> 已并入 Neuro 仓库，自包含运行：
> 依赖（numba / flybrain 包）装进 Neuro 的 Python，数据搬进 `flybridge\data\`。
> 只跑 **FlyBrain（166,700 神经元 LIF）**，不跑 FlySim 的身体/飞行/代谢。
> 实测：加载 1.4 s，**7.9 ms/帧**；默认 **30 Hz（0.6× 生物实时）** ≈ 24% 单核。

## 自包含清单

| 东西 | 位置 |
|---|---|
| 代码 | `flybridge/`（相对仓库根） |
| 连接组数据（约 247 MB） | 首次运行由 `flybrain` 包自动下载（不进仓库） |
| Python 依赖 | Neuro 自己的解释器：`numba 0.68.1` + `llvmlite 0.50` + 复制进去的 `flybrain` 包 |
| 运行时状态 | `flybridge\state\`（膜电位/记忆/情绪簇/轨迹，已 gitignore） |

## 启动

```powershell
# 推荐
flybridge/run_bridge.bat

# 手动（Neuro 的解释器）
cd <repo root>
python -m flybridge.brain_server --port 6007 --hz 30
```

自检（约 25 s，自动起停，不需要界面）：

```powershell
cd <repo root>
python -m flybridge.selftest
# 期望最后一行：ALL PASS
```

## 协议 v1（127.0.0.1:6007，短轮询）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | `{ok, frame, fps, ms}` |
| GET | `/out` | 当帧状态（见下） |
| GET | `/state` | `/out` + `intero_tail` + `head_updates` |
| POST | `/in` | `{"senses":{"vision":[...],"audio":0~1,"touch":[["click",0.9]],"smell":[[idx,val]]},"intero":{"outcome":"praise|interrupt|none"}}` |
| POST | `/reward` | `{"r":-1..1,"why":"praise|interrupt","expr":"shy"}` → 微调读出头 **并教会当前情绪簇一个词** |

`/out` 关键字段：
```json
{ "actions": {"speak","look","withdraw"}, "speaking": false,
  "emotion": {"cluster":2,"n_clusters":3,"label":null,"labels_learned":1,"confidence":0.8,
              "axes":{"valence":..,"arousal":..,"tension":..,"satiety":..}},
  "recall": {"strength":0.42,"affect":[...],"action":[...]},
  "features": {"drive":0.26,"kc":0.53,"vis":0.006,"mbon":0.01,...},
  "health": {"hz":30.0,"brain_time_ratio":0.6} }
```

- `speak > 0.62` 进入"想说"、`< 0.42` 退出（滞回在**脑循环里**判定；客户端只在 `speaking=true` 时组织台词）。
- `emotion.label` 为 `null` 时表示"这个词还没学会"——用连续 4 轴驱动表情，别硬贴标签。

## 文件

| 文件 | 作用 |
|---|---|
| `brain_server.py` | 30 Hz 主循环 + HTTP；每步 try/except，坏输入不会杀死脑 |
| `assoc.py` | 蘑菇体联想记忆（KC 稀疏码→情绪/动作；显著性×PAM/PPL 门控；半衰期遗忘） |
| `clusters.py` | 情绪的**生长式聚类**（在线 k-means，簇数随经历增长）+ 词的学习 |
| `heads.py` | 读出头（权重是 JSON 数据）+ 三因子在线更新 |
| `persist.py` | 脑状态 bit-exact 存档 + 自动存盘 + **离线时间解析推进** |
| `spare_pool.py` | 统计空闲神经元并生成 `ports/spare_pool.json`（空闲 36.1%） |

## 已知边界

1. 不是意识：它给的是非符号化内在状态（唤醒/效价/张力/饱腹），不是语言或自我。
2. `FlyBrain.stimulate()` 是"按批次（每只果蝇一个值）"设计；**逐神经元注入必须直接写 `v[idx]`**（见 `_apply`），否则会撞广播错误。
3. 强杀进程丢最多 12 s（自动存盘间隔）；Ctrl+C 会即时存盘。
4. KC 的**原始放电比例**恒≈1.0（LIF 参数下几乎全放电），所以特征用的是"高于自身运行均值的 surprise"（`kc`），不是放电比例。
5. 情绪簇数量取决于经历多样性：短测 2–3 个，长时间交互才会继续增长。
