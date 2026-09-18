#!/usr/bin/env python3
"""
Freshell video demo: Moog synth built by Claude, played via browser-use.

Usage:
  . .venv/bin/activate
  python test/browser_use/demo_synth.py [--step N] [--cdp-url URL] [--debug]

Steps:
  1 - Create a Claude tab, prompt for Moog synth
  2 - Wait for Claude to finish building the project
  3 - Add Shell + Browser panes, start dev server, load synth, play Mr. Roboto
  4 - Ask Claude to create a git worktree

Outputs:
  /tmp/demo_timeline.json   Timestamped event log for video post-production.
                            Categories: llm_thinking (dead air / trim),
                            ui_wait (speed-up), ui_click/ui_input/ui_keypress
                            (keep at 1x), step_start/step_end (chapter marks).
  stdout                    Live [T+...s] timeline printed during the run.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
import traceback
import logging
from pathlib import Path

# Add the test/browser_use dir to path so we can import smoke_utils
sys.path.insert(0, str(Path(__file__).resolve().parent))

from smoke_utils import (
    JsonLogger,
    build_target_url,
    default_base_url,
    env_or,
    find_upwards,
    load_dotenv,
    monotonic_timer,
    redact_url,
    redact_text,
    require,
)


# Synth keyboard → note name mapping (for readable timeline output)
KEY_TO_NOTE = {
    "a": "C3",  "w": "C#3/D\u266d3", "s": "D3", "e": "D#3/E\u266d3",
    "d": "E3",  "f": "F3",  "t": "F#3/G\u266d3", "g": "G3",
    "y": "G#3/A\u266d3", "h": "A3", "u": "A#3/B\u266d3", "j": "B3",
    "k": "C4",  "o": "C#4/D\u266d4", "l": "D4", "p": "D#4/E\u266d4",
}

# ---------------------------------------------------------------------------
# Melody: "Domo Arigato, Mr. Roboto" — Key of B♭ minor
#
# Each entry: (key, eighths, gap_type)
#   key       — keyboard letter (None = rest)
#   eighths   — duration in eighth-note units
#   gap_type  — "r" retrigger (same pitch follows, needs short silence to re-attack)
#               "l" legato (different pitch follows, near-zero gap)
#               "n" none (rest, bar-end, or final note follows)
#
# Enharmonic mapping for B♭ minor on the synth keyboard:
#   C3=a  D♭3=w  E♭3=e  F3=f  G♭3=t  A♭3=y  B♭3=u
# ---------------------------------------------------------------------------
MELODY_NOTES: list[tuple[str | None, int, str]] = [
    # ---- Measure 1: F F F F E♭ F [8th rest] F(tied→m2) ----
    ("f", 1, "r"),  # F 8th
    ("f", 1, "r"),  # F 8th
    ("f", 1, "r"),  # F 8th
    ("f", 1, "r"),  # F 8th
    ("e", 1, "l"),  # E♭ 8th
    ("f", 1, "n"),  # F 8th (rest follows)
    (None, 1, "n"), # 8th rest
    ("f", 2, "l"),  # F tied across barline (pickup 8th + 8th in m2)

    # ---- Measure 2: →(F) E♭ | F F | C half ----
    ("e", 1, "l"),  # E♭ 8th
    ("f", 1, "r"),  # F 8th
    ("f", 1, "l"),  # F 8th
    ("a", 4, "n"),  # C half note

    # ---- Measure 3: C qtr  C qtr | D♭ E♭ F G♭ 8ths ----
    ("a", 2, "r"),  # C quarter
    ("a", 2, "l"),  # C quarter (legato into D♭)
    ("w", 1, "l"),  # D♭ 8th
    ("e", 1, "l"),  # E♭ 8th
    ("f", 1, "l"),  # F 8th
    ("t", 1, "r"),  # G♭ 8th (retrigger before m4 G♭)

    # ---- Measure 4: G♭ dotted half (3 beats) ----
    ("t", 6, "n"),  # G♭ dotted half
]


class Timeline:
    """Records timestamped events for video post-production.

    Every event has a T+ offset (seconds from script start), a wall-clock
    timestamp, a category, and a human description.  Categories tell the
    video editor what to do with each time range:

      step_start / step_end — demo step boundaries (chapter markers)
      llm_thinking          — dead air: agent is calling the LLM (trim / cut)
      llm_decided           — LLM returned, actions about to fire (transition)
      ui_click              — visible click on a UI element (keep 1×)
      ui_input              — text pasted into terminal (keep 1×)
      ui_keypress           — synth note played (keep 1×, maybe highlight)
      ui_wait               — agent explicitly waiting N seconds (speed-up)
      ui_sendkeys           — keyboard shortcut sent (keep 1×)
      action_done           — action result summary (keep 1×)
      transition            — gap between demo steps (trim)
      meta                  — script-level bookkeeping
    """

    def __init__(self):
        self._t0 = time.monotonic()
        self._wall0 = time.time()
        self.events: list[dict] = []

    def _offset(self) -> float:
        return time.monotonic() - self._t0

    def event(self, category: str, description: str, **extra) -> dict:
        t = self._offset()
        wall = time.strftime("%H:%M:%S", time.localtime(self._wall0 + t))
        ms = int((t % 1) * 1000)
        e = {
            "t": round(t, 2),
            "wall": f"{wall}.{ms:03d}",
            "cat": category,
            "desc": description,
            **{k: v for k, v in extra.items() if v is not None},
        }
        self.events.append(e)
        print(f"[T+{t:7.1f}s] {category:20s} | {description}", flush=True)
        return e

    def save(self, path: str):
        import json as _json

        total = round(self._offset(), 2)
        with open(path, "w") as f:
            _json.dump({"total_duration_s": total, "events": self.events}, f, indent=2)
        self.event("meta", f"Timeline written: {path} ({len(self.events)} events, {total}s)")


async def setup_browser(args, log, token, base_url):
    """Shared browser setup: launch, navigate to Freshell, wait for auth."""
    from browser_use import Browser

    target_url = build_target_url(base_url, token)
    redacted = redact_url(target_url)
    log.info("Setting up browser", event="browser_setup", targetUrl=redacted)

    browser = Browser(
        headless=args.headless,
        cdp_url=args.cdp_url,
        window_size={"width": args.width, "height": args.height},
        viewport={"width": args.width, "height": args.height},
        no_viewport=False,
    )
    await browser.start()

    # Reuse existing Freshell tab or open new one
    pages = []
    try:
        pages = await browser.get_pages()
    except Exception:
        pages = []

    page = None
    if pages:
        for p in reversed(pages):
            try:
                url = await p.get_url()
                title = await p.get_title()
                if (title and "freshell" in title.lower()) or (
                    url and url.startswith(base_url)
                ):
                    page = p
                    break
            except Exception:
                continue
        if page is None:
            page = pages[-1]
    else:
        page = await browser.new_page("about:blank")

    # Navigate to Freshell
    try:
        goto = getattr(page, "goto", None)
        if callable(goto):
            await goto(target_url)
        else:
            navigate = getattr(page, "navigate", None)
            if callable(navigate):
                await navigate(target_url)
            else:
                page = await browser.new_page(target_url)
    except Exception:
        page = await browser.new_page(target_url)

    # Wait for auth bootstrap
    deadline = time.monotonic() + 30.0
    ready = False
    while time.monotonic() < deadline:
        try:
            auth_present = await page.evaluate(
                "() => !!sessionStorage.getItem('auth-token')"
            )
            token_removed = await page.evaluate(
                "() => !new URLSearchParams(window.location.search).has('token')"
            )
            has_pane_root = await page.evaluate(
                "() => !!document.querySelector('[data-pane-root]')"
            )
            has_connected = await page.evaluate(
                "() => !!document.querySelector('[title=\"Connected\"]')"
            )
            if auth_present and token_removed and has_pane_root and has_connected:
                ready = True
                break
        except Exception:
            pass
        await asyncio.sleep(0.5)

    if not ready:
        raise RuntimeError("App did not bootstrap auth/render in time")

    log.info("Browser ready", event="browser_ready")
    return browser, page


def register_insert_text(tools, timeline: Timeline | None = None):
    """Register the CDP insert_text action for reliable terminal typing."""
    from browser_use.agent.views import ActionResult
    from pydantic import BaseModel

    class InsertTextAction(BaseModel):
        text: str

    @tools.registry.action(
        "Insert text into the currently focused element (CDP Input.insertText).",
        param_model=InsertTextAction,
    )
    async def insert_text(params: InsertTextAction, browser_session):
        try:
            preview = params.text[:80].replace("\n", "\\n")
            if timeline:
                timeline.event(
                    "ui_input",
                    f"Inserting text ({len(params.text)} chars): {preview}",
                    text_len=len(params.text),
                )
            cdp_session = await browser_session.get_or_create_cdp_session(
                target_id=None, focus=True
            )
            await cdp_session.cdp_client.send.Input.insertText(
                params={"text": params.text},
                session_id=cdp_session.session_id,
            )
            memory = f"Inserted text: {params.text}"
            return ActionResult(extracted_content=memory, long_term_memory=memory)
        except Exception as e:
            return ActionResult(
                error=f"Failed to insert text: {type(e).__name__}: {e}"
            )


def register_right_click(tools):
    """Register a CDP right-click action (dispatches a contextmenu MouseEvent)."""
    from browser_use.agent.views import ActionResult
    from pydantic import BaseModel

    class RightClickAction(BaseModel):
        index: int

    @tools.registry.action(
        "Right-click an element by index (dispatches a contextmenu MouseEvent).",
        param_model=RightClickAction,
    )
    async def right_click(params: RightClickAction, browser_session):
        try:
            element = await browser_session.get_element_by_index(params.index)
            if element is None:
                return ActionResult(error=f"Element index {params.index} not found")
            cdp_session = await browser_session.get_or_create_cdp_session(
                target_id=None, focus=True
            )
            sid = cdp_session.session_id
            resolved = await cdp_session.cdp_client.send.DOM.resolveNode(
                params={"backendNodeId": element.backend_node_id}, session_id=sid,
            )
            object_id = resolved["object"]["objectId"]
            await cdp_session.cdp_client.send.Runtime.callFunctionOn(
                params={
                    "objectId": object_id,
                    "functionDeclaration": "function() { const r = this.getBoundingClientRect(); this.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: r.left + Math.max(1, r.width / 2), clientY: r.top + Math.max(1, r.height / 2)})); }",
                    "returnByValue": True,
                },
                session_id=sid,
            )
            memory = f"Right-clicked element at index {params.index}"
            return ActionResult(extracted_content=memory, long_term_memory=memory)
        except Exception as e:
            return ActionResult(
                error=f"Failed to right-click: {type(e).__name__}: {e}"
            )


def register_dispatch_key(tools, timeline: Timeline | None = None):
    """Register a CDP-level key dispatch action for pressing keys inside iframes."""
    from browser_use.agent.views import ActionResult
    from pydantic import BaseModel

    class DispatchKeyAction(BaseModel):
        key: str
        hold_ms: int = 100
        pause_after_ms: int = 300

    @tools.registry.action(
        "Press and release a key via CDP Input.dispatchKeyEvent (works inside iframes). "
        "key: single character like 'd' or 's'. hold_ms: how long to hold the key down (default 100ms). "
        "pause_after_ms: how long to wait AFTER releasing the key before returning (default 300ms). "
        "This is a self-contained note action - do NOT combine with a separate wait action.",
        param_model=DispatchKeyAction,
    )
    async def dispatch_key(params: DispatchKeyAction, browser_session):
        try:
            key = params.key
            note = KEY_TO_NOTE.get(key, key)
            if timeline:
                timeline.event(
                    "ui_keypress",
                    f"♪ {note} (key='{key}', hold={params.hold_ms}ms, pause={params.pause_after_ms}ms)",
                    key=key,
                    note=note,
                    hold_ms=params.hold_ms,
                    pause_ms=params.pause_after_ms,
                )
            cdp_session = await browser_session.get_or_create_cdp_session(
                target_id=None, focus=True
            )
            key_code = ord(key.upper())
            code = f"Key{key.upper()}" if key.isalpha() else key

            # keyDown
            await cdp_session.cdp_client.send.Input.dispatchKeyEvent(
                params={
                    "type": "keyDown",
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": key_code,
                    "nativeVirtualKeyCode": key_code,
                    "text": key,
                },
                session_id=cdp_session.session_id,
            )
            await asyncio.sleep(params.hold_ms / 1000.0)
            # keyUp
            await cdp_session.cdp_client.send.Input.dispatchKeyEvent(
                params={
                    "type": "keyUp",
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": key_code,
                    "nativeVirtualKeyCode": key_code,
                },
                session_id=cdp_session.session_id,
            )
            if timeline:
                timeline.event(
                    "ui_keypress",
                    f"♪ {note} released (after {params.hold_ms}ms hold)",
                    key=key,
                    note=note,
                    phase="release",
                )
            # Built-in pause after the note
            await asyncio.sleep(params.pause_after_ms / 1000.0)
            memory = f"Played key '{key}' (held {params.hold_ms}ms, paused {params.pause_after_ms}ms)"
            return ActionResult(extracted_content=memory, long_term_memory=memory)
        except Exception as e:
            return ActionResult(
                error=f"Failed to dispatch key: {type(e).__name__}: {e}"
            )


def register_play_melody(tools, timeline: Timeline | None = None):
    """Register a single action that plays the full melody in real-time via CDP.

    This avoids LLM round-trips between notes — the entire sequence is fired
    from one async function with precise sleep-based timing.
    """
    from browser_use.agent.views import ActionResult
    from pydantic import BaseModel

    RETRIGGER_GAP_MS = 20  # silence between repeated same-pitch notes
    LEGATO_GAP_MS = 5      # near-zero gap for different-pitch transitions

    class PlayMelodyAction(BaseModel):
        bpm: int = 140

    @tools.registry.action(
        "Play the pre-programmed 'Domo Arigato Mr. Roboto' melody on the synth in real-time. "
        "bpm: tempo in beats per minute (default 140). "
        "Call this ONCE after clicking inside the synth iframe to focus it. "
        "The melody plays for ~6 seconds with precise timing — do NOT interrupt.",
        param_model=PlayMelodyAction,
    )
    async def play_melody(params: PlayMelodyAction, browser_session):
        try:
            cdp_session = await browser_session.get_or_create_cdp_session(
                target_id=None, focus=True
            )
            session_id = cdp_session.session_id
            send = cdp_session.cdp_client.send

            e8 = round(60_000 / params.bpm / 2)  # eighth-note duration in ms

            if timeline:
                timeline.event(
                    "ui_keypress",
                    f"♪ Melody START — Domo Arigato, Mr. Roboto "
                    f"({params.bpm} BPM, 8th={e8}ms, {len(MELODY_NOTES)} events)",
                )

            measure = 1
            eighth_count = 0

            for key, eighths, gap_type in MELODY_NOTES:
                dur = eighths * e8

                # Compute hold / gap from gap_type
                if gap_type == "r":
                    hold = dur - RETRIGGER_GAP_MS
                    gap = RETRIGGER_GAP_MS
                elif gap_type == "l":
                    hold = dur - LEGATO_GAP_MS
                    gap = LEGATO_GAP_MS
                else:
                    hold = dur
                    gap = 0

                # Track measure boundaries for timeline
                eighth_count += eighths
                if eighth_count > 8:
                    measure += 1
                    eighth_count = eighths

                if key is None:
                    # Rest
                    if timeline:
                        timeline.event(
                            "ui_keypress",
                            f"♪ REST ({dur}ms) [m{measure}]",
                            measure=measure,
                        )
                    await asyncio.sleep(dur / 1000.0)
                    continue

                note = KEY_TO_NOTE.get(key, key)
                key_code = ord(key.upper())
                code = f"Key{key.upper()}" if key.isalpha() else key

                if timeline:
                    beat_label = {1: "8th", 2: "qtr", 4: "half", 6: "dot-half"}.get(eighths, f"{eighths}/8")
                    timeline.event(
                        "ui_keypress",
                        f"♪ {note} ({beat_label}, {hold}ms hold) [m{measure}]",
                        key=key,
                        note=note,
                        hold_ms=hold,
                        gap_ms=gap,
                        measure=measure,
                    )

                # keyDown
                await send.Input.dispatchKeyEvent(
                    params={
                        "type": "keyDown",
                        "key": key,
                        "code": code,
                        "windowsVirtualKeyCode": key_code,
                        "nativeVirtualKeyCode": key_code,
                        "text": key,
                    },
                    session_id=session_id,
                )
                await asyncio.sleep(hold / 1000.0)

                # keyUp
                await send.Input.dispatchKeyEvent(
                    params={
                        "type": "keyUp",
                        "key": key,
                        "code": code,
                        "windowsVirtualKeyCode": key_code,
                        "nativeVirtualKeyCode": key_code,
                    },
                    session_id=session_id,
                )

                if gap > 0:
                    await asyncio.sleep(gap / 1000.0)

            if timeline:
                timeline.event("ui_keypress", "♪ Melody COMPLETE")

            return ActionResult(
                extracted_content="Melody played: Domo Arigato Mr. Roboto (4 measures, real-time)",
                long_term_memory="Melody played successfully",
            )
        except Exception as e:
            return ActionResult(
                error=f"Failed to play melody: {type(e).__name__}: {e}"
            )


async def run_agent_task(
    browser, task, args, log, max_steps=None,
    timeline: Timeline | None = None, step_label: str = "",
):
    """Run an LLM-driven browser-use agent with the given task."""
    from browser_use import Agent, ChatBrowserUse
    from browser_use.tools.service import Tools

    model = env_or(args.model, "BROWSER_USE_MODEL") or "bu-latest"
    llm = ChatBrowserUse(model=model)

    tools = Tools(
        exclude_actions=["write_file", "replace_file", "read_file", "extract"]
    )
    register_insert_text(tools, timeline=timeline)
    register_right_click(tools)
    register_dispatch_key(tools, timeline=timeline)
    register_play_melody(tools, timeline=timeline)

    # ---- Timeline hooks: take cues from the UI, not the LLM ----

    _step_t: dict[str, float] = {}  # track per-agent-step timing

    async def on_step_start(agent):
        """Fires at the top of each agent step — screenshot about to be taken,
        then sent to the LLM.  Nothing will change on screen until the LLM
        returns and actions execute, so this marks the START of dead air."""
        n = getattr(agent.state, "n_steps", "?")
        _step_t["think_start"] = time.monotonic()
        if timeline:
            timeline.event(
                "llm_thinking",
                f"[{step_label}] Agent step {n}: screen frozen while LLM thinks",
                agent_step=n,
            )

    async def on_step_end(agent):
        """Fires after actions execute — the screen just changed.  Log what
        the actions actually produced (the UI-visible result)."""
        n = getattr(agent.state, "n_steps", "?")
        results = getattr(agent.state, "last_result", None) or []
        descs = []
        for r in results:
            if r and r.extracted_content:
                descs.append(str(r.extracted_content)[:120])
            elif r and r.error:
                descs.append(f"ERROR: {r.error[:80]}")
        summary = "; ".join(descs) if descs else "no visible change"
        if timeline:
            timeline.event(
                "action_done",
                f"[{step_label}] Step {n} visible result: {summary}",
                agent_step=n,
            )

    def on_new_step(browser_state, agent_output, step_num):
        """Fires after LLM returns but BEFORE actions execute.  This is the
        boundary between dead air (LLM thinking) and live action (UI changing).
        Log the LLM think duration and describe what's about to happen."""
        if not timeline:
            return

        # How long was the screen frozen while the LLM thought?
        think_start = _step_t.get("think_start")
        think_s = round(time.monotonic() - think_start, 1) if think_start else None

        # Parse what actions are about to fire
        actions_desc = []
        try:
            raw = agent_output.action
            action_list = raw if isinstance(raw, list) else [raw]
            for a in action_list:
                if a is None:
                    continue
                d = a.model_dump(exclude_none=True, exclude_unset=True) if hasattr(a, "model_dump") else {}
                for k, v in d.items():
                    if isinstance(v, dict):
                        # Detect wait actions — useful for speed-ramping
                        if k == "wait":
                            secs = v.get("seconds", 0)
                            timeline.event(
                                "ui_wait",
                                f"[{step_label}] Explicit wait {secs}s — nothing changes on screen (speed-up candidate)",
                                wait_seconds=secs,
                            )
                        # Detect click actions
                        elif k in ("click_element", "click"):
                            idx = v.get("index", "?")
                            actions_desc.append(f"click(element #{idx})")
                        # Detect send_keys
                        elif k == "send_keys":
                            keys = v.get("keys", "?")
                            timeline.event("ui_sendkeys", f"[{step_label}] send_keys: {keys}", keys=keys)
                            actions_desc.append(f"send_keys({keys})")
                        else:
                            actions_desc.append(f"{k}({', '.join(f'{kk}={vv}' for kk, vv in v.items())})")
                    elif v is not None:
                        actions_desc.append(f"{k}={v}")
        except Exception:
            actions_desc = ["(could not parse actions)"]

        actions_str = "; ".join(actions_desc) or "(internal/done)"
        timeline.event(
            "llm_decided",
            f"[{step_label}] LLM responded after {think_s}s → {actions_str}",
            agent_step=step_num,
            llm_think_s=think_s,
        )

    agent = Agent(
        task=task.strip(),
        llm=llm,
        browser=browser,
        tools=tools,
        use_vision=True,
        max_actions_per_step=3,
        directly_open_url=False,
        register_new_step_callback=on_new_step,
    )

    steps = max_steps or args.max_steps
    log.info("Agent run start", event="agent_run_start", maxSteps=steps)
    if timeline:
        timeline.event("meta", f"[{step_label}] Agent starting (max {steps} steps)")
    history = await agent.run(
        max_steps=steps,
        on_step_start=on_step_start,
        on_step_end=on_step_end,
    )
    log.info("Agent run done", event="agent_run_done")
    if timeline:
        timeline.event("meta", f"[{step_label}] Agent finished")
    return history


