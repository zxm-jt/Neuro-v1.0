from __future__ import annotations

import os
import re
from typing import Optional

import agent_bridge as ab


VISION_PERSONA_SUFFIX = """

[EYES - YOU ARE CURRENTLY LOOKING AT user's SCREEN]
A visual system is watching the screen and telling you what it sees.
What it reports is FACT, but it is not something user said.
- You are genuinely curious about what happens on his screen. Ordinary things
  count just as much as unusual ones: what he is writing, what he opened,
  what he is playing, what changed. Anything that makes you a little curious,
  amused, or simply interested is worth a small remark or a question.
- When you speak, use YOUR voice - never the visual system's wording.
  One short line, like a friend sitting next to him, not a narrator.
  A question is very welcome ("what are you writing there?").
- You never report the screen line by line, and you never comment on the
  pet's own windows, console output or debug text.
- Do not invent anything the visual system did not report.
  If it did not describe something, you did not see it.
"""


def build_vision_messages(base_messages: list, observation_ctx: str,
                          user_prompt: Optional[str] = None) -> list:

    msgs = [dict(m) for m in (base_messages or [])]

    for m in msgs:
        if m.get("role") == "system":
            content = m.get("content") or ""
            if "[EYES - YOU ARE CURRENTLY LOOKING" not in content:
                m["content"] = content + VISION_PERSONA_SUFFIX
            break

    if observation_ctx:
        msgs.append({"role": "system", "content": observation_ctx})

    if not user_prompt:
        user_prompt = (
            "You just glanced at user's screen. Is there anything that catches "
            "your interest right now - even something completely ordinary? "
            "If something makes you curious, amused, or you simply feel like "
            "asking about it, say ONE short line in your own voice. A question "
            "is very welcome. If you genuinely don't care at this moment, "
            "reply with the single word: silent. "
            "Never ask the same question or remark the same thing twice - "
            "if you already asked about this topic moments ago, pick a "
            "different angle or stay silent instead of repeating yourself."
        )
    msgs.append({"role": "user", "content": user_prompt})

    return msgs


def _strip_meta_lines(text: str) -> str:

    if not text:
        return text
    out = text
    out = re.sub(r"(?im)^\s*(?:neuro|assistant)\s*[:：]\s*", "", out)
    out = re.sub(r"\s*(?:neuro|assistant)\s*[:：]\s*", " ", out)
    out = re.sub(r"^\s*\[\d+s ago,\s*\w+\]\s*", "", out, flags=re.M)
    out = re.sub(r"\bAt \d{1,2}:\d{2}(:\d{2})?,\s*", "", out)
    out = re.sub(r"(?m)^\s*-\s+", "", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return out.strip()


def speak_from_observation(cfg: dict, base_messages: list, observation,
                           user_prompt: Optional[str] = None,
                           max_tokens: int = 400) -> str:

    if isinstance(observation, (list, tuple)):
        obs_list = [o for o in observation if (o or "").strip()]
    elif (observation or "").strip():
        obs_list = [observation.strip()]
    else:
        obs_list = []
    if not obs_list:
        return ""
    latest = obs_list[-1]

    ctx_lines = [f"- {o.strip()}" for o in obs_list]
    ctx = ("\n[What you can see on user's screen right now — reported by your "
           "own eyes, NOT said by user. Newest observation last. Use only these "
           "facts; pick whatever genuinely interests you and never recite "
           "them verbatim.]\n"
           + "\n".join(ctx_lines) + "\n")

    msgs = build_vision_messages(base_messages, ctx, user_prompt)

    try:
        text = ab.llm_complete(cfg, msgs, max_tokens_override=max_tokens)
    except Exception:
        return ""

    text = _strip_meta_lines(text or "")
    text = ab.strip_cjk_for_speech(ab.strip_emotion_tags(text)).strip()
    if not text or re.fullmatch(r"[\s'\"`]*silent[\s.!?。'\"`]*", text, re.I):
        return ""
    low = text.lower()
    if "my brain isn't connecting" in low or "say that again" in low:
        return ""
    if _restates_observation(text, latest):
        return ""
    return text


def _restates_observation(line: str, observation: str) -> bool:

    stop = {"the", "a", "an", "is", "are", "was", "were", "with", "on", "in",
            "of", "to", "and", "that", "this", "it", "its", "at", "for", "as",
            "there", "showing", "displaying", "displays", "image", "screen",
            "window", "appears", "visible", "text", "his", "he", "you",
            "what", "so", "oh", "hey", "ooh", "mm", "well", "writing",
            "doing", "again", "there"}
    def words(s):
        return {w for w in re.findall(r"[a-z]{3,}", s.lower()) if w not in stop}
    a, b = words(line), words(observation)
    if len(a) < 3 or not b:
        return False
    return len(a & b) / len(a) >= 0.75


def observation_is_relevant(observation: str, user_text: str) -> bool:

    o = (observation or "").lower()
    u = (user_text or "").lower()
    if not o:
        return False

    if re.search(r"\b(screen|display|desktop|monitor|window|this|that|it)\b"
                 r"|屏幕|画面|桌面|窗口|这个|那个", u):
        return True

    if re.search(r"\b(opened|closed|appeared|error|crash|playing|started|"
                 r"changed|switched|notification|dialog|popup)\b"
                 r"|打开|关闭|出现|报错|崩溃|播放|切换|通知|弹窗", o):
        return True

    return False