# =============================================================================
# STEP 1: Create a Claude tab and ask for the synth
# =============================================================================
STEP1_TASK = """
You are controlling Freshell, a browser-based terminal multiplexer. The app is already open and authenticated.

Your task: Create a Claude Code tab and give it instructions to build a synthesizer.

Non-negotiable constraints:
- Stay in ONE browser window and ONE browser tab. Do not open new browser tabs/windows.
- Use insert_text for all terminal input, then send_keys with Enter.

Steps:
1) Look at the current tabs at the top. Click the "+" button (tooltip: "New shell tab") to create a new tab.
2) A pane picker will appear. Click "Claude" to create a Claude Code pane.
3) Wait for the Claude Code CLI to initialize (you should see the Claude prompt appear, with a ">" input area or a text like "Try..." prompt suggestion).
   - This may take 10-20 seconds. Use wait(seconds=10) if needed.
   - If it says "Starting terminal..." wait for it to finish.
4) Once Claude Code is ready, click inside the terminal to focus it, then use insert_text to type the following prompt EXACTLY (as one single insert_text call):

Build me a web-based synthesizer styled after a vintage Moog with extra walnut wood paneling. Use React with Vite and the Web Audio API. Include: a 2-octave piano keyboard (C3-B4) with clickable keys that play notes, analog-style knobs for cutoff frequency, resonance, attack, decay, sustain, release (ADSR), an oscillator type selector (saw, square, sine, triangle), a retro look with walnut wood texture cream/brown color scheme metal knobs, warm vintage font styling, mouse click AND keyboard input (use keys: a,w,s,e,d,f,t,g,y,h,u,j,k,o,l,p for the notes), each key should display its note name. Create this as a complete project in /tmp/moog-synth with all files ready to run via npm run dev. After writing all files run npm install and npm run build to verify it compiles.

5) After typing the prompt with insert_text, press Enter by using send_keys with the Enter key.
6) Wait about 5 seconds to confirm Claude has started processing.

When you see Claude actively working (generating code, showing "thinking", or outputting text), output exactly:
DEMO_STEP: DONE - Claude is generating the synth
"""


# =============================================================================
# STEP 2: Wait for Claude to finish
# =============================================================================
STEP2_TASK = """
You are monitoring Freshell where Claude Code is building a synthesizer project.

Your task: Wait for Claude Code to finish generating the project.

How to know Claude is done:
- The Claude Code CLI will return to its input prompt (showing ">" waiting for new input)
- You will see a summary of what it did or a message like "I've created the project"
- The terminal will stop scrolling with new output
- You might see cost information like "$X.XX spent"

Steps:
1) Watch the active Claude Code terminal pane. It should be generating code.
2) Wait patiently. Use wait(seconds=30) between screenshots. This WILL take several minutes.
3) Take a screenshot after each wait to check progress.
4) If you see Claude asking a YES/NO question or asking for permission, click the terminal and type 'y' then Enter.
5) Keep waiting and checking until Claude returns to its ">" prompt.
6) Once Claude is done (back at prompt), output:

DEMO_STEP: DONE - Claude finished generating code
"""


# =============================================================================
# STEP 3: Set up panes, start dev server, load synth, AND play Mr. Roboto
# =============================================================================
STEP3_TASK = """
You are controlling Freshell. Claude Code has finished building a Moog synthesizer in /tmp/moog-synth.

Your task has TWO PARTS:
PART A: Add a Shell pane, start the dev server, add a Browser pane, and load the synth.
PART B: Play "Domo Arigato, Mr. Roboto" intro on the synth.

Non-negotiable constraints:
- Stay in ONE browser window and ONE browser tab.
- Use insert_text for terminal input, then send_keys with Enter.

=== PART A: Set up the panes ===

1) Right-click the Claude Code terminal pane (use the right_click action) and click "Split horizontally" in the menu to add a new pane.
2) In the pane picker, click "Shell" (or "WSL" or "CMD" - whichever shell option is available).
3) Wait for the shell to be ready (you should see a command prompt).
4) Click inside the shell terminal to focus it, then:
   - insert_text("cd /tmp/moog-synth && npm run dev") then send_keys Enter
   - Wait 10 seconds for Vite to start
   - Look at the output for a URL like "http://localhost:5174" or similar port

5) Right-click the shell terminal pane (right_click action) and click "Split horizontally" again.
6) In the pane picker, click "Browser".
7) In the browser pane's URL input field:
   - Type the Vite URL you saw (e.g., http://localhost:5174) and press Enter
   - If you couldn't read the port, try http://localhost:5176 first
8) Wait 5 seconds for the synth to load. You should see "MOOG MINI SYNTHESIZER" and piano keys.

=== PART B: Play Mr. Roboto ===

9) Click INSIDE the browser pane's iframe area (where you see the synth keyboard) to focus it.
10) Wait 2 seconds for the iframe to be fully focused.
11) Call play_melody() — this plays the entire "Domo Arigato, Mr. Roboto" melody
    in real-time with precise timing (~6 seconds). Do NOT interrupt it.
    Just call: play_melody(bpm=140)

12) Output exactly:
DEMO_STEP: DONE - Synth loaded and Mr. Roboto played
"""


# =============================================================================
# STEP 4: Create a worktree
# =============================================================================
STEP4_TASK = """
You are controlling Freshell, a browser-based terminal multiplexer.

Your task: Create a Claude Code tab and ask it to set up a git worktree for the synth project.

Non-negotiable constraints:
- Stay in ONE browser window and ONE browser tab.
- Use insert_text for terminal input, then send_keys with Enter.

Steps:
1) Look at the Freshell tab bar at the top.
   - If you see a tab with a Claude Code pane (look for the ">" prompt), click it to switch.
   - If NOT, create a new tab: click the "+" button, then pick "Claude" from the pane picker.
   - Wait for Claude Code to initialize (you should see the ">" prompt).
2) Click inside the Claude Code terminal to focus it.
3) Use insert_text to type:

Initialize a git repo in /tmp/moog-synth, commit everything, then create a worktree at /tmp/moog-synth-effects for a feature/effects branch

4) Press Enter with send_keys.
5) If Claude asks a yes/no question or for permission, click the terminal, use insert_text("y"), then send_keys Enter.
6) Wait for Claude to finish. Use wait(seconds=15) and take screenshots to check progress.
   Claude is done when you see the ">" prompt again.
7) Output exactly:
DEMO_STEP: DONE - Worktree created
"""


async def run_step(step_num, browser, args, log, timeline: Timeline | None = None):
    """Run a single demo step."""
    tasks = {
        1: ("Create Claude tab + prompt", STEP1_TASK, 60),
        2: ("Wait for Claude to finish", STEP2_TASK, 300),
        3: ("Set up panes + load synth + play Mr. Roboto", STEP3_TASK, 200),
        4: ("Create worktree", STEP4_TASK, 120),
    }

    if step_num not in tasks:
        log.error(f"Unknown step: {step_num}", event="unknown_step")
        return 1

    name, task, max_steps = tasks[step_num]
    log.info(f"Starting step {step_num}: {name}", event="step_start", step=step_num)
    if timeline:
        timeline.event("step_start", f"{'='*20} STEP {step_num}: {name} {'='*20}", step=step_num)

    _, elapsed = monotonic_timer()
    history = await run_agent_task(
        browser, task, args, log, max_steps=max_steps,
        timeline=timeline, step_label=f"Step {step_num}",
    )
    dur = elapsed()
    log.info(
        f"Step {step_num} finished in {dur:.1f}s",
        event="step_done",
        step=step_num,
        elapsedS=round(dur, 2),
    )

    # Check result
    final_result_fn = getattr(history, "final_result", None)
    final = final_result_fn() if callable(final_result_fn) else None
    final_text = str(final or "").strip()
    log.info(
        f"Step {step_num} result: {final_text}", event="step_result", step=step_num
    )

    passed = "DONE" in final_text
    if timeline:
        status = "PASSED" if passed else "FAILED"
        timeline.event(
            "step_end",
            f"{'='*20} STEP {step_num} {status} ({dur:.1f}s) {'='*20}",
            step=step_num,
            duration_s=round(dur, 2),
            passed=passed,
        )

    return 0 if passed else 1


async def _run(args):
    repo_root = Path(__file__).resolve().parents[2]
    dotenv_path = find_upwards(repo_root, ".env")
    dotenv = load_dotenv(dotenv_path) if dotenv_path else {}

    log = JsonLogger(min_level=("debug" if args.debug else "info"))

    # Resolve config
    base_url = args.base_url or default_base_url(dotenv)
    token = env_or(args.token, "AUTH_TOKEN") or dotenv.get("AUTH_TOKEN")
    try:
        token = require("AUTH_TOKEN", token)
    except ValueError as e:
        log.error(str(e), event="missing_auth_token")
        return 2

    if args.require_api_key and not os.environ.get("BROWSER_USE_API_KEY"):
        log.error("Missing BROWSER_USE_API_KEY", event="missing_browser_use_api_key")
        return 2

    # Suppress noisy logging and redact tokens
    class _RedactTokenFilter(logging.Filter):
        def filter(self, record):
            try:
                msg = record.getMessage()
                redacted = redact_text(msg)
                record.msg = redacted
                record.args = ()
            except Exception:
                pass
            return True

    root_logger = logging.getLogger()
    root_logger.setLevel(logging.DEBUG if args.debug else logging.INFO)
    for h in root_logger.handlers:
        h.addFilter(_RedactTokenFilter())
    if not root_logger.handlers:
        handler = logging.StreamHandler(stream=sys.stdout)
        handler.addFilter(_RedactTokenFilter())
        handler.setLevel(logging.INFO)
        root_logger.addHandler(handler)

    log.info(
        "Demo config",
        event="demo_config",
        baseUrl=base_url,
        step=args.step,
        headless=args.headless,
        width=args.width,
        height=args.height,
    )

    # ---- Timeline for video post-production ----
    timeline = Timeline()
    timeline.event("meta", "Demo script starting", base_url=base_url)

    async def fresh_browser():
        """Create (or re-attach) a browser and navigate to Freshell."""
        return await setup_browser(args, log, token, base_url)

    browser, page = await fresh_browser()
    timeline.event("meta", "Browser ready, Freshell loaded and authenticated")

    try:
        if args.step:
            result = await run_step(args.step, browser, args, log, timeline=timeline)
            timeline.save(args.timeline_output)
            return result
        else:
            start = args.from_step or 1
            end = args.to_step or 4

            for step_num in range(start, end + 1):
                result = await run_step(step_num, browser, args, log, timeline=timeline)
                if result != 0:
                    log.error(
                        f"Step {step_num} failed",
                        event="step_failed",
                        step=step_num,
                    )
                    timeline.event("meta", f"Step {step_num} FAILED — aborting", step=step_num)
                    timeline.save(args.timeline_output)
                    return result
                log.info(
                    f"Step {step_num} passed, continuing...",
                    event="step_passed",
                    step=step_num,
                )

                # Between steps: re-attach browser (CDP keeps Chrome state alive)
                if step_num < end:
                    timeline.event(
                        "transition",
                        f"Gap between step {step_num} and {step_num + 1} — 3s pause, no UI changes (trim candidate)",
                    )
                    await asyncio.sleep(3)
                    timeline.event("transition", "Re-attaching browser session for next step")
                    browser, page = await fresh_browser()
                    timeline.event("transition", "Browser re-attached, ready for next step")

            timeline.event("meta", "All demo steps completed!")
            log.info("All demo steps completed!", event="demo_complete")
            timeline.save(args.timeline_output)
            return 0
    finally:
        stop = getattr(browser, "stop", None)
        if callable(stop):
            try:
                await stop()
            except Exception:
                pass


def main(argv):
    p = argparse.ArgumentParser(description="Freshell Moog synth demo via browser-use")
    p.add_argument("--step", type=int, default=None, help="Run only step N (1-5)")
    p.add_argument("--from-step", type=int, default=None, dest="from_step", help="Start from step N")
    p.add_argument("--to-step", type=int, default=None, dest="to_step", help="End at step N (inclusive)")
    p.add_argument(
        "--base-url",
        default=None,
        help="Freshell URL (default: http://localhost:$VITE_PORT)",
    )
    p.add_argument("--token", default=None, help="Auth token")
    p.add_argument("--model", default=None, help="Browser Use model")
    p.add_argument(
        "--cdp-url", default=None, help="Connect to existing Chrome via CDP"
    )
    p.add_argument("--headless", action="store_true", help="Run headless")
    p.add_argument("--width", type=int, default=1280, help="Browser width")
    p.add_argument(
        "--height", type=int, default=720, help="Browser height (720p for video)"
    )
    p.add_argument(
        "--max-steps", type=int, default=120, help="Default max agent steps per task"
    )
    p.add_argument("--debug", action="store_true", help="Debug logging")
    p.add_argument(
        "--timeline-output",
        default="/tmp/demo_timeline.json",
        help="Path for timeline JSON (default: /tmp/demo_timeline.json)",
    )
    p.add_argument(
        "--no-require-api-key",
        dest="require_api_key",
        action="store_false",
        help="Skip BROWSER_USE_API_KEY check",
    )
    p.set_defaults(require_api_key=True)
    args = p.parse_args(argv)

    try:
        return asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
    except Exception:
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
